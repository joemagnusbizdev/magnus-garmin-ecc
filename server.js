// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();

// --- CONFIG ----------------------------------------------------------

const PORT = process.env.PORT || 10000;

// Comma-separated list of allowed frontends
// e.g. "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000"
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Internal API key used by the ECC frontend (x-api-key)
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "MAGNUS302010!";

// Garmin outbound auth token – must match what Garmin sends
// in x-outbound-auth-token header (e.g. EDF01295)
const GARMIN_OUTBOUND_AUTH_TOKEN =
  process.env.GARMIN_OUTBOUND_AUTH_TOKEN || "";

// --- SIMPLE IN-MEMORY DEVICE STORE ----------------------------------

class DevicesStore {
  constructor() {
    this.devices = new Map(); // key: imei, value: device record
  }

  _ensureDevice(imei) {
    if (!this.devices.has(imei)) {
      this.devices.set(imei, {
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

        // history
        messages: [],
        positions: [],
      });
    }
    return this.devices.get(imei);
  }

  upsertFromIpcEvent(event) {
    const imei = event.imei || "VIRTUAL-TEST";

    // Try to interpret timestamp – Garmin sends ms since epoch
    let tsMs =
      typeof event.timeStamp === "number" ? event.timeStamp : Date.now();
    let ts = new Date(tsMs);
    if (isNaN(ts.getTime())) {
      ts = new Date();
    }
    const tsIso = ts.toISOString();

    const dev = this._ensureDevice(imei);

    // Basic fields
    dev.lastEventAt = tsIso;

    // Position
    if (event.point && typeof event.point.latitude === "number") {
      const p = {
        lat: event.point.latitude,
        lon: event.point.longitude,
        altitude: event.point.altitude,
        gpsFix: event.point.gpsFix,
        course: event.point.course,
        speed: event.point.speed,
        timestamp: tsIso,
      };
      dev.positions.push(p);
      dev.lastPosition = p;
      dev.lastPositionAt = tsIso;
    }

    // Interpret messageCode – we'll treat 6 as SOS (inbound)
    const messageCode = event.messageCode;
    const isSos = messageCode === 6;

    // Free text / message
    const text =
      event.freeText && event.freeText.trim().length > 0
        ? event.freeText
        : `Garmin event (code ${messageCode})`;

    dev.messages.push({
      id: dev.messages.length + 1,
      direction: "inbound",
      is_sos: isSos,
      text,
      timestamp: tsIso,
    });

    dev.lastMessageAt = tsIso;

    if (isSos) {
      dev.isActiveSos = true;
      dev.lastSosEventAt = tsIso;
      dev.status = "open";
    }

    return dev;
  }

  listSummaries() {
    return Array.from(this.devices.values()).map((d) => ({
      imei: d.imei,
      label: d.label,
      status: d.status || "open",
      isActiveSos: !!d.isActiveSos,
      lastPosition: d.lastPosition,
      lastPositionAt: d.lastPositionAt,
      lastMessageAt: d.lastMessageAt,
      lastEventAt: d.lastEventAt,
      lastSosEventAt: d.lastSosEventAt,
      lastSosAckAt: d.lastSosAckAt,
    }));
  }

  getDevice(imei) {
    return this.devices.get(imei) || null;
  }

  ackSos(imei) {
    const dev = this.devices.get(imei);
    if (!dev) return null;
    dev.isActiveSos = false;
    dev.lastSosAckAt = new Date().toISOString();
    return dev;
  }

  addOutboundMessage(imei, text, opts = {}) {
    const dev = this._ensureDevice(imei);
    const tsIso = new Date().toISOString();
    dev.messages.push({
      id: dev.messages.length + 1,
      direction: "outbound",
      is_sos: !!opts.isSos,
      text,
      timestamp: tsIso,
    });
    dev.lastMessageAt = tsIso;
    return dev;
  }
}

const devicesStore = new DevicesStore();

// --- MIDDLEWARE ------------------------------------------------------

app.set("trust proxy", true); // behind Render / CF

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser tools (no origin) and whitelisted origins
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(morgan("combined"));

// --- AUTH MIDDLEWARE -------------------------------------------------

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

// --- OPERATOR LOGIN (DUMMY) ------------------------------------------
// Simple login just to let the frontend show a login screen.
// In real life you would check a DB / IdP etc.

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Missing username or password" });
  }

  // TODO: replace with real auth. For now accept anything non-empty.
  const tokenPayload = {
    sub: username,
    role: "operator",
    iat: Date.now(),
  };

  // Very simple fake token
  const fakeToken = Buffer.from(JSON.stringify(tokenPayload)).toString(
    "base64url"
  );

  return res.json({ token: fakeToken });
});

// --- FRONTEND API ROUTES ---------------------------------------------
// These require x-api-key from the ECC frontend.

// List devices (summary)
app.get("/api/garmin/devices", authenticateApiKey, async (req, res) => {
  try {
    const list = devicesStore.listSummaries();
    res.json(list);
  } catch (err) {
    console.error("[/api/garmin/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// Map devices – for now same as summaries
app.get("/api/garmin/map/devices", authenticateApiKey, async (req, res) => {
  try {
    const list = devicesStore.listSummaries();
    res.json(list);
  } catch (err) {
    console.error("[/api/garmin/map/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch map devices" });
  }
});

// Device detail
app.get(
  "/api/garmin/devices/:imei",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const dev = devicesStore.getDevice(imei);
      if (!dev) {
        return res.status(404).json({ error: "Device not found" });
      }
      res.json({ device: dev });
    } catch (err) {
      console.error("[GET /api/garmin/devices/:imei] Error:", err);
      res.status(500).json({ error: "Failed to fetch device detail" });
    }
  }
);

// Send message (stubbed – no actual Garmin outbound yet)
app.post(
  "/api/garmin/devices/:imei/message",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const { text } = req.body || {};
      if (!text || !text.trim()) {
        return res.status(400).json({ error: "Message text is required" });
      }

      console.log(
        "[OutboundMessage] (stub) To IMEI",
        imei,
        "text:",
        JSON.stringify(text)
      );

      const dev = devicesStore.addOutboundMessage(imei, text, {
        isSos: /^SOS:/i.test(text),
      });

      // TODO: wire this to real Garmin send API.
      res.json({ ok: true, device: dev });
    } catch (err) {
      console.error("[POST /api/garmin/devices/:imei/message] Error:", err);
      res.status(500).json({ error: "Failed to send message" });
    }
  }
);

// Acknowledge SOS
app.post(
  "/api/garmin/devices/:imei/ack-sos",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const dev = devicesStore.ackSos(imei);
      if (!dev) {
        return res.status(404).json({ error: "Device not found" });
      }

      // Log an outbound "ack" message in the conversation
      devicesStore.addOutboundMessage(imei, "[SOS acknowledged by operator]", {
        isSos: true,
      });

      res.json({ ok: true, device: dev });
    } catch (err) {
      console.error("[POST /api/garmin/devices/:imei/ack-sos] Error:", err);
      res.status(500).json({ error: "Failed to acknowledge SOS" });
    }
  }
);

// Locate request (stub only)
app.post(
  "/api/garmin/devices/:imei/locate",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      console.log(
        "[LocateRequest] (stub) Locate request for IMEI",
        imei
      );
      // TODO: wire to real Garmin locate endpoint
      res.json({ ok: true });
    } catch (err) {
      console.error("[POST /api/garmin/devices/:imei/locate] Error:", err);
      res.status(500).json({ error: "Failed to send locate request" });
    }
  }
);

// --- GARMIN IPC OUTBOUND ENDPOINT ------------------------------------
// This is the URL you gave Garmin as the IPC outbound webhook
// e.g. https://magnus-garmin-ecc.onrender.com/garmin/ipc-outbound

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
      if (Array.isArray(events)) {
        events.forEach((evt) => {
          devicesStore.upsertFromIpcEvent(evt);
        });
      }

      console.log(
        "[DevicesStore] After IPC, total devices:",
        devicesStore.listSummaries().length
      );

      // Always respond quickly to Garmin
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
