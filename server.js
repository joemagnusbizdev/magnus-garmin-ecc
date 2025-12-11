// MAGNUS Garmin ECC backend
// - IPC Outbound ingestion (events, SOS, tracking)
// - IPC Inbound Messaging (Messaging.svc with Basic Auth + X-API-Key)
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

// Tenant config
const TENANTS = {
  satdesk22: {
    inbound: {
      // Example: https://eur-enterprise.inreach.garmin.com/IPCInbound/V1
      baseUrl: (process.env.SATDESK22_INBOUND_BASE_URL || "").replace(/\/+$/, ""),
      username: process.env.SATDESK22_INBOUND_USERNAME || "",
      password: process.env.SATDESK22_INBOUND_PASSWORD || "",
      apiKey: process.env.SATDESK22_INBOUND_API_KEY || "",
      // 👇 MUST be a valid, Garmin-accepted sender (email/SMS)
      senderEmail: process.env.SATDESK22_SENDER_EMAIL || "",
    },
  },
};

// -------------------- APP + CORS --------------------
const app = express();

// simple explicit CORS allow-list for now
const corsOptions = {
  origin: function (origin, cb) {
    const allowed = [
      "https://blog.magnusafety.com",
      "http://localhost:5500",
      "http://127.0.0.1:5500",
    ];
    if (!origin || allowed.includes(origin)) return cb(null, true);
    console.warn("[CORS] Blocked origin:", origin);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key", "x-internal-api-key"],
};

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
        lastSosEventAt: null,
        lastSosAckAt: null,
      };
    }
    fn(this.devices[imei]);
    return this.devices[imei];
  }

  // === SOS FIX: inbound messages marked as SOS when SOS is active ===
  addInboundMessageFromEvent(evt) {
    const imei = evt.imei || evt.Imei;
    if (!imei) return;

    const tsIso = new Date().toISOString();
    const text = evt.freeText || evt.message || evt.Message || "";

    this.update(imei, (d) => {
      const isSos = !!d.isActiveSos; // if SOS currently active, treat as SOS message

      if (!Array.isArray(d.messages)) d.messages = [];
      d.messages.push({
        id: "in-" + Date.now(),
        direction: "inbound",
        text,
        timestamp: tsIso,
        is_sos: isSos,
      });
      d.lastMessageAt = tsIso;

      if (!Array.isArray(d.sosTimeline)) d.sosTimeline = [];

      if (isSos) {
        d.sosTimeline.push({
          type: "sos-inbound-message",
          at: tsIso,
          text,
        });
      } else {
        d.sosTimeline.push({
          type: "inbound-message",
          at: tsIso,
          text,
        });
      }
    });
  }

  // === Outbound messages; if SOS, also log in sosTimeline ===
  addOutboundMessage(imei, { text, is_sos }) {
    const tsIso = new Date().toISOString();
    this.update(imei, (d) => {
      const isSos = !!is_sos;

      if (!Array.isArray(d.messages)) d.messages = [];
      d.messages.push({
        id: "out-" + Date.now(),
        direction: "outbound",
        text,
        timestamp: tsIso,
        is_sos: isSos,
      });
      d.lastMessageAt = tsIso;

      if (!Array.isArray(d.sosTimeline)) d.sosTimeline = [];
      if (isSos) {
        d.sosTimeline.push({
          type: "sos-outbound-message",
          at: tsIso,
          text,
        });
      }
    });
  }

  // Core Garmin IPC Event ingestion
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

    // Interpret messageCode
    switch (msgCode) {
      case 0: // Position Report
        dev.sosTimeline.push({
          type: "position-report",
          code: msgCode,
          at: tsIso,
        });
        break;

      case 2: // Free Text (one variant)
      case 3: // Free Text (the one we see in logs)
      case 3099: // Canned / QuickText
        this.addInboundMessageFromEvent(evt);
        break;

      case 4: // Declare SOS
        dev.isActiveSos = true;
        dev.lastSosEventAt = tsIso; // only DECLARE sets the "event time"
        dev.sosTimeline.push({
          type: "sos-declare",
          code: msgCode,
          at: tsIso,
          text,
        });
        break;

      case 6: // SOS-related event / confirm
        // Keep SOS active, but DO NOT bump lastSosEventAt (so ack stays valid)
        dev.isActiveSos = true;
        dev.sosTimeline.push({
          type: "sos-confirm-or-update",
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
  const cfgContainer = TENANTS[tenantId];
  if (!cfgContainer || !cfgContainer.inbound || !cfgContainer.inbound.baseUrl) {
    throw new Error("Tenant inbound config missing for " + tenantId);
  }
  return cfgContainer.inbound;
}

function buildInboundUrl(cfg, path) {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  if (path.startsWith("/")) return base + path;
  return base + "/" + path;
}

// Messaging.svc – Messages[], Sender MUST be valid email/SMS
async function sendMessagingCommand(tenantId, imei, text) {
  const cfg = getTenantConfig(tenantId);
  const url = buildInboundUrl(cfg, "/Messaging.svc/Message");

  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");

  const headers = {
    Authorization: `Basic ${auth}`,
    "X-API-Key": cfg.apiKey,
    "Content-Type": "application/json",
  };

  const sender =
    cfg.senderEmail ||
    process.env.SATDESK22_SENDER_EMAIL ||
    process.env.MESSAGING_SENDER_EMAIL ||
    "";

  if (!sender) {
    throw new Error(
      "No senderEmail configured; set SATDESK22_SENDER_EMAIL or TENANTS.satdesk22.inbound.senderEmail"
    );
  }

  const payload = {
    Messages: [
      {
        Recipients: [Number(imei)],
        Sender: sender,
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

// Emergency.svc AcknowledgeDeclare
async function acknowledgeSos(tenantId, imei) {
  const cfg = getTenantConfig(tenantId);
  const url = buildInboundUrl(
    cfg,
    `/Emergency.svc/AcknowledgeDeclare?imei=${encodeURIComponent(imei)}`
  );

  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");

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

// Healthcheck
app.get("/", (req, res) => {
  res.json({ ok: true, service: "MAGNUS Garmin ECC backend" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Device list + detail (front-end)
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

// Send message (normal or SOS-labeled)
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

      const trimmedText = text.trim();

      // === SOS FIX: auto-flag as SOS if device is in active SOS and caller didn't specify is_sos ===
      const dev = devicesStore.get(imei);
      const hasActiveSos = !!(dev && dev.isActiveSos);
      const isSosFlag =
        typeof is_sos === "boolean" ? !!is_sos : hasActiveSos;

      // Optional: auto-prefix SOS text, purely cosmetic
      const finalText =
        isSosFlag && !trimmedText.toLowerCase().startsWith("sos:")
          ? `SOS: ${trimmedText}`
          : trimmedText;

      // Store outbound in ECC history (including sosTimeline if SOS)
      devicesStore.addOutboundMessage(imei, {
        text: finalText,
        is_sos: isSosFlag,
      });

      const result = await sendMessagingCommand(
        ACTIVE_TENANT_ID,
        imei,
        finalText
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

// ACK SOS (Code 15 => GEOS soft success)
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

      // === SOS FIX: mark ACK time, do NOT cancel SOS here ===
      const ackIso = new Date().toISOString();
      const device = devicesStore.update(imei, (d) => {
        d.lastSosAckAt = ackIso;
        if (!Array.isArray(d.sosTimeline)) d.sosTimeline = [];
        d.sosTimeline.push({
          type: "sos-ack",
          at: ackIso,
          note: "Locally acknowledged; SOS provider may be GEOS",
        });

        if (!Array.isArray(d.messages)) d.messages = [];
        d.messages.push({
          id: "sos-ack-" + Date.now(),
          direction: "system",
          text: `SOS acknowledged by MAGNUS ECC at ${ackIso}`,
          timestamp: ackIso,
          is_sos: true,
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
