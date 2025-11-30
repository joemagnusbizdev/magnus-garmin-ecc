// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------

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
  process.env.GARMIN_OUTBOUND_TOKEN ||
  process.env.GARMIN_OUTBOUND_AUTH_TOKEN ||
  "";

// ---------- TENANT CONFIG (multi-account scaffold) -------------------

// Right now only satdesk22 is wired. Others are placeholders.
const TENANTS = {
  satdesk22: {
    id: "satdesk22",

    // REST (preferred, if enabled)
    restEnabled:
      String(process.env.SATDESK22_REST_ENABLED || "").toLowerCase() === "true",
    restBaseUrl: process.env.SATDESK22_REST_BASE_URL || "",
    restApiKey: process.env.SATDESK22_REST_API_KEY || "",

    // SOAP / legacy IPCInbound (fallback / compatibility)
    soapUsername: process.env.SATDESK22_INBOUND_USERNAME || "",
    soapPassword: process.env.SATDESK22_INBOUND_PASSWORD || "",
    soapBaseUrl: process.env.SATDESK22_INBOUND_BASE_URL || "",
  },

  // When Garmin activates more accounts, copy this pattern:
  // satdesk01: {
  //   id: "satdesk01",
  //   restEnabled:
  //     String(process.env.SATDESK01_REST_ENABLED || "").toLowerCase() === "true",
  //   restBaseUrl: process.env.SATDESK01_REST_BASE_URL || "",
  //   restApiKey: process.env.SATDESK01_REST_API_KEY || "",
  //   soapUsername: process.env.SATDESK01_INBOUND_USERNAME || "",
  //   soapPassword: process.env.SATDESK01_INBOUND_PASSWORD || "",
  //   soapBaseUrl: process.env.SATDESK01_INBOUND_BASE_URL || "",
  // },
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
    console.log("[Tenant] Active tenant:", ACTIVE_TENANT_ID);
  }
  return tenant;
}

// ---------------------------------------------------------------------
// MIDDLEWARE
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// AUTH HELPERS
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// IPC INBOUND (REST + SOAP)
// ---------------------------------------------------------------------

function buildSoapUrl(tenant, path) {
  return (tenant.soapBaseUrl || "").replace(/\/+$/, "") + path;
}

function buildRestUrl(tenant, path) {
  return (tenant.restBaseUrl || "").replace(/\/+$/, "") + path;
}

// REST: /message endpoint
async function callIpcRestMessage(tenant, { imei, text, isSos }) {
  if (
    !tenant.restEnabled ||
    !tenant.restBaseUrl ||
    !tenant.restApiKey
  ) {
    console.log("[IPCInbound REST] REST not enabled for tenant – skipping outbound send");
    return { skipped: true, reason: "rest-disabled" };
  }

  const url = buildRestUrl(tenant, "/message"); // https://ipcinbound.inreachapp.com/api/message
  const payload = {
    Imei: imei,
    Text: text,
    SendToInbox: true,
  };

  console.log("[IPCInbound REST] POST", url, "payload:", payload);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": tenant.restApiKey,
    },
    body: JSON.stringify(payload),
  });

  const textBody = await res.text();
  let data = null;
  try {
    data = JSON.parse(textBody);
  } catch (_) {
    // ignore non-JSON bodies
  }

  if (!res.ok) {
    console.error(
      "[IPCInbound REST] HTTP error",
      res.status,
      res.statusText,
      data || textBody
    );
    throw new Error(
      `IPCInbound REST /message failed: ${res.status} ${
        (data && (data.Message || data.message)) || res.statusText
      }`
    );
  }

  console.log("[IPCInbound REST] Message sent OK", { imei });
  return data || { ok: true };
}

// SOAP / legacy: Messaging.svc/Message
async function callIpcSoapMessage(tenant, { imei, text, isSos }) {
  if (!tenant.soapUsername || !tenant.soapPassword || !tenant.soapBaseUrl) {
    console.log("[IPCInbound SOAP] Missing credentials – skipping outbound send");
    return { skipped: true, reason: "soap-missing-credentials" };
  }

  const url = buildSoapUrl(tenant, "/Messaging.svc/Message");
  const payload = {
    Username: tenant.soapUsername,
    Password: tenant.soapPassword,
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
  } catch (_) {
    // Not JSON, ignore
  }

  if (!res.ok) {
    console.error(
      "[IPCInbound SOAP] HTTP error",
      res.status,
      res.statusText,
      data || textBody
    );
    throw new Error(
      `IPCInbound SOAP /Messaging.svc/Message failed: ${res.status} ${
        (data && data.Message) || res.statusText
      }`
    );
  }

  if (data && typeof data.Code !== "undefined" && data.Code !== 0) {
    console.error("[IPCInbound SOAP] Logical error response:", data);
    throw new Error(
      `IPCInbound SOAP /Messaging.svc/Message failed: Code=${data.Code} ${data.Message}`
    );
  }

  console.log("[IPCInbound SOAP] Message sent OK", { imei });
  return data || { ok: true };
}

/**
 * Main wrapper: choose REST if enabled, otherwise fallback to SOAP.
 */
async function callIpcInboundMessaging({ imei, text, isSos }) {
  const tenant = getActiveTenant();
  if (!tenant) {
    console.warn("[IPCInbound] No active tenant – skipping outbound send");
    return { skipped: true, reason: "no-tenant" };
  }

  console.log("[IPCInbound] Tenant config for send:", {
    tenantId: tenant.id,
    baseUrl: tenant.restBaseUrl || tenant.soapBaseUrl,
    restEnabled: tenant.restEnabled,
    restKeyPresent: !!tenant.restApiKey,
    soapUserPresent: !!tenant.soapUsername,
    soapPassPresent: !!tenant.soapPassword,
  });

  // 1) Try REST first if enabled
  if (tenant.restEnabled && tenant.restBaseUrl && tenant.restApiKey) {
    try {
      const resp = await callIpcRestMessage(tenant, { imei, text, isSos });
      return resp;
    } catch (err) {
      console.error("[IPCInbound] REST send failed, attempting SOAP fallback:", err.message);
      // fall through to SOAP
    }
  }

  // 2) Fallback to SOAP
  if (tenant.soapUsername && tenant.soapPassword && tenant.soapBaseUrl) {
    const resp = await callIpcSoapMessage(tenant, { imei, text, isSos });
    return resp;
  }

  console.warn("[IPCInbound] No REST or SOAP credentials enabled – skipping outbound send");
  return { skipped: true, reason: "missing-credentials" };
}

// ---------------------------------------------------------------------
// IN-MEMORY DEVICES STORE
// ---------------------------------------------------------------------

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
        closedAt: null,
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
      console.warn("[DevicesStore] No Events array present in payload");
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
    const freeText = evt.freeText || evt.FreeText || "";
    const isTrackingOnly =
      messageCode === 6 && !freeText;
    const isSosEvent = messageCode === 7; // we may refine once we see more SOS payloads

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

  closeIncident(imei) {
    const device = this.devices.get(imei);
    if (!device) return null;
    device.status = "closed";
    device.isActiveSos = false;
    const nowIso = new Date().toISOString();
    device.lastSosAckAt = device.lastSosAckAt || nowIso;
    device.closedAt = nowIso;
    this.devices.set(imei, device);
    return device;
  }

  toggleTracking(imei, enabled) {
    const device = this.getOrCreate(imei);
    device.trackingEnabled = !!enabled;
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

// ---------------------------------------------------------------------
// HEALTHCHECK
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// FRONTEND API ROUTES  (ECC UI)
// ---------------------------------------------------------------------

// List all devices (flattened)
app.get(
  "/api/garmin/devices",
  authenticateApiKey,
  async (req, res) => {
    try {
      const list = devicesStore.getAllDevices();
      res.json(list);
    } catch (err) {
      console.error("[GET /api/garmin/devices] Error:", err);
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

// Send a message to device (via REST/SOAP + local history)
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

    const finalText = is_sos ? "SOS: " + text : text;

    try {
      // Store outbound in ECC history
      devicesStore.addOutboundMessage(imei, {
        text: finalText,
        is_sos: !!is_sos,
      });

      // Try to send via IPCInbound (REST preferred, SOAP fallback)
      try {
        const result = await callIpcInboundMessaging({
          imei,
          text: finalText,
          isSos: !!is_sos,
        });
        res.json({ ok: true, gateway: result });
      } catch (err) {
        console.error(
          "[POST /message] IPCInbound error:",
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

      const detail = devicesStore.getDeviceDetail(imei);
      res.json({ ok: true, device, detail });
    } catch (err) {
      console.error(
        "[POST /api/garmin/devices/:imei/ack-sos] Error:",
        err
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Close incident (local state only – can wire to Emergency.svc later)
app.post(
  "/api/garmin/devices/:imei/close",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const device = devicesStore.closeIncident(imei);
      if (!device) {
        return res
          .status(404)
          .json({ error: "Device not found" });
      }

      const detail = devicesStore.getDeviceDetail(imei);
      res.json(detail);
    } catch (err) {
      console.error(
        "[POST /api/garmin/devices/:imei/close] Error:",
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
      console.log("[LOCATE] Requested manual location for", imei);
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

// Tracking toggle (local-only flag right now)
app.post(
  "/api/garmin/devices/:imei/tracking",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = req.params.imei;
      const { enabled } = req.body || {};
      const device = devicesStore.toggleTracking(imei, !!enabled);
      if (!device) {
        return res
          .status(404)
          .json({ error: "Device not found" });
      }
      res.json({ ok: true, trackingEnabled: !!device.trackingEnabled });
    } catch (err) {
      console.error(
        "[POST /api/garmin/devices/:imei/tracking] Error:",
        err
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ---------------------------------------------------------------------
// GARMIN IPC OUTBOUND WEBHOOK  (Garmin → this server)
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// GLOBAL ERROR HANDLER
// ---------------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error("[GlobalError]", err);
  res.status(500).json({ error: "Internal server error" });
});

// ---------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------

app.listen(PORT, () => {
  console.log("Bootstrapping MAGNUS Garmin ECC backend...");
  console.log(
    `MAGNUS Garmin ECC backend running on port ${PORT}`
  );
});
