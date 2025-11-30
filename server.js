// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

// --- CONFIG ----------------------------------------------------------

const app = express();
const PORT = process.env.PORT || 10000;

// Allowed frontend origins
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Simple API key for ECC frontend calls
const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY || "MAGNUS302010!";

// Garmin outbound auth token for /garmin/ipc-outbound
const GARMIN_OUTBOUND_AUTH_TOKEN =
  process.env.GARMIN_OUTBOUND_AUTH_TOKEN ||
  process.env.GARMIN_OUTBOUND_TOKEN ||
  "";

// Optional SQLite DB path (not yet used, but reserved)
const DB_FILE = process.env.DB_FILE || "garmin.db";

// --- MULTI-TENANT GARMIN CONFIG -------------------------------------
// Right now only satdesk22 is active, but this is ready for more.

const TENANTS = {
  satdesk22: {
    id: "satdesk22",

    // Legacy SOAP-style IPCInbound (if you ever want it again)
    ipcSoapBaseUrl:
      process.env.SATDESK22_INBOUND_BASE_URL ||
      "https://eur-enterprise.inreach.garmin.com/IPCInbound/V1",
    ipcSoapUsername:
      process.env.SATDESK22_INBOUND_USERNAME ||
      process.env.IPC_EU_USERNAME ||
      "",
    ipcSoapPassword:
      process.env.SATDESK22_INBOUND_PASSWORD ||
      process.env.IPC_EU_PASSWORD ||
      "",

    // NEW REST IPCInbound
    ipcRestBaseUrl:
      process.env.SATDESK22_REST_BASE_URL ||
      "https://ipcinbound.inreachapp.com/api",
    ipcRestApiKey: process.env.SATDESK22_REST_API_KEY || "",

    // Toggle REST on/off
    restEnabled:
      String(process.env.SATDESK22_REST_ENABLED || "true")
        .toLowerCase() === "true",
  },
};

const ACTIVE_TENANT_ID = process.env.ACTIVE_TENANT_ID || "satdesk22";

function getActiveTenant() {
  const tenant = TENANTS[ACTIVE_TENANT_ID];
  if (!tenant) {
    console.warn(
      "[Tenant] ACTIVE_TENANT_ID",
      ACTIVE_TENANT_ID,
      "has no config – outbound sends will be skipped"
    );
  } else {
    console.log("[Tenant] Using tenant:", ACTIVE_TENANT_ID);
  }
  return tenant;
}

// --- MIDDLEWARE ------------------------------------------------------

app.set("trust proxy", true);

app.use(
  cors({
    origin(origin, callback) {
      // allow curl/postman (no origin) and whitelisted frontends
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(morgan("combined"));

// --- HELPERS: AUTH ---------------------------------------------------

function authenticateApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) {
    console.warn(
      "[APIAuth] INTERNAL_API_KEY not set – /api routes are open"
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
    console.log("[GarminOutbound] Missing x-outbound-auth-token");
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!GARMIN_OUTBOUND_AUTH_TOKEN) {
    console.log(
      "[GarminOutbound] ERROR: GARMIN_OUTBOUND_AUTH_TOKEN not set"
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

// --- IPCINBOUND REST CALL (ECC → GARMIN) -----------------------------

/**
 * Send a message to Garmin via IPCInbound REST.
 * Uses the active tenant's ipcRestBaseUrl + ipcRestApiKey.
 */
async function callIpcInboundMessaging({ imei, text }) {
  const tenant = getActiveTenant();

  if (!tenant) {
    console.warn("[IPCInbound] No active tenant – outbound send skipped");
    return { skipped: true, reason: "no-tenant" };
  }

  const restBase = tenant.ipcRestBaseUrl;
  const apiKey = tenant.ipcRestApiKey;

  console.log("[IPCInbound] Tenant config for send:", {
    tenantId: tenant.id,
    baseUrl: restBase,
    apiKeyPresent: !!apiKey,
    usernamePresent: !!tenant.ipcSoapUsername,
    passwordPresent: !!tenant.ipcSoapPassword,
  });

  if (!tenant.restEnabled || !apiKey || !restBase) {
    console.warn(
      "[IPCInbound] Missing REST credentials – skipping outbound send"
    );
    return { skipped: true, reason: "missing-rest-credentials" };
  }

  const url = `${restBase.replace(/\/+$/, "")}/message`;

  const payload = {
    Imei: imei,
    Message: text,
  };

  console.log("[IPCInbound] REST POST", url, "payload:", payload);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = rawText;
  }

  if (!res.ok) {
    console.error(
      "[IPCInbound] REST error",
      res.status,
      res.statusText,
      data
    );
    throw new Error(
      `IPCInbound REST /message failed: ${res.status} ${res.statusText}`
    );
  }

  console.log("[IPCInbound] REST send OK:", data);
  return data;
}

// --- IN-MEMORY DEVICES STORE ----------------------------------------

class DevicesStore {
  constructor() {
    this.devices = new Map();
  }

  getOrCreate(imei) {
    if (!this.devices.has(imei)) {
      this.devices.set(imei, {
        imei,
        label: imei,
        status: "open",
        isActiveSos: false,
        trackingEnabled: false,
        lastPosition: null,
        lastPositionAt: null,
        lastMessageAt: null,
        lastEventAt: null,
        lastSosEventAt: null,
        lastSosAckAt: null,
        messages: [],
        positions: [],
      });
    }
    return this.devices.get(imei);
  }

  ingestIpcPayload(payload) {
    const events =
      (payload && payload.Events) || payload.events || [];
    if (!Array.isArray(events)) {
      console.warn(
        "[DevicesStore] No Events array present in payload"
      );
      return;
    }

    events.forEach((evt) => this._ingestEvent(evt));

    console.log(
      `[DevicesStore] After IPC, total devices: ${this.devices.size}`
    );
  }

  _ingestEvent(evt) {
    const imei = evt.imei || evt.Imei;
    if (!imei) {
      console.warn("[DevicesStore] Event missing IMEI:", evt);
      return;
    }

    const device = this.getOrCreate(imei);

    // Timestamp
    let tsMs =
      typeof evt.timeStamp !== "undefined"
        ? evt.timeStamp
        : evt.Timestamp;
    let ts;
    if (typeof tsMs === "number" && tsMs > 0) {
      ts = new Date(tsMs);
    } else {
      // Garmin sometimes sends weird timestamps (e.g. virtual test)
      ts = new Date();
    }
    const tsIso = ts.toISOString();
    device.lastEventAt = tsIso;

    // Position
    const point = evt.point || evt.Point || {};
    const lat =
      typeof point.latitude !== "undefined"
        ? point.latitude
        : point.Latitude;
    const lon =
      typeof point.longitude !== "undefined"
        ? point.longitude
        : point.Longitude;
    const altitude =
      typeof point.altitude !== "undefined"
        ? point.altitude
        : point.Altitude;
    const speed =
      typeof point.speed !== "undefined"
        ? point.speed
        : point.Speed;
    const course =
      typeof point.course !== "undefined"
        ? point.course
        : point.Course;
    const gpsFix =
      point.gpsFix ??
      point.gps_fix ??
      point.GpsFix ??
      null;

    if (lat != null && lon != null) {
      const pos = {
        lat: Number(lat),
        lon: Number(lon),
        altitude: altitude != null ? Number(altitude) : null,
        speed: speed != null ? Number(speed) : null,
        course: course != null ? Number(course) : null,
        gpsFix,
        timestamp: tsIso,
      };

      device.lastPosition = pos;
      device.lastPositionAt = tsIso;
      device.positions.push(pos);

      // Cap history
      if (device.positions.length > 5000) {
        device.positions.splice(
          0,
          device.positions.length - 5000
        );
      }
    }

    // Message / SOS logic
    const messageCode =
      typeof evt.messageCode !== "undefined"
        ? evt.messageCode
        : evt.MessageCode;
    const freeText =
      evt.freeText || evt.FreeText || "";
    const isTrackingOnly =
      messageCode === 6 && !freeText;
    const isSosEvent = messageCode === 7;

    if (isSosEvent) {
      device.isActiveSos = true;
      device.status = "open";
      device.lastSosEventAt = tsIso;

      device.messages.push({
        id: "sos-" + ts.getTime(),
        direction: "inbound",
        text: freeText || "SOS activated",
        is_sos: true,
        timestamp: tsIso,
      });
      device.lastMessageAt = tsIso;
    } else if (!isTrackingOnly && freeText.trim().length > 0) {
      device.messages.push({
        id: "in-" + ts.getTime(),
        direction: "inbound",
        text: freeText,
        is_sos: false,
        timestamp: tsIso,
      });
      device.lastMessageAt = tsIso;
    }

    this.devices.set(imei, device);
  }

  addOutboundMessage(imei, { text, is_sos }) {
    const device = this.getOrCreate(imei);
    const tsIso = new Date().toISOString();
    device.messages.push({
      id: "out-" + Date.now(),
      direction: "outbound",
      text,
      is_sos: !!is_sos,
      timestamp: tsIso,
    });
    device.lastMessageAt = tsIso;
    this.devices.set(imei, device);
    return device;
  }

  ackSos(imei) {
    const device = this.devices.get(imei);
    if (!device) return null;
    device.isActiveSos = false;
    device.lastSosAckAt = new Date().toISOString();
    this.devices.set(imei, device);
    return device;
  }

  getAllDevices() {
    return Array.from(this.devices.values());
  }

  getDeviceDetail(imei) {
    const device = this.devices.get(imei);
    if (!device) return null;
    return {
      device,
      positions: device.positions,
      messages: device.messages,
    };
  }
}

const devicesStore = new DevicesStore();

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

// --- FRONTEND API ROUTES (ECC UI) -----------------------------------

// List all devices (flattened)
app.get(
  "/api/garmin/devices",
  authenticateApiKey,
  async (req, res) => {
    try {
      const list = devicesStore.getAllDevices();
      res.json(list);
    } catch (err) {
      console.error("[/api/garmin/devices] Error:", err);
      res.status(500).json({ error: "Failed to fetch devices" });
    }
  }
);

// Detailed view for a single device
app.get(
  "/api/garmin/devices/:imei",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const detail = devicesStore.getDeviceDetail(imei);
      if (!detail) {
        return res
          .status(404)
          .json({ error: "Device not found" });
      }
      res.json(detail);
    } catch (err) {
      console.error(
        "[GET /api/garmin/devices/:imei] Error:",
        err
      );
      res.status(500).json({
        error: "Failed to fetch device detail",
      });
    }
  }
);

// Send a message to device (and via IPCInbound REST if creds OK)
app.post(
  "/api/garmin/devices/:imei/message",
  authenticateApiKey,
  async (req, res) => {
    const imei = req.params.imei;
    const { text, is_sos } = req.body || {};

    if (!text || !text.trim()) {
      return res
        .status(400)
        .json({ error: "Message text is required" });
    }

    try {
      const outboundText = is_sos ? "SOS: " + text : text;

      // Store outbound in ECC history
      devicesStore.addOutboundMessage(imei, {
        text: outboundText,
        is_sos: !!is_sos,
      });

      // Try to send via IPCInbound REST
      try {
        const result = await callIpcInboundMessaging({
          imei,
          text: outboundText,
        });
        res.json({ ok: true, gateway: result });
      } catch (err) {
        console.error(
          "[POST /message] IPCInbound REST error:",
          err.message
        );
        // Keep message in ECC, but inform UI send failed
        res.status(500).json({
          error: "Gateway send failed",
          detail: err.message,
        });
      }
    } catch (err) {
      console.error(
        "[POST /api/garmin/devices/:imei/message] Error:",
        err
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Acknowledge SOS (local only – no Emergency.svc yet)
app.post(
  "/api/garmin/devices/:imei/ack-sos",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const device = devicesStore.ackSos(imei);
      if (!device) {
        return res
          .status(404)
          .json({ error: "Device not found" });
      }

      devicesStore.addOutboundMessage(imei, {
        text: "SOS acknowledged by MAGNUS ECC",
        is_sos: true,
      });

      res.json({ ok: true, device });
    } catch (err) {
      console.error(
        "[POST /api/garmin/devices/:imei/ack-sos] Error:",
        err
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Request location (stub – safe to call, just logs for now)
app.post(
  "/api/garmin/devices/:imei/locate",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      console.log(
        "[LOCATE] Requested manual location for",
        imei
      );
      // In future you can wire this to a specific IPCInbound endpoint.
      res.json({
        ok: true,
        note:
          "Locate request accepted locally. Implement IPCInbound locate if Garmin exposes it.",
      });
    } catch (err) {
      console.error(
        "[POST /api/garmin/devices/:imei/locate] Error:",
        err
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// --- GARMIN IPC OUTBOUND WEBHOOK (GARMIN → ECC) ---------------------

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

      devicesStore.ingestIpcPayload(body);

      // Respond quickly – Garmin expects fast 200
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[GarminOutbound] Handler error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// --- GLOBAL ERROR HANDLER -------------------------------------------

app.use((err, req, res, next) => {
  console.error("[GlobalError]", err);
  res.status(500).json({ error: "Internal server error" });
});

// --- START SERVER ----------------------------------------------------

app.listen(PORT, () => {
  console.log("Bootstrapping MAGNUS Garmin ECC backend...");
  console.log(
    `MAGNUS Garmin ECC backend running on port ${PORT}`
  );
  console.log("Active tenant ID:", ACTIVE_TENANT_ID);
});
