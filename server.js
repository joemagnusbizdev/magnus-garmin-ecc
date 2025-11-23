// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();

// --- CONFIG ----------------------------------------------------------

const PORT = process.env.PORT || 10000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "MAGNUS302010!";

const GARMIN_OUTBOUND_AUTH_TOKEN =
  process.env.GARMIN_OUTBOUND_AUTH_TOKEN || "";

// --- MIDDLEWARE ------------------------------------------------------

app.set("trust proxy", true);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(morgan("combined"));

// --- HELPER MIDDLEWARE -----------------------------------------------

function authenticateApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) {
    console.warn(
      "[APIAuth] INTERNAL_API_KEY not set – all /api routes are open. Set it in Render env."
    );
    return next();
  }

  const apiKey =
    req.get("x-api-key") ||
    req.query.api_key ||
    (req.body && req.body.api_key);

  if (!apiKey) {
    console.log("[APIAuth] Missing API key");
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (apiKey !== INTERNAL_API_KEY) {
    console.log("[APIAuth] Invalid API key:", apiKey);
    return res.status(403).json({ error: "Forbidden" });
  }

  return next();
}

function authenticateGarminOutbound(req, res, next) {
  const token = req.get("x-outbound-auth-token");

  if (!token) {
    console.log("[GarminOutbound] Missing x-outbound-auth-token header");
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!GARMIN_OUTBOUND_AUTH_TOKEN) {
    console.log(
      "[GarminOutbound] ERROR: GARMIN_OUTBOUND_AUTH_TOKEN env var is not set"
    );
    return res.status(500).json({ error: "Server misconfigured" });
  }

  if (token !== GARMIN_OUTBOUND_AUTH_TOKEN) {
    console.log("[GarminOutbound] Invalid token received:", token);
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[GarminOutbound] Auth OK");
  return next();
}

// --- IN-MEMORY DEVICE STORE ------------------------------------------
//
// Shape returned to the frontend:
//
// device = {
//   imei: string,
//   label: string,
//   status: "open" | "closed",
//   isActiveSos: boolean,
//   lastPosition: { lat, lon, timestamp, gpsFix? } | null,
//   lastPositionAt: ISO string | null,
//   lastMessageAt: ISO string | null,
//   lastEventAt: ISO string | null,
//   lastSosEventAt?: ISO string | null,
//   lastSosAckAt?: ISO string | null,
//   messages: [ { direction, text, timestamp, is_sos } ],
//   positions: [ { lat, lon, timestamp, gpsFix? } ]
// }

const devicesStore = new Map();

function getAllDevices() {
  return Array.from(devicesStore.values());
}

function upsertDeviceFromIpcEvent(evt) {
  // From your payload:
  // {
  //   "imei": "300234010961140",
  //   "freeText": "...",
  //   "timeStamp": -62135596800000,
  //   "point": { latitude, longitude, altitude, gpsFix, ... }
  //   ...
  // }

  const imei = evt.imei || "UNKNOWN-IMEI";

  // Garmin test uses weird timestamp -62135596800000 ⇒ treat as "now".
  let tsMs = Number(evt.timeStamp);
  if (!Number.isFinite(tsMs) || tsMs <= 0) {
    tsMs = Date.now();
  }
  const tsIso = new Date(tsMs).toISOString();

  let device = devicesStore.get(imei);
  if (!device) {
    device = {
      imei,
      label: imei,
      status: "open",
      isActiveSos: false,
      lastPosition: null,
      lastPositionAt: null,
      lastMessageAt: null,
      lastEventAt: null,
      lastSosEventAt: null,
      lastSosAckAt: null,
      messages: [],
      positions: [],
    };
  }

  // Message (chat) – virtual test has freeText
  if (evt.freeText) {
    device.messages.push({
      direction: "inbound", // from device to ECC
      text: evt.freeText,
      timestamp: tsIso,
      is_sos: false,
    });
    device.lastMessageAt = tsIso;
  }

  // Position (map + locations tab)
  if (evt.point) {
    const p = evt.point;
    const position = {
      lat: Number(p.latitude) || 0,
      lon: Number(p.longitude) || 0,
      timestamp: tsIso,
      gpsFix: p.gpsFix,
    };

    device.lastPosition = position;
    device.lastPositionAt = tsIso;
    device.positions.push(position);
  }

  // Generic "last activity" for list view
  device.lastEventAt = tsIso;

  devicesStore.set(imei, device);
  console.log(
    `[DevicesStore] Upserted device ${imei}. Total devices: ${devicesStore.size}`
  );
}

// --- HEALTHCHECK -----------------------------------------------------

app.head("/", (req, res) => {
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "MAGNUS Garmin ECC backend",
    time: new Date().toISOString(),
  });
});

// --- FRONTEND API ROUTES ---------------------------------------------
// These are what your ECC console calls.

// List devices (used for left sidebar + map markers)
app.get("/api/garmin/devices", authenticateApiKey, async (req, res) => {
  try {
    const devices = getAllDevices();
    res.json(devices); // frontend already normalizes array / object
  } catch (err) {
    console.error("[/api/garmin/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// Device detail (used for chat + locations tab)
app.get(
  "/api/garmin/devices/:imei",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const device = devicesStore.get(imei);

      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }

      res.json({
        device,
        messages: device.messages || [],
        positions: device.positions || [],
      });
    } catch (err) {
      console.error("[/api/garmin/devices/:imei] Error:", err);
      res.status(500).json({ error: "Failed to fetch device detail" });
    }
  }
);

// Send message TO device (for now just store locally)
app.post(
  "/api/garmin/devices/:imei/message",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const { text } = req.body || {};

      if (!text) {
        return res.status(400).json({ error: "Missing text" });
      }

      let device = devicesStore.get(imei);
      if (!device) {
        // create skeleton so UI doesn't break
        device = {
          imei,
          label: imei,
          status: "open",
          isActiveSos: false,
          lastPosition: null,
          lastPositionAt: null,
          lastMessageAt: null,
          lastEventAt: null,
          lastSosEventAt: null,
          lastSosAckAt: null,
          messages: [],
          positions: [],
        };
      }

      const tsIso = new Date().toISOString();
      device.messages.push({
        direction: "outbound",
        text,
        timestamp: tsIso,
        is_sos: /^SOS:/i.test(text),
      });
      device.lastMessageAt = tsIso;
      device.lastEventAt = tsIso;

      devicesStore.set(imei, device);

      // TODO: wire real Garmin IPC outbound call here.
      res.json({ ok: true });
    } catch (err) {
      console.error("[/api/garmin/devices/:imei/message] Error:", err);
      res.status(500).json({ error: "Failed to send message" });
    }
  }
);

// Ack SOS (for now just flip flags in-memory)
app.post(
  "/api/garmin/devices/:imei/ack-sos",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const device = devicesStore.get(imei);

      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }

      device.isActiveSos = false;
      device.lastSosAckAt = new Date().toISOString();
      devicesStore.set(imei, device);

      // TODO: send ack back to Garmin if/when needed.
      res.json({ ok: true });
    } catch (err) {
      console.error("[/api/garmin/devices/:imei/ack-sos] Error:", err);
      res.status(500).json({ error: "Failed to ack SOS" });
    }
  }
);

// Map overlay endpoint – same devices, lighter format if you want later
app.get("/api/garmin/map/devices", authenticateApiKey, async (req, res) => {
  try {
    const devices = getAllDevices().map((d) => ({
      imei: d.imei,
      label: d.label,
      isActiveSos: d.isActiveSos,
      status: d.status,
      lastPosition: d.lastPosition,
    }));
    res.json(devices);
  } catch (err) {
    console.error("[/api/garmin/map/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch map devices" });
  }
});

// --- GARMIN IPC OUTBOUND ENDPOINT ------------------------------------

app.post(
  "/garmin/ipc-outbound",
  authenticateGarminOutbound,
  async (req, res) => {
    try {
      const { headers, body } = req;

      console.log("HEADERS FROM GARMIN:", {
        host: headers.host,
        "user-agent": headers["user-agent"],
        "content-length": headers["content-length"],
        "content-type": headers["content-type"],
        "x-outbound-auth-token": headers["x-outbound-auth-token"],
        "correlation-context": headers["correlation-context"],
        "cf-connecting-ip": headers["cf-connecting-ip"],
        "x-forwarded-for": headers["x-forwarded-for"],
      });

      console.log(
        "[GarminOutbound] FULL IPC PAYLOAD:",
        JSON.stringify(body, null, 2)
      );

      const events = (body && body.Events) || [];
      events.forEach((evt) => upsertDeviceFromIpcEvent(evt));

      console.log(
        "[DevicesStore] After IPC, total devices:",
        devicesStore.size
      );

      // Must reply quickly 200 to keep Garmin happy
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[GarminOutbound] Handler error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// --- ERROR HANDLER ---------------------------------------------------

app.use((err, req, res, next) => {
  console.error("[GlobalError]", err);
  res.status(500).json({ error: "Internal server error" });
});

// --- START SERVER ----------------------------------------------------

app.listen(PORT, () => {
  console.log("Bootstrapping MAGNUS Garmin ECC backend...");
  console.log(`MAGNUS Garmin ECC backend running on port ${PORT}`);
});
