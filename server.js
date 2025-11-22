// -------------------------------------------------------------
// MAGNUS GARMIN ECC BACKEND (Node + SQLite)
// -------------------------------------------------------------
console.log("BOOTING MAGNUS ECC BACKEND…");

require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const Database = require("better-sqlite3");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

// -------------------------------------------------------------
// ERROR CATCHERS — DO NOT REMOVE
// -------------------------------------------------------------
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

// -------------------------------------------------------------
// CONFIG
// -------------------------------------------------------------
const PORT = process.env.PORT || 4000;
const GARMIN_OUTBOUND_TOKEN = process.env.GARMIN_OUTBOUND_TOKEN || "";

const INBOUND_USERNAME = process.env.INBOUND_USERNAME || "";
const INBOUND_PASSWORD = process.env.INBOUND_PASSWORD || "";
const INBOUND_BASE_URL =
  process.env.INBOUND_BASE_URL ||
  "https://eur-enterprise.inreach.garmin.com/IPCInbound/Inbound.svc";

// -------------------------------------------------------------
// EXPRESS
// -------------------------------------------------------------
const app = express();

app.use(
  cors({
    origin: "https://blog.magnusafety.com",
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));

// -------------------------------------------------------------
// DATABASE
// -------------------------------------------------------------
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

// -------------------------------------------------------------
// UTILS
// -------------------------------------------------------------
function logEvent(type, payload) {
  console.log("[ECC]", JSON.stringify({ ts: new Date().toISOString(), type, ...payload }));
}

function upsertDeviceBase(imei, ts) {
  db.prepare(`
    INSERT INTO devices (imei, last_event_at)
    VALUES (?, ?)
    ON CONFLICT(imei) DO UPDATE SET last_event_at = excluded.last_event_at
  `).run(imei, ts);
}

// -------------------------------------------------------------
// HEALTH CHECK
// -------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// -------------------------------------------------------------
// GARMIN OUTBOUND WEBHOOK
// -------------------------------------------------------------
app.post("/garmin/ipc-outbound", (req, res) => {
  console.log("OUTBOUND HEADERS:", req.headers);
  console.log("OUTBOUND BODY:", JSON.stringify(req.body, null, 2));

  const events = req.body?.Events || [];
  if (!Array.isArray(events)) {
    return res.json({ status: "ok", eventsHandled: 0 });
  }

  let handled = 0;
  const ts = new Date().toISOString();

  events.forEach((ev) => {
    const imei = ev.imei;
    if (!imei) return;

    upsertDeviceBase(imei, ts);

    // position
    if (ev.point) {
      db.prepare(`
        INSERT INTO positions (imei, lat, lon, altitude, gps_fix, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        imei,
        ev.point.latitude,
        ev.point.longitude,
        ev.point.altitude,
        ev.point.gpsFix ? 1 : 0,
        ts
      );

      db.prepare(`UPDATE devices SET last_position_at=? WHERE imei=?`).run(ts, imei);
    }

    // messages
    const txt = ev.messageText || ev.moText || ev.freeText || "";
    if (txt) {
      db.prepare(`
        INSERT INTO messages (imei, direction, text, timestamp, is_sos)
        VALUES (?, 'inbound', ?, ?, ?)
      `).run(
        imei,
        txt,
        ts,
        ev.messageCode === 300 || ev.messageCode === 301 ? 1 : 0
      );

      db.prepare(`UPDATE devices SET last_message_at=? WHERE imei=?`).run(ts, imei);
    }

    // SOS
    if (ev.messageCode === 300 || ev.messageCode === 301) {
      const type = ev.messageCode === 300 ? "sos_declare" : "sos_clear";
      db.prepare(`
        INSERT INTO sos_events (imei, type, timestamp)
        VALUES (?, ?, ?)
      `).run(imei, type, ts);

      db.prepare(`
        UPDATE devices SET is_active_sos=?, last_sos_event_at=? WHERE imei=?
      `).run(type === "sos_declare" ? 1 : 0, ts, imei);
    }

    handled++;
  });

  logEvent("garmin_outbound", { events: handled });
  res.json({ status: "ok", eventsHandled: handled });
});

// -------------------------------------------------------------
// GARMIN INBOUND HELPERS
// -------------------------------------------------------------
async function callInbound(method, payload) {
  return axios.post(`${INBOUND_BASE_URL}/${method}`, payload, {
    auth: { username: INBOUND_USERNAME, password: INBOUND_PASSWORD },
  });
}
// -------------------------------------------------------------
// API: OUTBOUND TO DEVICES (MESSAGE / SOS ACK / LOCATE)
// -------------------------------------------------------------

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

    await callInbound("SendMessage", payload);

    db.prepare(
      "INSERT INTO messages (imei, direction, text, timestamp, is_sos) VALUES (?, 'outbound', ?, ?, 0)"
    ).run(imei, text, new Date().toISOString());

    db.prepare("UPDATE devices SET last_message_at=? WHERE imei=?").run(
      new Date().toISOString(),
      imei
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("SendMessage error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "failed to send message" });
  }
});

// Acknowledge SOS
app.post("/api/garmin/devices/:imei/ack-sos", async (req, res) => {
  const imei = req.params.imei;

  try:
    await callInbound("AcknowledgeEms", { Recipient: { Imei: imei } });

    const now = new Date().toISOString();

    db.prepare(
      "UPDATE devices SET last_sos_ack_at=?, is_active_sos=0 WHERE imei=?"
    ).run(now, imei);

    db.prepare(
      "INSERT INTO sos_events (imei, type, timestamp) VALUES (?, 'sos_ack', ?)"
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
    await callInbound("SendLocate", { Recipient: { Imei: imei } });

    db.prepare(
      "INSERT INTO sos_events (imei, type, timestamp) VALUES (?, 'locate_request', ?)"
    ).run(imei, new Date().toISOString());

    res.json({ ok: true });
  } catch (err) {
    console.error("SendLocate error:", err.response?.data || err.message || err);
    res.status(500).json({ error: "failed to request location" });
  }
});

// -------------------------------------------------------------
// API: LIST DEVICES (for sidebar + markers)
// -------------------------------------------------------------
app.get("/api/garmin/devices", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM devices").all();

    const result = rows.map((d) => {
      const lastPos = db
        .prepare(
          "SELECT lat, lon, altitude, gps_fix, timestamp FROM positions WHERE imei=? ORDER BY timestamp DESC LIMIT 1"
        )
        .get(d.imei);

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
    console.error("GET /api/garmin/devices error:", err);
    res.status(500).json({ error: "failed to list devices" });
  }
});

// -------------------------------------------------------------
// API: DEVICE DETAIL (device + messages + positions + sos_events)
// -------------------------------------------------------------
app.get("/api/garmin/devices/:imei", (req, res) => {
  const imei = req.params.imei;

  try {
    const device = db
      .prepare("SELECT * FROM devices WHERE imei=?")
      .get(imei);

    if (!device) {
      return res.status(404).json({ error: "not found" });
    }

    const messages = db
      .prepare(
        "SELECT direction, text, timestamp, is_sos FROM messages WHERE imei=? ORDER BY timestamp ASC"
      )
      .all(imei);

    const positions = db
      .prepare(
        "SELECT lat, lon, altitude, gps_fix, timestamp FROM positions WHERE imei=? ORDER BY timestamp ASC"
      )
      .all(imei);

    const sosEvents = db
      .prepare(
        "SELECT type, timestamp FROM sos_events WHERE imei=? ORDER BY timestamp ASC"
      )
      .all(imei);

    res.json({
      device: {
        ...device,
        isActiveSos: !!device.is_active_sos,
      },
      messages,
      positions,
      sosEvents,
    });
  } catch (err) {
    console.error("GET /api/garmin/devices/:imei error:", err);
    res.status(500).json({ error: "failed to get device" });
  }
});

// -------------------------------------------------------------
// OPTIONAL: MESSAGES ENDPOINT (for older frontend versions)
// GET /api/garmin/devices/:imei/messages?limit=50
// -------------------------------------------------------------
app.get("/api/garmin/devices/:imei/messages", (req, res) => {
  const imei = req.params.imei;
  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit) || limit <= 0 || limit > 500) {
    limit = 100;
  }

  try {
    const messages = db
      .prepare(
        "SELECT direction, text, timestamp, is_sos FROM messages WHERE imei=? ORDER BY timestamp DESC LIMIT ?"
      )
      .all(imei, limit);

    // reverse so oldest first
    res.json(messages.reverse());
  } catch (err) {
    console.error("GET /messages error:", err);
    res.status(500).json({ error: "failed to get messages" });
  }
});

// -------------------------------------------------------------
// OPTIONAL: POSITIONS ENDPOINT (for track view)
// GET /api/garmin/devices/:imei/positions
// -------------------------------------------------------------
app.get("/api/garmin/devices/:imei/positions", (req, res) => {
  const imei = req.params.imei;

  try {
    const positions = db
      .prepare(
        "SELECT lat, lon, altitude, gps_fix, timestamp FROM positions WHERE imei=? ORDER BY timestamp ASC"
      )
      .all(imei);

    res.json(positions);
  } catch (err) {
    console.error("GET /positions error:", err);
    res.status(500).json({ error: "failed to get positions" });
  }
});

// -------------------------------------------------------------
// OPTIONAL: SOS STATE ENDPOINT
// GET /api/garmin/devices/:imei/sos/state
// -------------------------------------------------------------
app.get("/api/garmin/devices/:imei/sos/state", (req, res) => {
  const imei = req.params.imei;

  try {
    const d = db
      .prepare("SELECT is_active_sos, last_sos_event_at, last_sos_ack_at FROM devices WHERE imei=?")
      .get(imei);

    if (!d) {
      return res.status(404).json({ error: "not found" });
    }

    res.json({
      imei,
      isActiveSos: !!d.is_active_sos,
      lastSosEventAt: d.last_sos_event_at,
      lastSosAckAt: d.last_sos_ack_at,
    });
  } catch (err) {
    console.error("GET /sos/state error:", err);
    res.status(500).json({ error: "failed to get sos state" });
  }
});

// -------------------------------------------------------------
// START SERVER
// -------------------------------------------------------------
app.listen(PORT, () => {
  console.log("MAGNUS Garmin ECC backend running on port " + PORT);
});
