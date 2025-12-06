// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

// --- BASIC CONFIG ----------------------------------------------------

const app = express();
const PORT = process.env.PORT || 10000;

// Frontend origins
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Simple API key for ECC UI
const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY || "MAGNUS302010!";

// Garmin outbound token (IPC outbound → this server)
const GARMIN_OUTBOUND_TOKEN =
  process.env.GARMIN_OUTBOUND_TOKEN || "";

// --- APP MIDDLEWARE --------------------------------------------------

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

  if (!GARMIN_OUTBOUND_TOKEN) {
    console.log(
      "[GarminOutbound] ERROR: GARMIN_OUTBOUND_TOKEN not set"
    );
    return res.status(500).json({ error: "Server misconfigured" });
  }

  if (token !== GARMIN_OUTBOUND_TOKEN) {
    console.log("[GarminOutbound] Invalid token received:", token);
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[GarminOutbound] Auth OK");
  return next();
}

// --- MULTI-TENANT CONFIG (REST + SOAP) -------------------------------

function envBool(name, defaultVal = false) {
  const v = process.env[name];
  if (typeof v === "undefined") return defaultVal;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

/**
 * One entry per satdesk account.
 * Right now only satdesk22 is active.
 */
const TENANTS = {
  satdesk22: {
    rest: {
      enabled: envBool("SATDESK22_REST_ENABLED", false),
      // Should be: https://ipcinbound.inreachapp.com/api
      baseUrl: process.env.SATDESK22_REST_BASE_URL || "",
      apiKey: process.env.SATDESK22_REST_API_KEY || "",
    },
    soap: {
      // Should be: https://explore.garmin.com/IPCInbound/V1
      baseUrl: process.env.SATDESK22_INBOUND_BASE_URL || "",
      username: process.env.SATDESK22_INBOUND_USERNAME || "",
      password: process.env.SATDESK22_INBOUND_PASSWORD || "",
    },
  },

  // 🔜 FUTURE TENANTS – copy same structure:
  // satdesk01: { rest: {...}, soap: {...} },
  // satdesk02: { rest: {...}, soap: {...} },
  // etc...
};

const ACTIVE_TENANT_ID =
  process.env.ACTIVE_TENANT_ID || "satdesk22";

function getActiveTenant() {
  const tenant = TENANTS[ACTIVE_TENANT_ID];
  if (!tenant) {
    console.warn(
      "[Tenant] ACTIVE_TENANT_ID",
      ACTIVE_TENANT_ID,
      "has no config – outbound sends will be skipped"
    );
    return null;
  }
  return tenant;
}

// Build a REST url like: baseUrl + "/Messaging/Message"
function buildRestUrl(tenant, path) {
  const base = (tenant.rest.baseUrl || "").replace(/\/+$/, "");
  return base + path;
}

// Build SOAP url like: baseUrl + "/Messaging.svc/Message"
function buildSoapUrl(tenant, path) {
  const base = (tenant.soap.baseUrl || "").replace(/\/+$/, "");
  return base + path;
}

// --- IPC INBOUND: REST V2 Messaging ---------------------------------

/**
 * REST V2: POST https://ipcinbound.inreachapp.com/api/Messaging/Message
 * Headers: X-API-KEY: <REST_API_KEY>
 * Body: { Imei, Text }
 */
async function sendViaRestMessaging(tenant, { imei, text }) {
  if (
    !tenant.rest ||
    !tenant.rest.enabled ||
    !tenant.rest.baseUrl ||
    !tenant.rest.apiKey
  ) {
    console.log("[IPCInbound REST] REST not enabled or missing creds");
    return { skipped: true, reason: "rest-disabled" };
  }

  const url = buildRestUrl(tenant, "/Messaging/Message");
  const payload = {
    Imei: imei,
    Text: text,
  };

  console.log("[IPCInbound REST] POST", url, "payload:", payload);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": tenant.rest.apiKey,
    },
    body: JSON.stringify(payload),
  });

  const textBody = await res.text();
  let data = null;
  try {
    data = JSON.parse(textBody);
  } catch (_e) {
    // not JSON, keep raw
  }

  if (!res.ok) {
    console.error(
      "[IPCInbound REST] HTTP error",
      res.status,
      res.statusText,
      textBody
    );
    throw new Error(
      `IPCInbound REST /Messaging/Message failed: ${res.status} ${res.statusText}`
    );
  }

  console.log("[IPCInbound REST] OK", data || textBody);
  return data || { raw: textBody };
}

// --- IPC INBOUND: SOAP / V1 Messaging.svc ---------------------------

/**
 * SOAP-style V1 (legacy):
 * POST https://explore.garmin.com/IPCInbound/V1/Messaging.svc/Message
 * Body:
 * {
 *   Username,
 *   Password,
 *   Message: { Imei, Text, SendToInbox: true }
 * }
 */
async function sendViaSoapMessaging(tenant, { imei, text }) {
  if (
    !tenant.soap ||
    !tenant.soap.baseUrl ||
    !tenant.soap.username ||
    !tenant.soap.password
  ) {
    console.log("[IPCInbound SOAP] SOAP not configured – skipping");
    return { skipped: true, reason: "soap-disabled" };
  }

  const url = buildSoapUrl(tenant, "/Messaging.svc/Message");
  const payload = {
    Username: tenant.soap.username,
    Password: tenant.soap.password,
    Message: {
      Imei: imei,
      Text: text,
      SendToInbox: true,
    },
  };

  console.log("[IPCInbound SOAP] POST", url, "payload:", payload);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const textBody = await res.text();
  let data = null;
  try {
    data = JSON.parse(textBody);
  } catch (_e) {
    // ignore if not JSON
  }

  if (!res.ok) {
    console.error(
      "[IPCInbound SOAP] HTTP error",
      res.status,
      res.statusText,
      textBody
    );
    throw new Error(
      `IPCInbound SOAP /Messaging.svc/Message failed: ${res.status} ${res.statusText}`
    );
  }

  if (data && typeof data.Code !== "undefined" && data.Code !== 0) {
    console.error("[IPCInbound SOAP] Logical error response:", data);
    throw new Error(
      `IPCInbound SOAP /Messaging.svc/Message failed: Code=${data.Code} ${data.Message}`
    );
  }

  console.log("[IPCInbound SOAP] OK", data || textBody);
  return data || { raw: textBody };
}

// --- IPC INBOUND MAIN DISPATCH --------------------------------------

/**
 * Main function called by /api/garmin/devices/:imei/message.
 * Tries REST first, falls back to SOAP if configured.
 */
async function callIpcInboundMessaging({ imei, text }) {
  const tenant = getActiveTenant();
  if (!tenant) {
    console.warn("[IPCInbound] No active tenant – skipping outbound");
    return { skipped: true, reason: "no-tenant" };
  }

  console.log("[IPCInbound] Tenant config for send:", {
    tenantId: ACTIVE_TENANT_ID,
    restEnabled: tenant.rest?.enabled,
    restBaseUrl: tenant.rest?.baseUrl,
    restApiKeyPresent: !!tenant.rest?.apiKey,
    soapBaseUrl: tenant.soap?.baseUrl,
    soapUserPresent: !!tenant.soap?.username,
  });

  // Try REST first
  if (
    tenant.rest &&
    tenant.rest.enabled &&
    tenant.rest.baseUrl &&
    tenant.rest.apiKey
  ) {
    try {
      return await sendViaRestMessaging(tenant, { imei, text });
    } catch (err) {
      console.error(
        "[IPCInbound] REST send failed, will try SOAP if configured:",
        err.message || err
      );
    }
  }

  // Fallback to SOAP if configured
  if (
    tenant.soap &&
    tenant.soap.baseUrl &&
    tenant.soap.username &&
    tenant.soap.password
  ) {
    return await sendViaSoapMessaging(tenant, { imei, text });
  }

  console.warn(
    "[IPCInbound] No REST or SOAP credentials – skipping outbound send"
  );
  return { skipped: true, reason: "no-credentials" };
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

    // Timestamp (Garmin sometimes sends weird values, including negative)
    let tsMs =
      typeof evt.timeStamp !== "undefined"
        ? evt.timeStamp
        : evt.Timestamp;
    let ts;
    if (typeof tsMs === "number" && tsMs > 0) {
      ts = new Date(tsMs);
    } else {
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
    activeTenant: ACTIVE_TENANT_ID,
  });
});

// --- FRONTEND API ROUTES ---------------------------------------------
// These are consumed by your ECC UI (index.html)

// List all devices
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

// Detail for single device
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

// Send a message (ECC → Garmin → Device)
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
      // Store outbound in ECC history
      devicesStore.addOutboundMessage(imei, {
        text: is_sos ? "SOS: " + text : text,
        is_sos: !!is_sos,
      });

      try {
        const gateway = await callIpcInboundMessaging({
          imei,
          text: is_sos ? "SOS: " + text : text,
        });
        return res.json({ ok: true, gateway });
      } catch (gatewayErr) {
        console.error("[/message] IPCInbound error:", gatewayErr);
        return res.status(500).json({
          error: "Gateway send failed",
          detail:
            gatewayErr.message || String(gatewayErr),
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

// Acknowledge SOS (local only for now)
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

      // If you later wire Emergency.svc for ACK/CLOSE, add it here.

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

// Locate (stub)
app.post(
  "/api/garmin/devices/:imei/locate",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      console.log("[LOCATE] Manual location request for", imei);
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

// --- GARMIN IPC OUTBOUND WEBHOOK ------------------------------------
// This is configured in Garmin Pro: Portal Connect → Outbound

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
});
