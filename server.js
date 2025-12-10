// MAGNUS Garmin ECC backend
// - IPC Outbound webhook
// - IPC Inbound Messaging.svc (normal + SOS-flagged messages)
// - Emergency.svc Acknowledge
// - WebSockets for live updates
// - SOS lifecycle wired to Garmin message codes 0/2/4/6/7 etc.

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

// ------------------ CONFIG ------------------
const PORT = process.env.PORT || 10000;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const ACTIVE_TENANT_ID = process.env.ACTIVE_TENANT_ID || "satdesk22";
const GARMIN_OUTBOUND_TOKEN = process.env.GARMIN_OUTBOUND_TOKEN;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Tenant config (only satdesk22 for now)
const TENANTS = {
  satdesk22: {
    inbound: {
      baseUrl: process.env.SATDESK22_INBOUND_BASE_URL || "",
      username: process.env.SATDESK22_INBOUND_USERNAME || "",
      password: process.env.SATDESK22_INBOUND_PASSWORD || "",
      apiKey: process.env.SATDESK22_INBOUND_API_KEY || "",
    },
  },
};

// ------------------ EXPRESS + WS SETUP ------------------
const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / backend
      if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"), false);
    },
    credentials: false,
  })
);

app.use(bodyParser.json());

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

// ------------------ DEVICE STORE ------------------

class DevicesStore {
  constructor() {
    this.devices = {}; // imei -> device object
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
        status: "open",
        messages: [],
        positions: [],
        sosTimeline: [],
        isActiveSos: false,
      };
    }
    fn(this.devices[imei]);
    return this.devices[imei];
  }

  // Add inbound text message from an IPC event
  addInboundMessageFromEvent(evt) {
    const imei = evt.imei || evt.Imei;
    if (!imei) return;

    const text = evt.freeText || evt.message || "";
    if (!text) return;

    const tsIso = new Date().toISOString();

    const dev = this.update(imei, (d) => {
      if (!Array.isArray(d.messages)) d.messages = [];
      d.messages.push({
        id: "in-" + Date.now() + "-" + Math.random().toString(16).slice(2),
        direction: "inbound",
        text,
        is_sos: !!d.isActiveSos,
        timestamp: tsIso,
      });
      d.lastMessageAt = tsIso;
    });

    global._wsBroadcast({ type: "deviceUpdate", device: dev });
  }

  // Add outbound message we sent from ECC
  addOutboundMessage(imei, { text, is_sos }) {
    const tsIso = new Date().toISOString();
    const dev = this.update(imei, (d) => {
      if (!Array.isArray(d.messages)) d.messages = [];
      d.messages.push({
        id: "out-" + Date.now() + "-" + Math.random().toString(16).slice(2),
        direction: "outbound",
        text,
        is_sos: !!is_sos,
        timestamp: tsIso,
      });
      d.lastMessageAt = tsIso;
    });

    global._wsBroadcast({ type: "deviceUpdate", device: dev });
  }

  // Ingest an IPC outbound event from Garmin
  ingestEvent(evt) {
    const imei = evt.imei || evt.Imei;
    if (!imei) return;

    const tsIso = new Date().toISOString();
    const code = evt.messageCode; // numeric message code from Garmin
    const msgCode = Number(code);
    const text = evt.freeText || evt.message || "";
    const point = evt.point || evt.Point || null;

    // Base update: always bump lastEventAt and last known position if present
    const dev = this.update(imei, (d) => {
      d.lastEventAt = tsIso;

      if (point && point.latitude != null && point.longitude != null) {
        if (!Array.isArray(d.positions)) d.positions = [];
        const pos = {
          lat: point.latitude,
          lon: point.longitude,
          altitude: point.altitude ?? 0,
          speed: point.speed ?? 0,
          course: point.course ?? 0,
          gpsFix: point.gpsFix ?? point.gps_fix ?? 0,
          timestamp: tsIso,
        };
        d.positions.push(pos);
        d.point = pos;
        d.lastPositionAt = tsIso;
      }
    });

    // ---- Interpret messageCode per Garmin table ----
    switch (msgCode) {
      case 0: // Position Report
        dev.sosTimeline.push({
          type: "position-report",
          code: msgCode,
          at: tsIso,
        });
        break;

      case 2: // Free Text Message
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
        // Fallback: if there is text but an unknown code, still store as inbound
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

    // ---- Notify front-end via WebSocket ----
    global._wsBroadcast({ type: "deviceUpdate", device: dev });

    // For any SOS-related code, also send a dedicated sosUpdate
    if (msgCode === 4 || msgCode === 6 || msgCode === 7) {
      global._wsBroadcast({ type: "sosUpdate", device: dev });
    }
  }
}

const devicesStore = new DevicesStore();

// ------------------ IPC INBOUND HELPERS ------------------

function buildInboundUrl(cfg, path) {
  const base = (cfg.baseUrl || "").replace(/\/+$/, "");
  return `${base}${path}`;
}

async function sendMessagingCommand(tenantId, imei, text) {
  const cfg = TENANTS[tenantId]?.inbound;
  if (!cfg || !cfg.baseUrl || !cfg.username || !cfg.password) {
    throw new Error("Inbound IPC not configured for tenant " + tenantId);
  }

  const url = buildInboundUrl(cfg, "/Messaging.svc/Message");
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");

  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  };

  if (cfg.apiKey) {
    headers["X-API-Key"] = cfg.apiKey;
  }

  const payload = {
    Messages: [
      {
        Recipients: [Number(imei)],
        Message: text,
        Timestamp: `/Date(${Date.now()})/`,
      },
    ],
  };

  console.log("[Messaging.svc] POST", url, "payload:", payload);

  const res = await axios.post(url, payload, { headers, timeout: 15000 });
  console.log("[Messaging.svc] response:", res.status, res.data);
  return res.data;
}

function buildEmergencyUrl(cfg, path) {
  const base = (cfg.baseUrl || "").replace(/\/+$/, "");
  return `${base}/Emergency.svc${path}`;
}

async function acknowledgeSos(tenantId, imei) {
  const cfg = TENANTS[tenantId]?.inbound;
  if (!cfg || !cfg.baseUrl || !cfg.username || !cfg.password) {
    throw new Error("Emergency.svc not configured for tenant " + tenantId);
  }

  const url = buildEmergencyUrl(cfg, `/AcknowledgeDeclare?imei=${encodeURIComponent(imei)}`);
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");

  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  };

  console.log("[Emergency.svc] ACK POST", url);
  const res = await axios.post(url, {}, { headers, timeout: 10000 });
  console.log("[Emergency.svc] ACK response:", res.status, res.data);
  return res.data;
}

// ------------------ AUTH MIDDLEWARE ------------------

function authenticateApiKey(req, res, next) {
  // If no key configured on the server, don't block anything
  if (!INTERNAL_API_KEY) {
    console.warn("[Auth] INTERNAL_API_KEY not set; skipping auth");
    return next();
  }

  // Accept either header name (for older / newer frontends)
  const sentKey =
    req.headers["x-api-key"] ||
    req.headers["x-internal-api-key"] || // legacy
    req.headers["x_api_key"];

  if (sentKey !== INTERNAL_API_KEY) {
    console.warn("[Auth] Unauthorized request", {
      path: req.path,
      method: req.method,
      // don't log the real key, just lengths for debugging
      sentLen: sentKey ? String(sentKey).length : 0,
      expectedLen: INTERNAL_API_KEY.length,
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}
// ------------------ ROUTES ------------------

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// IPC Outbound webhook from Garmin
app.post("/garmin/ipc-outbound", (req, res) => {
  try {
    const token = req.headers["x-outbound-auth-token"];
    if (GARMIN_OUTBOUND_TOKEN && token !== GARMIN_OUTBOUND_TOKEN) {
      console.warn("[GarminOutbound] Invalid token:", token);
      return res.status(401).json({ error: "Invalid outbound token" });
    }

    console.log("[GarminOutbound] Auth OK");
    console.log(
      "[GarminOutbound] FULL IPC PAYLOAD:",
      JSON.stringify(req.body, null, 2)
    );

    const events = req.body?.Events || [];
    events.forEach((evt) => devicesStore.ingestEvent(evt));

    console.log(
      "[DevicesStore] After IPC, total devices:",
      devicesStore.list().length
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[GarminOutbound] Error:", err);
    return res.status(500).json({ error: "Failed to process IPC outbound" });
  }
});

// ---- API: list devices ----
app.get("/api/garmin/devices", authenticateApiKey, (req, res) => {
  res.json(devicesStore.list());
});

// ---- API: device detail ----
app.get("/api/garmin/devices/:imei", authenticateApiKey, (req, res) => {
  const imei = req.params.imei;
  const dev = devicesStore.get(imei);
  if (!dev) return res.json({ device: null, messages: [], positions: [] });

  res.json({
    device: dev,
    messages: dev.messages || [],
    positions: dev.positions || [],
  });
});

// ---- API: send normal / SOS-flagged message (Messaging.svc) ----
app.post("/api/garmin/devices/:imei/message", authenticateApiKey, async (req, res) => {
  try {
    const imei = req.params.imei;
    const { text, is_sos } = req.body || {};

    if (!imei || !text || !text.trim()) {
      return res.status(400).json({ error: "Missing IMEI or text" });
    }

    const cleanText = String(text).trim();

    // Store outbound in local history first
    devicesStore.addOutboundMessage(imei, {
      text: cleanText,
      is_sos: !!is_sos,
    });

    // Send via IPCInbound Messaging.svc
    const gateway = await sendMessagingCommand(ACTIVE_TENANT_ID, imei, cleanText);

    return res.json({ ok: true, gateway });
  } catch (err) {
    console.error("[/message] IPCInbound error:", err.response?.data || err.message);
    return res.status(500).json({
      error: "Messaging failed",
      detail: err.response?.data || err.message,
    });
  }
});
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

        // If Garmin says "Illegal emergency action" (Code 15),
        // it means GEOS is the SOS provider – treat as soft-success.
        if (code === 15) {
          console.warn(
            "[ack-sos] Illegal emergency action (Code 15) – SOS handled by GEOS, not tenant.",
            data
          );
          remoteResult = data; // keep for inspection
        } else {
          // real error – bubble up
          console.error("[ack-sos] Error:", data || err.message);
          return res.status(500).json({
            error: "ACK SOS failed",
            detail: data || err.message,
          });
        }
      }

      // Update local device regardless (we still want ECC timeline clean)
      const device = devicesStore.update(imei, (d) => {
        d.isActiveSos = false;
        d.lastSosAckAt = new Date().toISOString();
        if (!Array.isArray(d.sosTimeline)) d.sosTimeline = [];
        d.sosTimeline.push({
          type: "sos-ack",
          at: d.lastSosAckAt,
          note: "Locally acknowledged; SOS provider is GEOS",
        });
      });

      global._wsBroadcast({ type: "sosUpdate", device });

      return res.json({
        ok: true,
        provider: "GEOS",
        remoteResult,
      });
    } catch (err) {
      console.error("[ack-sos] Unexpected error:", err);
      return res.status(500).json({
        error: "ACK SOS failed",
        detail: err.message,
      });
    }
  }
);


// ---- OPTIONAL: stubs for locate / tracking (so UI doesn’t 404) ----
app.post(
  "/api/garmin/devices/:imei/locate",
  authenticateApiKey,
  async (req, res) => {
    const imei = req.params.imei;
    console.log("[LOCATE] Request for IMEI", imei);
    // TODO: send IPCInbound Locate command if needed
    return res.json({ ok: true });
  }
);

app.post(
  "/api/garmin/devices/:imei/tracking",
  authenticateApiKey,
  async (req, res) => {
    const imei = req.params.imei;
    const { enabled } = req.body || {};
    console.log("[TRACKING] Request for IMEI", imei, "enabled:", enabled);

    const dev = devicesStore.update(imei, (d) => {
      d.trackingEnabled = !!enabled;
    });

    return res.json({ ok: true, trackingEnabled: !!dev.trackingEnabled });
  }
);

// ------------------ START ------------------
server.listen(PORT, () => {
  console.log("MAGNUS Garmin ECC backend running on port", PORT);
});
