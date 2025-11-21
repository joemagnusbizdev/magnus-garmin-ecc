// --------------------------------------------
//  MAGNUS GARMIN ECC BACKEND (Node + SQLite)
// --------------------------------------------
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const Database = require("better-sqlite3");
const path = require("path");
const axios = require("axios");
const cors = require("cors");

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

// Allow frontend on blog.magnusafety.com to call this API
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
function logEvent(type, payload = {}) {
  const entry = {
    ts: new Date().toISOString(),
    type,
    ...payload,
  };
  console.log("[ECC]", JSON.stringify(entry));
}

function upsertDeviceBase(imei, ts) {
  db.prepare(
    `
    INSERT INTO devices (imei, last_event_at)
    VALUES (?, ?)
    ON CONFLICT(imei) DO UPDATE SET last_event_at=excluded.last_event_at
  `
  ).run(imei, ts);
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
  // TEMP: log all headers so we can see what Garmin sends
  console.log("HEADERS FROM GARMIN:", req.headers);

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
      if (ev.messageText || ev.moText) {
        const text = ev.messageText || ev.moText || "";
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
