// --------------------------------------------
//  MAGNUS GARMIN ECC BACKEND (Node + SQLite)
// --------------------------------------------

require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const Database = require("better-sqlite3");
const path = require("path");
const axios = require("axios");

// --------------------------------------------
// CONFIG
// --------------------------------------------
const PORT = process.env.PORT || 4000;
const GARMIN_OUTBOUND_TOKEN = process.env.GARMIN_OUTBOUND_TOKEN || "";

const INBOUND_USERNAME = process.env.INBOUND_USERNAME || "";
const INBOUND_PASSWORD = process.env.INBOUND_PASSWORD || "";
const INBOUND_BASE_URL =
  process.env.INBOUND_BASE_URL ||
  "https://int-external-production.inreach.garmin.com/IPCInbound/Inbound.svc";

const ECC_USERS_RAW = process.env.ECC_USERS || "";
const ECC_USERS = ECC_USERS_RAW.split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [username, password, role] = entry.split(":");
    return {
      username: username || "",
      password: password || "",
      role: (role || "ops").toLowerCase(),
    };
  });

console.log("Loaded GARMIN_OUTBOUND_TOKEN =", GARMIN_OUTBOUND_TOKEN);

// --------------------------------------------
// ECC BASIC AUTH
// --------------------------------------------
function findUser(username, password) {
  return ECC_USERS.find(
    (u) => u.username === username && u.password === password
  );
}

function eccAuth(req, res, next) {
  // Allow health + Garmin webhook without ECC auth
  if (req.path === "/health" || req.path.startsWith("/garmin/ipc-outbound")) {
    return next();
  }

  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="MAGNUS ECC"');
    return res.status(401).send("Authentication required");
  }

  const base64 = header.slice("Basic ".length);
  let username = "";
  let password = "";

  try {
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    [username, password] = decoded.split(":");
  } catch (err) {
    return res.status(400).send("Invalid auth encoding");
  }

  const user = findUser(username, password);
  if (!user) return res.status(403).send("Forbidden");

  req.eccUser = { username: user.username, role: user.role };
  return next();
}

function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return function (req, res, next) {
    if (!req.eccUser) return res.status(401).send("Unauthenticated");
    if (!allowed.includes(req.eccUser.role))
      return res.status(403).send("Forbidden");
    next();
  };
}

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
function logEvent(type, payload = {}) {
  const entry = {
    ts: new Date().toISOString(),
    type,
    ...payload,
  };
  console.log("[ECC]", JSON.stringify(entry));
}

// --------------------------------------------
// EXPRESS APP
// --------------------------------------------
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));
app.use(eccAuth);

// --------------------------------------------
// STATIC CONSOLE UI
// --------------------------------------------
app.use(
  "/console",
  express.static(path.join(__dirname, "public"), { index: "index.html" })
);

app.get("/console", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// LOGOUT
app.get("/logout", (req, res) => {
  res.set("WWW-Authenticate", 'Basic realm="MAGNUS ECC"');
  res.status(401).send("Logged out");
});

// --------------------------------------------
// HEALTH
// --------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// --------------------------------------------
// GARMIN OUTBOUND WEBHOOK (Garmin → ECC)
// --------------------------------------------
app.post("/garmin/ipc-outbound", (req, res) => {
  const incomingToken = req.header("x-garmin-token");

  console.log(">>> Garmin outbound hit. x-garmin-token =", incomingToken);
  console.log(">>> Server expects GARMIN_OUTBOUND_TOKEN =", GARMIN_OUTBOUND_TOKEN);
  console.log(">>> All headers from Garmin:", req.headers);

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

      // Upsert device
      db.prepare(
        `INSERT INTO devices (imei, last_event_at)
         VALUES (?, ?)
         ON CONFLICT(imei) DO UPDATE SET last_event_at=excluded.last_event_at`
      ).run(imei, ts);

      // Position event
      if (ev.point) {
        db.prepare(
          `INSERT INTO positions (imei, lat, lon, altitude, gps_fix, timestamp)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          imei,
          ev.point.latitude,
          ev.point.longitude,
          ev.point.altitude,
          ev.point.gpsFix ? 1 : 0,
          ts
        );

        db.prepare(
          `UPDATE devices
           SET last_position_at = ?
           WHERE imei = ?`
        ).run(ts, imei);
      }

      // SOS events
      if (ev.messageCode === 300 || ev.messageCode === 301) {
        db.prepare(
          `INSERT INTO sos_events (imei, type, timestamp)
           VALUES (?, ?, ?)`
        ).run(imei, ev.messageCode === 300 ? "sos_declare" : "sos_clear", ts);

        db.prepare(
          `UPDATE devices
           SET is_active_sos = ?, last_sos_event_at = ?
           WHERE imei = ?`
        ).run(ev.messageCode === 300 ? 1 : 0, ts, imei);
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
// INBOUND TO GARMIN (ECC → Garmin)
// --------------------------------------------
async function garminInbound(method, payload) {
  const url = `${INBOUND_BASE_URL}/${method}`;
  const auth = {
    username: INBOUND_USERNAME,
    password: INBOUND_PASSWORD,
  };
  return axios.post(url, payload, { auth });
}

// SEND NORMAL MESSAGE
app.post("/api/garmin/devices/:imei/message", async (req, res) => {
  const imei = req.params.imei;
  const text = (req.body.text || "").trim();

  if (!text) {
    return res.status(400).json({ error: "empty message" });
  }

  try {
    const payload = {
      Recipient: { Imei: imei },
      Message: { Text: text },
    };

    await garminInbound("SendMessage", payload);

    db.prepare(
      `INSERT INTO messages (imei, direction, text, timestamp, is_sos)
       VALUES (?, 'outbound', ?, ?, 0)`
    ).run(imei, text, new Date().toISOString());

    db.prepare(
      `UPDATE devices SET last_message_at=? WHERE imei=?`
    ).run(new Date().toISOString(), imei);

    res.json({ ok: true });
  } catch (err) {
    console.error("SendMessage error:", err.response?.data || err);
    res.status(500).json({ error: "failed to send message" });
  }
});

// SEND SOS MESSAGE
app.post("/api/garmin/devices/:imei/sos/message", async (req, res) => {
  const imei = req.params.imei;
  const text = (req.body.text || "").trim();

  if (!text) {
    return res.status(400).json({ error: "empty message" });
  }

  try {
    const payload = {
      Recipient: { Imei: imei },
      Message: { Text: text },
    };

    await garminInbound("SendEmsMessage", payload);

    db.prepare(
      `INSERT INTO messages (imei, direction, text, timestamp, is_sos)
       VALUES (?, 'outbound', ?, ?, 1)`
    ).run(imei, text, new Date().toISOString());

    db.prepare(
      `UPDATE devices SET last_message_at=? WHERE imei=?`
    ).run(new Date().toISOString(), imei);

    res.json({ ok: true });
  } catch (err) {
    console.error("SendEmsMessage error:", err.response?.data || err);
    res.status(500).json({ error: "failed to send sos message" });
  }
});

// SOS ACK (original route)
app.post("/api/garmin/devices/:imei/ack-sos", async (req, res) => {
  const imei = req.params.imei;

  try {
    await garminInbound("AcknowledgeEms", {
      Recipient: { Imei: imei },
    });

    db.prepare(
      `UPDATE devices SET last_sos_ack_at=?, is_active_sos=0
       WHERE imei=?`
    ).run(new Date().toISOString(), imei);

    res.json({ ok: true });
  } catch (err) {
    console.error("AcknowledgeEms error:", err.response?.data || err);
    res.status(500).json({ error: "failed to ack sos" });
  }
});

// SOS ACK alias used by frontend
app.post("/api/garmin/devices/:imei/sos/ack", async (req, res) => {
  const imei = req.params.imei;

  try {
    await garminInbound("AcknowledgeEms", {
      Recipient: { Imei: imei },
    });

    db.prepare(
      `UPDATE devices SET last_sos_ack_at=?, is_active_sos=0
       WHERE imei=?`
    ).run(new Date().toISOString(), imei);

    res.json({ ok: true });
  } catch (err) {
    console.error("AcknowledgeEms (alias) error:", err.response?.data || err);
    res.status(500).json({ error: "failed to ack sos" });
  }
});

// REQUEST LOCATION
app.post("/api/garmin/devices/:imei/locate", async (req, res) => {
  const imei = req.params.imei;

  try {
    await garminInbound("RequestLocation", {
      Recipient: { Imei: imei },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("RequestLocation error:", err.response?.data || err);
    res.status(500).json({ error: "failed to request location" });
  }
});

// START TRACKING
app.post("/api/garmin/devices/:imei/tracking/start", async (req, res) => {
  const imei = req.params.imei;

  try {
    await garminInbound("StartTracking", {
      Recipient: { Imei: imei },
    });

    db.prepare(
      `UPDATE devices SET tracking_enabled=1 WHERE imei=?`
    ).run(imei);

    res.json({ ok: true });
  } catch (err) {
    console.error("StartTracking error:", err.response?.data || err);
    res.status(500).json({ error: "failed to start tracking" });
  }
});

// STOP TRACKING
app.post("/api/garmin/devices/:imei/tracking/stop", async (req, res) => {
  const imei = req.params.imei;

  try {
    await garminInbound("StopTracking", {
      Recipient: { Imei: imei },
    });

    db.prepare(
      `UPDATE devices SET tracking_enabled=0 WHERE imei=?`
    ).run(imei);

    res.json({ ok: true });
  } catch (err) {
    console.error("StopTracking error:", err.response?.data || err);
    res.status(500).json({ error: "failed to stop tracking" });
  }
});

// CLOSE INCIDENT
app.post(
  "/api/garmin/devices/:imei/close",
  requireRole("admin"),
  (req, res) => {
    const imei = req.params.imei;
    const now = new Date().toISOString();

    const info = db
      .prepare(
        `UPDATE devices
         SET status='closed', closedAt=?
         WHERE imei=?`
      )
      .run(now, imei);

    if (info.changes === 0)
      return res.status(404).json({ error: "not found" });

    res.json({ ok: true, closedAt: now });
  }
);

// SOS STATE – DB only
app.get("/api/garmin/devices/:imei/sos/state", (req, res) => {
  const imei = req.params.imei;

  const row = db
    .prepare(
      `SELECT is_active_sos, last_sos_event_at, last_sos_ack_at
       FROM devices
       WHERE imei = ?`
    )
    .get(imei);

  if (!row) {
    return res.status(404).json({ error: "device not found" });
  }

  res.json({
    isActiveSos: !!row.is_active_sos,
    lastSosEventAt: row.last_sos_event_at || null,
    lastSosAckAt: row.last_sos_ack_at || null,
  });
});

// DEVICES LIST
app.get("/api/garmin/devices", (req, res) => {
  const rows = db.prepare("SELECT * FROM devices").all();

  const getLastPositionStmt = db.prepare(
    "SELECT lat, lon, gps_fix, timestamp FROM positions WHERE imei=? ORDER BY id DESC LIMIT 1"
  );
  const getLastMessageStmt = db.prepare(
    "SELECT direction, text, timestamp, is_sos FROM messages WHERE imei=? ORDER BY id DESC LIMIT 1"
  );

  const devices = rows.map((d) => {
    const lastPos = getLastPositionStmt.get(d.imei);
    const lastMsg = getLastMessageStmt.get(d.imei);

    return {
      imei: d.imei,
      label: d.label,
      isActiveSos: !!d.is_active_sos,
      lastEventAt: d.last_event_at,
      lastPositionAt: d.last_position_at,
      lastMessageAt: d.last_message_at,
      lastSosEventAt: d.last_sos_event_at,
      lastSosAckAt: d.last_sos_ack_at,
      trackingEnabled: !!d.tracking_enabled,
      trackingInterval: d.tracking_interval || null,
      status: d.status || "open",
      closedAt: d.closedAt || null,
      position: lastPos
        ? {
            lat: lastPos.lat,
            lng: lastPos.lon,
            gpsFix: !!lastPos.gps_fix,
            timestamp: lastPos.timestamp,
          }
        : null,
      lastMessage: lastMsg
        ? {
            direction: lastMsg.direction,
            text: lastMsg.text,
            timestamp: lastMsg.timestamp,
            isSos: !!lastMsg.is_sos,
          }
        : null,
    };
  });

  res.json(devices);
});

// DEVICE DETAIL
app.get("/api/garmin/devices/:imei", (req, res) => {
  const imei = req.params.imei;

  const d = db
    .prepare("SELECT * FROM devices WHERE imei = ?")
    .get(imei);

  if (!d) return res.status(404).json({ error: "not found" });

  const lastPos = db
    .prepare(
      "SELECT lat, lon, gps_fix, timestamp FROM positions WHERE imei=? ORDER BY id DESC LIMIT 1"
    )
    .get(imei);

  let statusObj = {};
  if (d.status_last_json) {
    try {
      statusObj = JSON.parse(d.status_last_json);
    } catch (e) {
      statusObj = {};
    }
  }

  res.json({
    imei: d.imei,
    trackingEnabled: !!d.tracking_enabled,
    trackingInterval: d.tracking_interval || null,
    lastSosEventAt: d.last_sos_event_at,
    lastSosAckAt: d.last_sos_ack_at,
    status: statusObj,
    position: lastPos
      ? {
          lat: lastPos.lat,
          lng: lastPos.lon,
          gpsFix: !!lastPos.gps_fix,
          timestamp: lastPos.timestamp,
        }
      : null,
  });
});

// MESSAGE HISTORY
app.get("/api/garmin/devices/:imei/messages", (req, res) => {
  const imei = req.params.imei;
  const limit = Math.min(
    parseInt(req.query.limit, 10) || 50,
    200
  );

  const rows = db
    .prepare(
      "SELECT direction, text, timestamp, is_sos FROM messages WHERE imei=? ORDER BY id DESC LIMIT ?"
    )
    .all(imei, limit);

  const messages = rows.map((m) => ({
    direction: m.direction,
    text: m.text,
    timestamp: m.timestamp,
    isSos: !!m.is_sos,
  }));

  res.json(messages);
});

// POSITIONS HISTORY
app.get("/api/garmin/devices/:imei/positions", (req, res) => {
  const imei = req.params.imei;

  const rows = db
    .prepare(
      "SELECT lat, lon, gps_fix, timestamp FROM positions WHERE imei=? ORDER BY id ASC"
    )
    .all(imei);

  const points = rows.map((p) => ({
    lat: p.lat,
    lng: p.lon,
    gpsFix: !!p.gps_fix,
    timestamp: p.timestamp,
  }));

  res.json(points);
});

// --------------------------------------------
// START SERVER
// --------------------------------------------
app.listen(PORT, () => {
  console.log(`MAGNUS Garmin ECC backend running on port ${PORT}`);
});
