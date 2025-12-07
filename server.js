// MAGNUS ECC Backend with SOS + Messaging + WebSockets
// - IPCInbound Messaging (SOAP + X-API-Key)
// - Emergency.svc (SOS Ack)
// - WebSockets for live updates
// - SOS timeline + basic message history

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const PORT = process.env.PORT || 10000;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const ACTIVE_TENANT_ID = process.env.ACTIVE_TENANT_ID || "satdesk22";

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

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ------------------- WebSocket -------------------
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

// ------------------- Device Store -------------------
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
        messages: [],
        sosTimeline: [],
        isActiveSos: false,
      };
    }
    fn(this.devices[imei]);
    return this.devices[imei];
  }

  addOutboundMessage(imei, msg) {
    const tsIso = new Date().toISOString();
    const dev = this.update(imei, (d) => {
      d.messages = d.messages || [];
      d.messages.push({
        direction: "outbound",
        text: msg.text || "",
        is_sos: !!msg.is_sos,
        timestamp: tsIso,
      });
      d.lastMessageAt = tsIso;
    });
    global._wsBroadcast({ type: "deviceUpdate", device: dev });
    return dev;
  }

  addInboundMessageFromEvent(evt) {
    const imei = evt.imei || evt.Imei;
    if (!imei) return;

    const text = evt.freeText || evt.message || "";
    if (!text) return;

    const tsIso = new Date().toISOString();
    const dev = this.update(imei, (d) => {
      d.messages = d.messages || [];
      d.messages.push({
        direction: "inbound",
        text,
        is_sos: false, // we still mark SOS separately from messageCode
        timestamp: tsIso,
      });
      d.lastMessageAt = tsIso;
    });
    global._wsBroadcast({ type: "deviceUpdate", device: dev });
    return dev;
  }

  ingestEvent(evt) {
    const imei = evt.imei || evt.Imei;
    if (!imei) return;
    const tsIso = new Date().toISOString();

    const d = this.update(imei, (dev) => {
      dev.lastEventAt = tsIso;
      if (evt.point) {
        dev.point = evt.point;
        dev.lastPositionAt = tsIso;
      }
    });

    const code = evt.messageCode;
    const text = evt.freeText || "";
    const eventType = (evt.eventType || evt.EventType || "")
      .toString()
      .toLowerCase();

    const isEmergency =
      code === 7 ||
      code === 8 ||
      evt.isEmergency === true ||
      eventType.includes("sos");

    if (isEmergency) {
      d.isActiveSos = true;
      d.lastSosEventAt = tsIso;
      d.sosTimeline.push({ type: "sos-start", at: tsIso, text });
      global._wsBroadcast({ type: "sosUpdate", device: d });
    }

    // If there is freeText, treat it as an inbound message for chat history
    if (text) {
      this.addInboundMessageFromEvent(evt);
    }

    global._wsBroadcast({ type: "deviceUpdate", device: d });
  }
}

const devicesStore = new DevicesStore();

// ------------------- IPCInbound Helpers -------------------
function buildInboundUrl(cfg, path) {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return `${base}${path}`;
}

// Single function to send a normal message via Messaging.svc/Message
async function callIpcInboundMessaging({ tenantId, imei, text }) {
  const cfg = TENANTS[tenantId].inbound;
  const url = buildInboundUrl(cfg, "/Messaging.svc/Message");

  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");

  const headers = {
    Authorization: `Basic ${auth}`,
    "X-API-Key": cfg.apiKey,
    "Content-Type": "application/json",
  };

  const payload = {
    Messages: [
      {
        Recipients: [Number(imei)],
        Sender: "ecc@magnus.co.il",
        Timestamp: `/Date(${Date.now()})/`,
        Message: text,
      },
    ],
  };

  console.log("[Messaging.svc] POST", url, "payload:", payload);

  const res = await axios.post(url, payload, { headers });
  console.log("[Messaging.svc] Response:", res.status, res.data);
  return res.data;
}

function buildEmergencyUrl(cfg, path) {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return `${base}/Emergency.svc${path}`;
}

async function acknowledgeSos(tenantId, imei) {
  const cfg = TENANTS[tenantId].inbound;
  const url = buildEmergencyUrl(cfg, `/AcknowledgeDeclare?imei=${imei}`);

  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");

  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  };

  console.log("[Emergency.svc] POST", url);

  const res = await axios.post(url, {}, { headers });
  console.log("[Emergency.svc] ACK response:", res.status, res.data);
  return res.data;
}

// ------------------- API Key Auth Middleware -------------------
function authenticateApiKey(req, res, next) {
  const headerKey =
    req.headers["x-internal-api-key"] || req.headers["x-api-key"];
  if (!INTERNAL_API_KEY) {
    console.warn("[Auth] INTERNAL_API_KEY not configured – allowing all");
    return next();
  }
  if (headerKey !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ------------------- Routes -------------------

// List devices (no auth for now – controlled by CORS + embedding)
app.get("/api/garmin/devices", (req, res) => {
  res.json(devicesStore.list());
});

// Single device detail
app.get("/api/garmin/devices/:imei", (req, res) => {
  res.json(devicesStore.get(req.params.imei) || {});
});

// Outbound webhook from Garmin IPC
app.post("/garmin/ipc-outbound", (req, res) => {
  const token = req.headers["x-outbound-auth-token"];
  if (token !== process.env.GARMIN_OUTBOUND_TOKEN) {
    console.warn("[GarminOutbound] Invalid token:", token);
    return res.status(401).json({ error: "Invalid token" });
  }

  console.log("[GarminOutbound] Auth OK");
  console.log("[GarminOutbound] FULL IPC PAYLOAD:", JSON.stringify(req.body, null, 2));

  const events = req.body.Events || [];
  events.forEach((evt) => devicesStore.ingestEvent(evt));

  res.json({ ok: true });
});

// Normal message to device
app.post(
  "/api/garmin/devices/:imei/message",
  authenticateApiKey,
  async (req, res) => {
    try {
      const { text, is_sos } = req.body || {};
      const imei = req.params.imei;

      if (!text || !text.trim()) {
        return res.status(400).json({ error: "Message text is required" });
      }

      // Store outbound in ECC as message (optionally flagged SOS)
      const dev = devicesStore.addOutboundMessage(imei, {
        text,
        is_sos: !!is_sos,
      });

      // Send via IPCInbound Messaging SOAP
      const result = await callIpcInboundMessaging({
        tenantId: ACTIVE_TENANT_ID,
        imei,
        text,
      });

      return res.json({ ok: true, result, device: dev });
    } catch (e) {
      console.error("[/message] Messaging failed:", e.response?.data || e.message);
      return res
        .status(500)
        .json({ error: "Messaging failed", detail: e.response?.data || e.message });
    }
  }
);

// --- SOS MESSAGE ALIAS -----------------------------------------------
// Uses the same Messaging.svc/Message pipeline, but marks message as SOS in ECC
app.post(
  "/api/garmin/devices/:imei/sos-message",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const { text } = req.body || {};

      if (!text || !text.trim()) {
        return res
          .status(400)
          .json({ error: "Message text is required" });
      }

      // Store outbound as SOS in ECC history
      const dev = devicesStore.addOutboundMessage(imei, {
        text,
        is_sos: true,
      });

      // Reuse the same SOAP Messaging.svc flow
      const result = await callIpcInboundMessaging({
        tenantId: ACTIVE_TENANT_ID,
        imei,
        text,
      });

      return res.json({ ok: true, result, device: dev });
    } catch (err) {
      console.error("[/sos-message] IPCInbound error:", err.response?.data || err.message);
      return res.status(500).json({
        error: "SOS message failed",
        detail: err.response?.data || err.message,
      });
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
      const result = await acknowledgeSos(ACTIVE_TENANT_ID, imei);

      const device = devicesStore.update(imei, (d) => {
        d.isActiveSos = false;
        d.lastSosAckAt = new Date().toISOString();
        d.sosTimeline.push({
          type: "sos-ack",
          at: d.lastSosAckAt,
        });
      });

      global._wsBroadcast({ type: "sosUpdate", device });

      return res.json({ ok: true, result, device });
    } catch (e) {
      console.error("[ack-sos] Failed:", e.response?.data || e.message);
      return res
        .status(500)
        .json({ error: "ACK SOS failed", detail: e.response?.data || e.message });
    }
  }
);

// ------------------- Start server -------------------
server.listen(PORT, () => {
  console.log("MAGNUS Garmin ECC backend running on port", PORT);
});
