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

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

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
  // Log everything so we can see what Garmin is doing
  console.log("INCOMING /garmin/ipc-outbound HEADERS:", req.headers);
  console.log(
    "INCOMING /garmin/ipc-outbound BODY:",
    JSON.stringify(req.body, null, 2)
  );

  // TEMP: do NOT enforce token while we're debugging
  // Later we'll put this back once we know which header Garmin actually uses
  // const incomingToken = req.header("x-garmin-token");
  // if (GARMIN_OUTBOUND_TOKEN && incomingToken !== GARMIN_OUTBOUND_TOKEN) {
  //   console.warn("[GarminOutbound] Invalid token:", incomingToken);
  //   return res.status(401).json({ error: "invalid token" });
  // }

  const body = req.body || {};

  // Be flexible about the events array name
  const events =
    body.Events ||
    body.events ||
    body.OutboundEvents ||
    body.outboundEvents ||
    [];

  // If Garmin is just doing a “connectivity test” with no events,
  // don’t fail – just return 200 OK so the test passes.
  if (!Array.isArray(events) || events.length === 0) {
    console.warn(
      "[GarminOutbound] No Events array on payload – likely a test call"
    );
    return res.json({
      status: "ok",
      eventsHandled: 0,
      note: "no Events array; treated as test/heartbeat",
    });
  }

  let handled = 0;

  for (const ev of events) {
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

console.log("Bootstrapping MAGNUS Garmin ECC backend...");

app.listen(PORT, () => {
  console.log(`MAGNUS Garmin ECC backend running on port ${PORT}`);
});
