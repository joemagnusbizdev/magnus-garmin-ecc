// --------------------------------------------
//  MAGNUS GARMIN ECC BACKEND (Node + SQLite)
// --------------------------------------------
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const Database = require("better-sqlite3");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

// --------------------------------------------
// CONFIG
// --------------------------------------------
const PORT = process.env.PORT || 4000;
const GARMIN_OUTBOUND_TOKEN = process.env.GARMIN_OUTBOUND_TOKEN || "";

const INBOUND_USERNAME = process.env.INBOUND_USERNAME || "";
const INBOUND_PASSWORD = process.env.INBOUND_PASSWORD || "";
const INBOUND_BASE_URL =
  process.env.INBOUND_BASE_URL ||
  "https://eur-enterprise.inreach.garmin.com/IPCInbound/Inbound.svc";

// --------------------------------------------
// EXPRESS APP
// --------------------------------------------
const app = express();

// CORS – allow your WordPress frontend
app.use(
  cors({
    origin: "https://blog.magnusafety.com",
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));

// --------------------------------------------
// SQLITE DB
// --------------------------------------------
const db = new Database("garmin.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  imei TEXT PRIMARY KEY,
  label TEXT,
  is_active_sos INTEGER DEFAULT 0,
  last_event_at TEXT,
  last_position_at TEXT,
  last_message_at TEXT,
  last_sos_event_at TEXT,
  last_sos_ack_at TEXT,
  tracking_enabled INTEGER DEFAULT 0,
  tracking_interval INTEGER,
  status_last_json TEXT,
  status TEXT DEFAULT 'open',
  closedAt TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imei TEXT NOT NULL,
  lat REAL,
  lon REAL,
  altitude REAL,
  gps_fix INTEGER,
  timestamp TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imei TEXT NOT NULL,
  direction TEXT NOT NULL,
  text TEXT,
  timestamp TEXT,
  is_sos INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sos_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imei TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT
);
`);

// --------------------------------------------
// UTILS
// --------------------------------------------
function logEvent(type, payload) {
  const entry = {
    ts: new Date().toISOString(),
    type,
    ...(payload || {}),
  };
  console.log("[ECC]", JSON.stringify(entry));
}

function upsertDeviceBase(imei, ts) {
  db.prepare(
    `
    INSERT INTO devices (imei, last_event_at)
    VALUES (?, ?)
    ON CONFLICT(imei) DO UPDATE SET last_event_at = excluded.last_event_at
  `
  ).run(imei, ts);
}

function getLastPositionRow(imei) {
  return db
    .prepare(
      `
      SELECT lat, lon, altitude, gps_fix, timestamp
      FROM positions
      WHERE imei = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `
    )
    .get(imei);
}

// --------------------------------------------
// HEALTH
// --------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// --------------------------------------------
// GARMIN OUTBOUND WEBHOOK
// --------------------------------------------
app.post("/garmin/ipc-outbound", (req, res) => {
  console.log(
    "INCOMING /garmin/ipc-outbound HEADERS:",
    JSON.stringify(req.headers, null, 2)
  );
  console.log(
    "INCOMING /garmin/ipc-outbound BODY:",
    JSON.stringify(req.body, null, 2)
  );

  // TEMP: token check disabled until we confirm header name/value from Garmin
  // const incomingToken =
  //   req.header("x-garmin-token") ||
  //   req.header("x-garmin_token") ||
  //   req.header("x-ipc-token");
  //
  // if (!incomingToken || incomingToken !== GARMIN_OUTBOUND_TOKEN) {
  //   console.warn(
  //     "[GarminOutbound] Invalid token:",
  //     incomingToken,
  //     "expected:",
  //     GARMIN_OUTBOUND_TOKEN
  //   );
  //   return res.status(401).json({ error: "invalid token" });
  // }

  const body = req.body;
  if (!body || !Array.isArray(body.Events)) {
    console.warn("[GarminOutbound] Invalid payload:", body);
    return res.status(400).json({ error: "invalid payload" });
  }

  let handled = 0;

  for (const ev of body.Events) {
    try {
      const imei = ev.imei;
      const ts = new Date().toISOString();

      upsertDeviceBase(imei, ts);

      // Position
      if (ev.point) {
        db.prepare(
          `
          INSERT INTO positions (imei, lat, lon, altitude, gps_fix, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `
        ).run(
          imei,
          ev.point.latitude,
          ev.point.longitude,
          ev.point.altitude,
          ev.point.gpsFix ? 1 : 0,
          ts
        );

        db.prepare(
          `
          UPDATE devices
          SET last_position_at = ?
          WHERE imei = ?
        `
        ).run(ts, imei);
      }

      // Message text (if present)
      if (ev.messageText || ev.moText || ev.freeText) {
        const text = ev.messageText || ev.moText || ev.freeText || "";
        const isSosMsg =
          ev.messageCode === 300 ||
          ev.messageCode === 301 ||
          !!ev.isEmsMessage;

        db.prepare(
          `
          INSERT INTO messages (imei, direction, text, timestamp, is_sos)
          VALUES (?, 'inbound', ?, ?, ?)
        `
        ).run(imei, text, ts, isSosMsg ? 1 : 0);

        db.prepare(
          `
          UPDATE devices
          SET last_message_at = ?
          WHERE imei = ?
        `
        ).run(ts, imei);
      }

      // SOS events
      if (ev.messageCode === 300 || ev.messageCode === 301) {
        const type = ev.messageCode === 300 ? "sos_declare" : "sos_clear";

        db.prepare(
          `
          INSERT INTO sos_events (imei, type, timestamp)
          VALUES (?, ?, ?)
        `
        ).run(imei, type, ts);

        db.prepare(
          `
          UPDATE devices
          SET is_active_sos = ?, last_sos_event_at = ?
          WHERE imei = ?
        `
        ).run(type === "sos_declare" ? 1 : 0, ts, imei);
      }

      handled++;
    } catch (err) {
      console.error("Error handling outbound event:", err);
    }
  }

  logEvent("garmin_outbound", { events: handled });
  res.json({ status: "ok", eventsHandled: handled });
});
// --------------------------------------------
// INBOUND TO GARMIN (Send message / SOS ACK / Request location)
// --------------------------------------------
async function garminInbound(method, payload) {
  const url = `${INBOUND_BASE_URL}/${method}`;
  const auth = {
    username: INBOUND_USERNAME,
    password: INBOUND_PASSWORD,
  };
  return axios.post(url, payload, { auth });
}

// Send message to device
app.post("/api/garmin/devices/:imei/message", async (req, res) => {
  const imei = req.params.imei;
  const text = (req.body && req.body.text) || "";

  if (!text.trim()) {
    return res.status(400).json({ error: "empty text" });
  }

  try {
    const payload = {
      Recipient: { Imei: imei },
      Message: { Text: text },
    };

    await garminInbound("SendMessage", payload);

    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO messages (imei, direction, text, timestamp, is_sos)
      VALUES (?, 'outbound', ?, ?, 0)
    `
    ).run(imei, text, now);

    db.prepare(
      `
      UPDATE devices
      SET last_message_at = ?
      WHERE imei = ?
    `
    ).run(now, imei);

    res.json({ ok: true });
  } catch (err) {
    console.error("SendMessage error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "failed to send message" });
  }
});

// Acknowledge SOS
app.post("/api/garmin/devices/:imei/ack-sos", async (req, res) => {
  const imei = req.params.imei;

  try {
    await garminInbound("AcknowledgeEms", {
      Recipient: { Imei: imei },
    });

    const now = new Date().toISOString();

    db.prepare(
      `
      UPDATE devices
      SET last_sos_ack_at = ?, is_active_sos = 0
      WHERE imei = ?
    `
    ).run(now, imei);

    db.prepare(
      `
      INSERT INTO sos_events (imei, type, timestamp)
      VALUES (?, 'sos_ack', ?)
    `
    ).run(imei, now);

    res.json({ ok: true });
  } catch (err) {
    console.error("AcknowledgeEms error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "failed to ack sos" });
  }
});

// Request location
app.post("/api/garmin/devices/:imei/locate", async (req, res) => {
  const imei = req.params.imei;

  try {
    await garminInbound("SendLocate", {
      Recipient: { Imei: imei },
    });

    const now = new Date().toISOString();

    db.prepare(
      `
      INSERT INTO sos_events (imei, type, timestamp)
      VALUES (?, 'locate_request', ?)
    `
    ).run(imei, now);

    res.json({ ok: true });
  } catch (err) {
    console.error("SendLocate error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "failed to request location" });
  }
});

// --------------------------------------------
// DEVICE LIST + GLOBAL MAP
// --------------------------------------------

// List devices with last known position & SOS status
app.get("/api/garmin/devices", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM devices").all();

    const result = rows.map((d) => {
      const lastPos = getLastPositionRow(d.imei);

      return {
        imei: d.imei,
        label: d.label,
        isActiveSos: !!d.is_active_sos,
        lastEventAt: d.last_event_at,
        lastPositionAt: d.last_position_at,
        lastMessageAt: d.last_message_at,
        lastSosEventAt: d.last_sos_event_at,
        lastSosAckAt: d.last_sos_ack_at,
        status: d.status || "open",
        closedAt: d.closedAt || null,
        lastPosition: lastPos
          ? {
              lat: lastPos.lat,
              lon: lastPos.lon,
              altitude: lastPos.altitude,
              gpsFix: !!lastPos.gps_fix,
              timestamp: lastPos.timestamp,
            }
          : null,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("Error in GET /api/garmin/devices:", err);
    res.status(500).json({ error: "failed to list devices" });
  }
});
// Messages list for a device (for center chat panel)
app.get("/api/garmin/devices/:imei/messages", (req, res) => {
  const imei = req.params.imei;
  const limitRaw = req.query.limit;
  let limit = parseInt(limitRaw, 10);

  if (isNaN(limit) || limit <= 0 || limit > 500) {
    limit = 50; // sane default
  }

  // Make sure device exists (optional but nicer)
  const exists = db
    .prepare("SELECT imei FROM devices WHERE imei = ?")
    .get(imei);

  if (!exists) {
    return res.status(404).json({ error: "device not found" });
  }

  const rows = db
    .prepare(
      `
      SELECT direction, text, timestamp, is_sos
      FROM messages
      WHERE imei = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
    )
    .all(imei, limit);

  res.json(rows);
});
// --------------------------------------------
// SOS STATE: SIMPLE, NEVER 404
// --------------------------------------------
app.get("/api/garmin/devices/:imei/sos/state", (req, res) => {
  const imei = req.params.imei;

  // Try get the device row
  const row = db
    .prepare(
      `
      SELECT imei, is_active_sos, last_sos_event_at, last_sos_ack_at
      FROM devices
      WHERE imei = ?
    `
    )
    .get(imei);

  // If device not found, just return a neutral state
  if (!row) {
    return res.json({
      imei,
      isActiveSos: false,
      lastSosEventAt: null,
      lastSosAckAt: null,
    });
  }

  // Normal case: device exists
  res.json({
    imei: row.imei,
    isActiveSos: !!row.is_active_sos,
    lastSosEventAt: row.last_sos_event_at || null,
    lastSosAckAt: row.last_sos_ack_at || null,
  });
});




// Global map endpoint: last positions of all devices
app.get("/api/garmin/map/devices", (req, res) => {
  try {
    const devices = db.prepare("SELECT * FROM devices").all();

    const positions = devices
      .map((d) => {
        const lastPos = getLastPositionRow(d.imei);
        if (!lastPos) return null;

        return {
          imei: d.imei,
          label: d.label,
          isActiveSos: !!d.is_active_sos,
          status: d.status || "open",
          lat: lastPos.lat,
          lon: lastPos.lon,
          altitude: lastPos.altitude,
          gpsFix: !!lastPos.gps_fix,
          timestamp: lastPos.timestamp,
        };
      })
      .filter(Boolean);

    res.json(positions);
  } catch (err) {
    console.error("Error in GET /api/garmin/map/devices:", err);
    res.status(500).json({ error: "failed to load map devices" });
  }
});

// --------------------------------------------
// DEVICE DETAILS + MESSAGES + POSITIONS + SOS TIMELINE
// --------------------------------------------

// Detail for one device
app.get("/api/garmin/devices/:imei", (req, res) => {
  const imei = req.params.imei;

  try {
    const device = db
      .prepare("SELECT * FROM devices WHERE imei = ?")
      .get(imei);

    if (!device) {
      return res.status(404).json({ error: "not found" });
    }

    const messages = db
      .prepare(
        `
        SELECT direction, text, timestamp, is_sos
        FROM messages
        WHERE imei = ?
        ORDER BY timestamp ASC
      `
      )
      .all(imei);

    const positions = db
      .prepare(
        `
        SELECT lat, lon, altitude, gps_fix, timestamp
        FROM positions
        WHERE imei = ?
        ORDER BY timestamp ASC
      `
      )
      .all(imei);

    const sosEvents = db
      .prepare(
        `
        SELECT type, timestamp
        FROM sos_events
        WHERE imei = ?
        ORDER BY timestamp ASC
      `
      )
      .all(imei);

    res.json({
      device,
      messages,
      positions,
      sosEvents,
    });
  } catch (err) {
    console.error("Error in GET /api/garmin/devices/:imei:", err);
    res.status(500).json({ error: "failed to load device detail" });
  }
});

// Optional: positions-only endpoint (if ever used)
app.get("/api/garmin/devices/:imei/positions", (req, res) => {
  const imei = req.params.imei;
  try {
    const positions = db
      .prepare(
        `
        SELECT lat, lon, altitude, gps_fix, timestamp
        FROM positions
        WHERE imei = ?
        ORDER BY timestamp ASC
      `
      )
      .all(imei);

    res.json(positions);
  } catch (err) {
    console.error("Error in GET /api/garmin/devices/:imei/positions:", err);
    res.status(500).json({ error: "failed to load positions" });
  }
});

// --------------------------------------------
// START SERVER
// --------------------------------------------
app.listen(PORT, () => {
  console.log(`MAGNUS Garmin ECC backend running on port ${PORT}`);
});
