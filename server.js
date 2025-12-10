// MAGNUS Garmin ECC backend
// - IPC Outbound ingestion (events, SOS, tracking)
// - IPC Inbound Messaging (Messaging.svc with Sender + Basic Auth)
// - Emergency.svc ACK SOS with Code 15 soft-handling (GEOS)
// - WebSockets for live updates
// - CORS for WordPress (blog.magnusafety.com)

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

// -------------------- ENV --------------------
const PORT = process.env.PORT || 10000;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const ACTIVE_TENANT_ID = process.env.ACTIVE_TENANT_ID || "satdesk22";
const GARMIN_OUTBOUND_TOKEN = process.env.GARMIN_OUTBOUND_TOKEN || "";

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Per-tenant config
const TENANTS = {
  satdesk22: {
    inbound: {
      // Example: https://eur-enterprise.inreach.garmin.com/IPCInbound/V1
      baseUrl: (process.env.SATDESK22_INBOUND_BASE_URL || "").replace(
        /\/+$/,
        ""
      ),
      username: process.env.SATDESK22_INBOUND_USERNAME || "",
      password: process.env.SATDESK22_INBOUND_PASSWORD || "",
      apiKey: process.env.SATDESK22_INBOUND_API_KEY || "", // used for X-API-Key
    },
  },
};

// -------------------- APP + CORS --------------------
const app = express();

const corsOptions = {
  origin: function (origin, cb) {
    // Allow server-to-server / curl (no origin)
    if (!origin) return cb(null, true);

    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    console.warn("[CORS] Blocked origin:", origin);
    // Returning false just blocks it; avoids throwing PathError
    return cb(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-api-key",
    "x-internal-api-key",
  ],
  credentials: false,
};

// Apply CORS globally (handles preflight too)
app.use(cors(corsOptions));

app.use(bodyParser.json());

// -------------------- AUTH MIDDLEWARE --------------------
function authenticateApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) {
    console.warn("[Auth] INTERNAL_API_KEY not set; skipping auth");
    return next();
  }

  const sentKey =
    req.headers["x-api-key"] ||
    req.headers["x-internal-api-key"] ||
    req.headers["x_api_key"];

  if (sentKey !== INTERNAL_API_KEY) {
    console.warn("[Auth] Unauthorized request", {
      path: req.path,
      method: req.method,
      sentLen: sentKey ? String(sentKey).length : 0,
      expectedLen: INTERNAL_API_KEY.length,
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}

// -------------------- WEBSOCKETS --------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

global._wsBroadcast = (event) => {
  const payload = JSON.stringify(event);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
};

wss.on("connection", (ws) => {
  console.log("[WS] Client connected");
  ws.on("close", () => console.log("[WS] Client disconnected"));
});

// -------------------- DEVICE STORE --------------------
class DevicesStore {
  constructor() {
    this.devices = {};
  }

  get(imei) {
    return this.devices[imei];
  }

  list() {
    return Object.values(this.devices);
  }

  update(imei, fn) {
    if (!this.devices[imei]) {
      this.devices[imei] = {
        imei,
        label: imei,
        messages: [],
        sosTimeline: [],
        isActiveSos: false,
      };
    }
    fn(this.devices[imei]);
    return this.devices[imei];
  }

  addInboundMessageFromEvent(evt) {
    const imei = evt.imei || evt.Imei;
    if (!imei) return;

    const tsIso = new Date().toISOString();
    const text = evt.freeText || evt.message || evt.Message || "";

    this.update(imei, (d) => {
      if (!Array.isArray(d.messages)) d.messages = [];
      d.messages.push({
        id: "in-" + Date.now(),
        direction: "inbound",
        text,
        timestamp: tsIso,
        is_sos: false,
      });
      d.lastMessageAt = tsIso;
    });
  }

  addOutboundMessage(imei, { text, is_sos }) {
    const tsIso = new Date().toISOString();
    this.update(imei, (d) => {
      if (!Array.isArray(d.messages)) d.messages = [];
      d.messages.push({
        id: "out-" + Date.now(),
        direction: "outbound",
        text,
        timestamp: tsIso,
        is_sos: !!is_sos,
      });
      d.lastMessageAt = tsIso;
    });
  }

  ingestEvent(evt) {
    const imei = evt.imei || evt.Imei;
    if (!imei) return;

    const tsIso = new Date().toISOString();
    const code = evt.messageCode;
    const msgCode = Number(code);
    const text = evt.freeText || evt.message || "";
    const point = evt.point || evt.Point || null;

    const dev = this.update(imei, (d) => {
      d.lastEventAt = tsIso;

      if (point && point.latitude != null && point.longitude != null) {
        d.point = {
          latitude: point.latitude,
          longitude: point.longitude,
          altitude: point.altitude,
          gpsFix: point.gpsFix ?? point.gps_fix ?? null,
          course: point.course,
          speed: point.speed,
          timestamp: tsIso,
        };
        d.lastPositionAt = tsIso;
      }

      if (!Array.isArray(d.sosTimeline)) d.sosTimeline = [];
    });

    // Interpret messageCode (per Garmin table)
    switch (msgCode) {
      case 0: // Position Report
        dev.sosTimeline.push({
          type: "position-report",
          code: msgCode,
          at: tsIso,
        });
        break;

      case 2: // Free Text
      case 3099: // Canned / QuickText
        this.addInboundMessageFromEvent(evt);
        dev.sosTimeline.push({
          type: "inbound-message",
          code: msgCode,
          at: tsIso,
          text,
        });
        break;

      case 4: // Declare SOS
        dev.isActiveSos = true;
        dev.lastSosEventAt = tsIso;
        dev.sosTimeline.push({
          type: "sos-declare",
          code: msgCode,
          at: tsIso,
          text,
        });
        break;

      case 6: // Confirm SOS
        dev.isActiveSos = true;
        dev.lastSosEventAt = tsIso;
        dev.sosTimeline.push({
          type: "sos-confirm",
          code: msgCode,
          at: tsIso,
          text,
        });
        break;

      case 7: // Cancel SOS
        dev.isActiveSos = false;
        dev.lastSosCancelAt = tsIso;
        dev.sosTimeline.push({
          type: "sos-cancel",
          code: msgCode,
          at: tsIso,
          text,
        });
        break;

      case 8: // Reference Point
        dev.sosTimeline.push({
          type: "reference-point",
          code: msgCode,
          at: tsIso,
          text,
        });
        break;

      case 10: // Start Track
        dev.sosTimeline.push({
          type: "track-start",
          code: msgCode,
          at: tsIso,
        });
        break;

      case 11: // Track Interval change
        dev.sosTimeline.push({
          type: "track-interval",
          code: msgCode,
          at: tsIso,
        });
        break;

      case 12: // Stop Track
        dev.sosTimeline.push({
          type: "track-stop",
          code: msgCode,
          at: tsIso,
        });
        break;

      default:
        if (text) {
          this.addInboundMessageFromEvent(evt);
          dev.sosTimeline.push({
            type: "inbound-message-unknown-code",
            code: msgCode,
            at: tsIso,
            text,
          });
        } else {
          dev.sosTimeline.push({
            type: "unknown-event",
            code: msgCode,
            at: tsIso,
          });
        }
        break;
    }

    global._wsBroadcast({ type: "deviceUpdate", device: dev });

    if (msgCode === 4 || msgCode === 6 || msgCode === 7) {
      global._wsBroadcast({ type: "sosUpdate", device: dev });
    }
  }
}

const devicesStore = new DevicesStore();

// -------------------- IPC INBOUND HELPERS --------------------
function getTenantConfig(tenantId) {
  const cfg = TENANTS[tenantId];
  if (!cfg || !cfg.inbound || !cfg.inbound.baseUrl) {
    throw new Error("Tenant inbound config missing for " + tenantId);
  }
  return cfg.inbound;
}

function buildInboundUrl(cfg, path) {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  if (path.startsWith("/")) return base + path;
  return base + "/" + path;
}

// Messaging.svc – JSON with Messages[], Sender, Basic Auth + X-API-Key
async function sendMessagingCommand(tenantId, imei, text) {
  const cfg = getTenantConfig(tenantId);
  const url = buildInboundUrl(cfg, "/Messaging.svc/Message");

  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString(
    "base64"
  );

  const headers = {
    Authorization: `Basic ${auth}`,
    "X-API-Key": cfg.apiKey,
    "Content-Type": "application/json",
  };

  const payload = {
    Messages: [
      {
        Recipients: [Number(imei)],
        Sender: "MAGNUS ECC", // MUST be non-empty => fixes "message sender is empty"
        Timestamp: `/Date(${Date.now()})/`,
        Message: text,
      },
    ],
  };

  console.log("[Messaging] POST", url, "payload:", payload);

  const res = await axios.post(url, payload, {
    headers,
    timeout: 10000,
  });

  console.log(
    "[Messaging] Garmin response:",
    res.status,
    JSON.stringify(res.data)
  );

  return res.data;
}

// Emergency.svc AcknowledgeDeclare (Alternate SOS – Code 15 soft-handled)
async function acknowledgeSos(tenantId, imei) {
  const cfg = getTenantConfig(tenantId);
  const url = buildInboundUrl(
    cfg,
    `/Emergency.svc/AcknowledgeDeclare?imei=${encodeURIComponent(imei)}`
  );

  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString(
    "base64"
  );

  console.log("[Emergency] ACK SOS POST", url);

  const res = await axios.post(
    url,
    {},
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );

  console.log("[Emergency] ACK response:", res.status, res.data);
  return res.data;
}

// -------------------- ROUTES --------------------

// Simple healthcheck
app.get("/", (req, res) => {
  res.json({ ok: true, service: "MAGNUS Garmin ECC backend" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Device list + detail (front-end uses these)
app.get("/api/garmin/devices", authenticateApiKey, (req, res) => {
  res.json(devicesStore.list());
});

app.get("/api/garmin/devices/:imei", authenticateApiKey, (req, res) => {
  const imei = req.params.imei;
  const dev = devicesStore.get(imei);
  if (!dev) return res.json({});
  res.json(dev);
});

// IPC Outbound webhook from Garmin
app.post("/garmin/ipc-outbound", (req, res) => {
  const token = req.headers["x-outbound-auth-token"];
  if (!GARMIN_OUTBOUND_TOKEN || token !== GARMIN_OUTBOUND_TOKEN) {
    console.warn(
      "[GarminOutbound] Invalid token",
      token,
      "expected",
      GARMIN_OUTBOUND_TOKEN
    );
    return res.status(401).json({ error: "Invalid token" });
  }

  console.log("[GarminOutbound] Auth OK");
  console.log("[GarminOutbound] FULL IPC PAYLOAD:", JSON.stringify(req.body));

  const events = req.body.Events || [];
  events.forEach((evt) => devicesStore.ingestEvent(evt));

  console.log(
    "[DevicesStore] After IPC, total devices:",
    devicesStore.list().length
  );

  res.json({ ok: true });
});

// Send *normal* message (used for both normal + SOS-labelled messages)
app.post(
  "/api/garmin/devices/:imei/message",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const { text, is_sos } = req.body || {};

      if (!imei || !text || !text.trim()) {
        return res
          .status(400)
          .json({ error: "Missing IMEI or text for message" });
      }

      // Store outbound in ECC
      devicesStore.addOutboundMessage(imei, {
        text: text.trim(),
        is_sos: !!is_sos,
      });

      const result = await sendMessagingCommand(
        ACTIVE_TENANT_ID,
        imei,
        text.trim()
      );

      const device = devicesStore.get(imei);
      global._wsBroadcast({ type: "deviceUpdate", device });

      res.json({ ok: true, result });
    } catch (err) {
      const status = err.response?.status || 500;
      const data = err.response?.data;
      console.error("[/message] Messaging failed:", status, data || err.message);
      res.status(500).json({
        error: "Messaging failed",
        detail: data || err.message,
      });
    }
  }
);

// ACK SOS (Code 15 => soft success / GEOS)
app.post(
  "/api/garmin/devices/:imei/ack-sos",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      if (!imei) {
        return res.status(400).json({ error: "Missing IMEI" });
      }

      let remoteResult = null;
      try {
        remoteResult = await acknowledgeSos(ACTIVE_TENANT_ID, imei);
      } catch (err) {
        const data = err.response?.data;
        const code = data?.Code;

        if (code === 15) {
          // IllegalEmergencyActionError – GEOS is the SOS provider
          console.warn(
            "[ack-sos] Code 15 – SOS handled by GEOS, treating as soft success",
            data
          );
          remoteResult = data;
        } else {
          console.error("[ack-sos] Error:", data || err.message);
          return res.status(500).json({
            error: "ACK SOS failed",
            detail: data || err.message,
          });
        }
      }

      const device = devicesStore.update(imei, (d) => {
        d.isActiveSos = false;
        d.lastSosAckAt = new Date().toISOString();
        if (!Array.isArray(d.sosTimeline)) d.sosTimeline = [];
        d.sosTimeline.push({
          type: "sos-ack",
          at: d.lastSosAckAt,
          note: "Locally acknowledged; SOS provider may be GEOS",
        });
      });

      global._wsBroadcast({ type: "sosUpdate", device });

      res.json({
        ok: true,
        provider: "GEOS-or-tenant",
        remoteResult,
      });
    } catch (err) {
      console.error("[ack-sos] Unexpected error:", err);
      res.status(500).json({ error: "ACK SOS failed", detail: err.message });
    }
  }
);

// -------------------- START SERVER --------------------
server.listen(PORT, () => {
  console.log("MAGNUS Garmin ECC backend running on port", PORT);
});
