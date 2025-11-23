// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();

// --- CONFIG ----------------------------------------------------------

const PORT = process.env.PORT || 10000;

// Allowed frontends (CORS)
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Garmin outbound auth token – must match what Garmin sends
const GARMIN_OUTBOUND_AUTH_TOKEN =
  process.env.GARMIN_OUTBOUND_AUTH_TOKEN || "";

// In-memory devices store (reset on restart)
// imei -> {
//   imei, label, status, isActiveSos,
//   lastEventAt, lastPositionAt, lastMessageAt,
//   lastSosEventAt, lastSosAckAt,
//   lastPosition: { lat, lon, timestamp, gpsFix },
//   positions: [ { lat, lon, timestamp } ],
//   messages: [ { direction, text, timestamp, is_sos } ]
// }
const devicesStore = {};

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

// --- HELPER MIDDLEWARE ----------------------------------------------

// 🔓 Dev mode: API key check disabled so frontend can talk freely
function authenticateApiKey(req, res, next) {
  // If you want to re-enable later, add INTERNAL_API_KEY logic here.
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

// --- DEVICE HELPERS -------------------------------------------------

function getOrCreateDevice(imei) {
  if (!imei) imei = "VIRTUAL-TEST";
  if (!devicesStore[imei]) {
    devicesStore[imei] = {
      imei,
      label: imei === "VIRTUAL-TEST" ? "Garmin Virtual Test" : `Device ${imei}`,
      status: "open",
      isActiveSos: false,
      lastEventAt: null,
      lastPositionAt: null,
      lastMessageAt: null,
      lastSosEventAt: null,
      lastSosAckAt: null,
      lastPosition: null,
      positions: [],
      messages: [],
    };
  }
  return devicesStore[imei];
}

function deviceSummary(device) {
  // Strip large arrays when listing all devices
  const {
    positions,
    messages,
    ...rest
  } = device;
  return rest;
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
// These are what your ECC JS calls.

// List devices (sidebar + map)
app.get("/api/garmin/devices", authenticateApiKey, async (req, res) => {
  try {
    const list = Object.values(devicesStore).map(deviceSummary);
    res.json(list); // ECC expects an array
  } catch (err) {
    console.error("[/api/garmin/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// Map devices (you can shape differently later if needed)
app.get("/api/garmin/map/devices", authenticateApiKey, async (req, res) => {
  try {
    const list = Object.values(devicesStore).map(deviceSummary);
    res.json(list);
  } catch (err) {
    console.error("[/api/garmin/map/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch map devices" });
  }
});

// Device detail: used after sending message / ack SOS
// ECC expects: { device, messages, positions }
app.get(
  "/api/garmin/devices/:imei",
  authenticateApiKey,
  async (req, res) => {
    const imei = req.params.imei;
    const device = devicesStore[imei];
    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }

    res.json({
      device: deviceSummary(device),
      messages: device.messages || [],
      positions: device.positions || [],
    });
  }
);

// Send message to device (ECC then re-fetches detail)
app.post(
  "/api/garmin/devices/:imei/message",
  authenticateApiKey,
  async (req, res) => {
    const imei = req.params.imei;
    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Missing text" });
    }

    const device = getOrCreateDevice(imei);
    const now = new Date().toISOString();

    const msg = {
      direction: "outbound",
      text: text.trim(),
      timestamp: now,
      is_sos: text.trim().startsWith("SOS:") || false,
    };

    device.messages.push(msg);
    device.lastMessageAt = now;
    device.lastEventAt = now;

    // TODO: here you would actually call Garmin Messaging API

    res.json({ ok: true });
  }
);

// Acknowledge SOS (ECC then re-fetches list + detail)
app.post(
  "/api/garmin/devices/:imei/ack-sos",
  authenticateApiKey,
  async (req, res) => {
    const imei = req.params.imei;
    const device = getOrCreateDevice(imei);
    const now = new Date().toISOString();

    device.isActiveSos = false;
    device.lastSosAckAt = now;
    device.lastEventAt = now;

    // TODO: send SOS ack to Garmin (if API supports)

    res.json({ ok: true });
  }
);

// Request location (ECC just shows "request sent")
app.post(
  "/api/garmin/devices/:imei/locate",
  authenticateApiKey,
  async (req, res) => {
    const imei = req.params.imei;
    const device = getOrCreateDevice(imei);

    // TODO: call Garmin "locate" / tracking API.
    // For now we just acknowledge the request.
    device.lastEventAt = new Date().toISOString();

    res.json({ ok: true });
  }
);

// --- GARMIN IPC OUTBOUND ENDPOINT ------------------------------------
// URL registered with Garmin: /garmin/ipc-outbound

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
        "cf-connecting-ip": headers["cf-connecting-ip"],
        "x-forwarded-for": headers["x-forwarded-for"],
      });

      console.log(
        "[GarminOutbound] Received IPC payload, top-level keys:",
        body && Object.keys(body)
      );

      let imei = null;

      // ⚠️ We don't know exact schema yet, so we keep this generic.
      // Once you paste a real sample body we can map fields properly.
      try {
        if (body && Array.isArray(body.Events) && body.Events.length > 0) {
          const evt = body.Events[0];

          imei =
            evt.DeviceImei ||
            evt.Imei ||
            (evt.Device && (evt.Device.IMEI || evt.Device.Imei)) ||
            null;
        }
      } catch (e) {
        console.log("[GarminOutbound] Could not extract IMEI:", e.message);
      }

      if (!imei) {
        console.log("[DevicesStore] No IMEI in payload – using VIRTUAL-TEST");
        imei = "VIRTUAL-TEST";
      }

      const device = getOrCreateDevice(imei);
      const now = new Date().toISOString();

      // Minimal update so the ECC shows *something*
      device.lastEventAt = now;

      // Naive assumption: treat virtual test as SOS-like
      device.isActiveSos = true;
      device.lastSosEventAt = device.lastSosEventAt || now;

      console.log(
        "[DevicesStore] Upserted device",
        imei,
        ". Total devices:",
        Object.keys(devicesStore).length
      );

      // Respond quickly to Garmin
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
