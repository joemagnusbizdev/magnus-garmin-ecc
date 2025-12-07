// MAGNUS ECC Backend with SOS + Messaging + WebSockets
// THIS IS A CONSOLIDATED server.js INCLUDING:
// - IPCInbound Messaging (REST BasicAuth + X-API-Key)
// - Emergency.svc (SOS Ack + SOS Messaging)
// - WebSockets for live updates
// - SOS Timeline tracking
// NOTE: Adjust as needed for your environment.

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
  ingestEvent(evt) {
    const imei = evt.imei || evt.Imei;
    if (!imei) return;
    const tsIso = new Date().toISOString();

    const d = this.update(imei, (dev) => {
      dev.lastEventAt = tsIso;
      dev.point = evt.point;
    });

    const code = evt.messageCode;
    const text = evt.freeText || "";
    const eventType = (evt.eventType || evt.EventType || "").toString().toLowerCase();

    const isEmergency =
      code === 7 ||
      code === 8 ||
      evt.isEmergency === true ||
      eventType.includes("sos");

    if (isEmergency) {
      d.isActiveSos = true;
      d.sosTimeline.push({ type: "sos-start", at: tsIso, text });
    }

    global._wsBroadcast({ type: "deviceUpdate", device: d });
    if (isEmergency) global._wsBroadcast({ type: "sosUpdate", device: d });
  }
}

const devicesStore = new DevicesStore();

// ------------------- IPCInbound Helpers -------------------
function buildInboundUrl(cfg, path) {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return `${base}${path}`;
}

async function sendMessagingCommand(tenantId, imei, text) {
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

  const res = await axios.post(url, payload, { headers });
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

  const res = await axios.post(url, {}, { headers });
  return res.data;
}

async function sendSosMessage(tenantId, imei, text) {
  const cfg = TENANTS[tenantId].inbound;
  const url = buildEmergencyUrl(cfg, `/Message`);

  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");

  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  };

  const payload = {
    Imei: Number(imei),
    Message: text,
    Timestamp: `/Date(${Date.now()})/`,
  };

  const res = await axios.post(url, payload, { headers });
  return res.data;
}

// ------------------- Routes -------------------
app.get("/api/garmin/devices", (req, res) => {
  res.json(devicesStore.list());
});

app.get("/api/garmin/devices/:imei", (req, res) => {
  res.json(devicesStore.get(req.params.imei) || {});
});

// Outbound webhook
app.post("/garmin/ipc-outbound", (req, res) => {
  const token = req.headers["x-outbound-auth-token"];
  if (token !== process.env.GARMIN_OUTBOUND_TOKEN) {
    return res.status(401).json({ error: "Invalid token" });
  }

  const events = req.body.Events || [];
  events.forEach((evt) => devicesStore.ingestEvent(evt));

  res.json({ ok: true });
});

// Send normal message
app.post("/api/garmin/devices/:imei/message", async (req, res) => {
  try {
    if (req.headers["x-internal-api-key"] !== INTERNAL_API_KEY)
      return res.status(401).json({ error: "Unauthorized" });

    const { text } = req.body;
    const imei = req.params.imei;

    const result = await sendMessagingCommand(ACTIVE_TENANT_ID, imei, text);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: "Messaging failed", detail: e.message });
  }
});

// SOS message
app.post("/api/garmin/devices/:imei/sos-message", async (req, res) => {
  try {
    if (req.headers["x-internal-api-key"] !== INTERNAL_API_KEY)
      return res.status(401).json({ error: "Unauthorized" });

    const { text } = req.body;
    const imei = req.params.imei;

    const result = await sendSosMessage(ACTIVE_TENANT_ID, imei, text);
    const device = devicesStore.update(imei, (d) => {
      d.sosTimeline.push({
        type: "sos-outbound-message",
        at: new Date().toISOString(),
        text,
      });
    });

    global._wsBroadcast({ type: "sosUpdate", device });

    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: "SOS message failed", detail: e.message });
  }
});

// --- REST: SOS message via Emergency/SendMessage --------------------
app.post("/api/garmin/devices/:imei/sos-message", async (req, res) => {
  try {
    const imei = req.params.imei;
    const { text } = req.body || {};

    if (!imei || !text || !text.trim()) {
      return res
        .status(400)
        .json({ error: "Missing IMEI or text for SOS message" });
    }

    const restBase = (process.env.SATDESK22_REST_BASE_URL || "").replace(/\/+$/, "");
    const apiKey = process.env.SATDESK22_REST_API_KEY;

    if (!restBase || !apiKey) {
      console.error("[SOS message] REST not configured");
      return res.status(500).json({ error: "REST not configured for SOS" });
    }

    const url = `${restBase}/Emergency/SendMessage`;

    const payload = {
      IMEI: imei,
      UtcTimeStamp: new Date().toISOString(), // must be ISO UTC
      Message: text.trim(),
    };

    console.log("[SOS message] POST", url, "payload:", payload);

    const axiosResp = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      timeout: 10000,
    });

    console.log(
      "[SOS message] Garmin response:",
      axiosResp.status,
      axiosResp.data
    );

    // Garmin returns 200 OK with empty body on success
    return res.json({ ok: true });
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data;

    console.error("[SOS message] Error:", status, data || err.message);

    return res.status(500).json({
      error: "SOS message failed",
      detail: data || err.message,
    });
  }
});

// Acknowledge SOS
app.post("/api/garmin/devices/:imei/ack-sos", async (req, res) => {
  try {
    if (req.headers["x-internal-api-key"] !== INTERNAL_API_KEY)
      return res.status(401).json({ error: "Unauthorized" });

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

    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: "ACK SOS failed", detail: e.message });
  }
});

// ------------------- Start server -------------------
server.listen(PORT, () => {
  console.log("MAGNUS Garmin ECC backend running on port", PORT);
});
