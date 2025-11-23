// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

// Node 18+ has global fetch; if not, you'd need node-fetch.
// Here we assume Render is on a modern Node (it is).
const app = express();

// --- CONFIG ----------------------------------------------------------

const PORT = process.env.PORT || 10000;

// Frontend origins allowed to call this backend
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Internal API key used by ECC frontend (index.html)
const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY || "MAGNUS302010!";

// Outbound token used by Garmin -> our /garmin/ipc-outbound
const GARMIN_OUTBOUND_AUTH_TOKEN =
  process.env.GARMIN_OUTBOUND_AUTH_TOKEN || "";

// IPC Inbound (we call Garmin to send messages / locate / etc.)
const IPC_INBOUND_BASE_URL =
  process.env.IPC_INBOUND_BASE_URL ||
  "https://eur-enterprise.inreach.garmin.com";
const IPC_INBOUND_USERNAME =
  process.env.IPC_INBOUND_USERNAME || "MagnusDash";
const IPC_INBOUND_PASSWORD =
  process.env.IPC_INBOUND_PASSWORD || "MagnusDash1";

// --- MIDDLEWARE ------------------------------------------------------

app.set("trust proxy", true);

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

// --- HELPER MIDDLEWARE -----------------------------------------------

function authenticateApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) {
    console.warn(
      "[APIAuth] INTERNAL_API_KEY not set – /api routes are open. Set it in env."
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

// --- SIMPLE HEALTHCHECK ----------------------------------------------

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

// --- IN-MEMORY DEVICE STORE ------------------------------------------
// This lets us build /api/garmin/devices and device detail/chat view.

class DevicesStore {
  constructor() {
    /** @type {Map<string, any>} */
    this.devices = new Map();
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
        messages: [], // chat history
        positions: [], // track history
      });
    }
    return this.devices.get(imei);
  }

  upsertFromIpcEvent(ev) {
    const imei = ev.imei || ev.Imei || ev.IMEI || "UNKNOWN";
    const dev = this._ensureDevice(imei);

    // Label – you can improve later (e.g. from Garmin user info)
    if (!dev.label) dev.label = imei;

    // Timestamp
    const tsMs = typeof ev.timeStamp === "number" ? ev.timeStamp : null;
    const ts =
      tsMs && tsMs > 0 ? new Date(tsMs).toISOString() : null;

    // Position
    if (ev.point && typeof ev.point.latitude === "number" && typeof ev.point.longitude === "number") {
      const p = {
        lat: ev.point.latitude,
        lon: ev.point.longitude,
        altitude: ev.point.altitude,
        gpsFix: ev.point.gpsFix,
        course: ev.point.course,
        speed: ev.point.speed,
        timestamp: ts,
      };
      dev.lastPosition = p;
      dev.lastPositionAt = ts;
      // push into history (cap at 200)
      dev.positions.push(p);
      if (dev.positions.length > 200) {
        dev.positions.shift();
      }
    }

    // Message / event
    dev.lastEventAt = ts || dev.lastEventAt;

    // If this is a message or SOS-ish event
    const mCode = ev.messageCode;
    const freeText = ev.freeText || "";

    // Very simple SOS detection: treat messageCode 6 as SOS start
    // You can refine this based on full docs.
    const isSosEvent = mCode === 6;

    if (freeText || isSosEvent) {
      dev.messages.push({
        direction: "inbound",
        text: freeText || (isSosEvent ? "Emergency/SOS event" : ""),
        is_sos: !!isSosEvent,
        timestamp: ts || new Date().toISOString(),
      });
      if (dev.messages.length > 500) {
        dev.messages.shift();
      }
      dev.lastMessageAt = ts || dev.lastMessageAt;
    }

    if (isSosEvent) {
      dev.isActiveSos = true;
      dev.lastSosEventAt = ts;
    }

    this.devices.set(imei, dev);
    return dev;
  }

  addOutboundMessage(imei, text, isSos) {
    const dev = this._ensureDevice(imei);
    const nowIso = new Date().toISOString();
    dev.messages.push({
      direction: "outbound",
      text: text || "",
      is_sos: !!isSos,
      timestamp: nowIso,
    });
    if (dev.messages.length > 500) {
      dev.messages.shift();
    }
    dev.lastMessageAt = nowIso;
    this.devices.set(imei, dev);
    return dev;
  }

  setSosClearedByImei(imei) {
    const dev = this._ensureDevice(imei);
    dev.isActiveSos = false;
    dev.lastSosAckAt = new Date().toISOString();
    this.devices.set(imei, dev);
  }

  getAll() {
    return Array.from(this.devices.values());
  }

  get(imei) {
    if (!imei) return null;
    return this.devices.get(imei) || null;
  }
}

const devicesStore = new DevicesStore();

// --- IPC OUTBOUND (GARMIN -> US) ------------------------------------
// URL you gave Garmin: https://magnus-garmin-ecc.onrender.com/garmin/ipc-outbound

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

      if (body && Array.isArray(body.Events)) {
        body.Events.forEach((ev) => {
          devicesStore.upsertFromIpcEvent(ev);
        });
        console.log(
          `[DevicesStore] After IPC, total devices: ${devicesStore.getAll().length}`
        );
      } else {
        console.log("[GarminOutbound] No Events array in payload");
      }

      // Always respond quickly
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[GarminOutbound] Handler error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// --- IPC INBOUND HELPER (US -> GARMIN) -------------------------------

// NOTE: You MUST cross-check this with:
// https://explore.garmin.com/IPCInbound/docs/
// The structure below is a best-effort template and may need
// small tweaks (field names / path) based on the official docs.

async function callIpcInboundMessaging(endpointPath, payload) {
  const url = `${IPC_INBOUND_BASE_URL}${endpointPath}`;
  console.log("[IPCInbound] POST", url, "payload:", payload);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = { raw: text };
  }

  if (!res.ok) {
    console.error(
      "[IPCInbound] Error response",
      res.status,
      res.statusText,
      data
    );
    throw new Error(
      `IPCInbound ${endpointPath} failed: ${res.status} ${res.statusText}`
    );
  }

  console.log("[IPCInbound] OK response", data);
  return data;
}

// --- FRONTEND API ROUTES (ECC UI) ------------------------------------

// List all devices (used by ECC sidebar + map)
app.get("/api/garmin/devices", authenticateApiKey, async (req, res) => {
  try {
    const list = devicesStore.getAll();
    res.json(list);
  } catch (err) {
    console.error("[/api/garmin/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// Map devices - for now same as list, but you could shape differently
app.get(
  "/api/garmin/map/devices",
  authenticateApiKey,
  async (req, res) => {
    try {
      const list = devicesStore.getAll();
      res.json(list);
    } catch (err) {
      console.error("[/api/garmin/map/devices] Error:", err);
      res.status(500).json({ error: "Failed to fetch map devices" });
    }
  }
);

// Device detail (used for chat + locations tab)
app.get(
  "/api/garmin/devices/:imei",
  authenticateApiKey,
  async (req, res) => {
    try {
      const { imei } = req.params;
      const device = devicesStore.get(imei);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      res.json({ device });
    } catch (err) {
      console.error("[GET /api/garmin/devices/:imei] Error:", err);
      res.status(500).json({ error: "Failed to fetch device detail" });
    }
  }
);

// Send a normal message to device via IPC Inbound Messaging
app.post(
  "/api/garmin/devices/:imei/message",
  authenticateApiKey,
  async (req, res) => {
    try {
      const { imei } = req.params;
      const { text } = req.body || {};

      if (!text || !text.trim()) {
        return res
          .status(400)
          .json({ error: "Message text is required" });
      }

      // --- IMPORTANT ---
      // Check Garmin docs for exact JSON and endpoint path.
      // This is a template that you can adjust:
      //
      //   POST https://eur-enterprise.inreach.garmin.com/IPCInbound/V1/Messaging.svc/Message
      //
      // Example (hypothetical) body:
      // {
      //   "Username": "...",
      //   "Password": "...",
      //   "Message": {
      //     "Imei": "3014...",
      //     "Text": "Hello from MAGNUS",
      //     "SendToInbox": true
      //   }
      // }
      //
      // Replace endpointPath and fields below as required.

      const endpointPath = "/IPCInbound/V1/Messaging.svc/Message";

      const payload = {
        Username: IPC_INBOUND_USERNAME,
        Password: IPC_INBOUND_PASSWORD,
        Message: {
          Imei: imei,
          Text: text,
          SendToInbox: true,
        },
      };

      const inboundResponse = await callIpcInboundMessaging(
        endpointPath,
        payload
      );

      // Record outbound message in local store so chat view updates
      const deviceAfter = devicesStore.addOutboundMessage(
        imei,
        text,
        false
      );

      res.json({
        ok: true,
        inboundResponse,
        device: deviceAfter,
      });
    } catch (err) {
      console.error("[POST /api/garmin/devices/:imei/message] Error:", err);
      res.status(500).json({ error: "Failed to send message" });
    }
  }
);

// Request locate – template/proxy, wired from ECC but may need tweaks
app.post(
  "/api/garmin/devices/:imei/locate",
  authenticateApiKey,
  async (req, res) => {
    try {
      const { imei } = req.params;

      // Template – adjust according to Messaging docs if needed
      const endpointPath = "/IPCInbound/V1/Messaging.svc/Locate";
      const payload = {
        Username: IPC_INBOUND_USERNAME,
        Password: IPC_INBOUND_PASSWORD,
        Imei: imei,
      };

      const inboundResponse = await callIpcInboundMessaging(
        endpointPath,
        payload
      );

      res.json({ ok: true, inboundResponse });
    } catch (err) {
      console.error("[POST /api/garmin/devices/:imei/locate] Error:", err);
      res.status(500).json({ error: "Failed to send locate request" });
    }
  }
);

// SOS ACK – requires EmergencyId; not fully wired yet.
// For now we just mark SOS cleared in local store.
app.post(
  "/api/garmin/devices/:imei/ack-sos",
  authenticateApiKey,
  async (req, res) => {
    try {
      const { imei } = req.params;

      // TODO: If you decide to use Emergency.svc Acknowledge/Close,
      // you'll need an EmergencyId from Garmin to send here.
      // For now we only clear local flag so UI hides the red banner.

      devicesStore.setSosClearedByImei(imei);
      const device = devicesStore.get(imei);
      res.json({ ok: true, device, note: "Local-only SOS clear" });
    } catch (err) {
      console.error("[POST /api/garmin/devices/:imei/ack-sos] Error:", err);
      res.status(500).json({ error: "Failed to acknowledge SOS" });
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
