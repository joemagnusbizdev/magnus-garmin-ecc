// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

// --- BASIC CONFIG ----------------------------------------------------

const app = express();
const PORT = process.env.PORT || 10000;

// Frontend auth key (ECC UI -> this backend)
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "MAGNUS302010!";

// CORS whitelist
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Outbound token (Garmin → this backend, IPC outbound webhook)
const GARMIN_OUTBOUND_AUTH_TOKEN =
  process.env.GARMIN_OUTBOUND_AUTH_TOKEN ||
  process.env.GARMIN_OUTBOUND_TOKEN ||
  "";

// --- TENANTS (MULTI-ACCOUNT) ----------------------------------------
// We start with just satdesk22 but structure is ready for more.

const TENANTS = {
  satdesk22: {
    id: "satdesk22",

    // SOAP (legacy) – only used as fallback when REST not configured
    soapBaseUrl:
      process.env.SATDESK22_INBOUND_BASE_URL ||
      process.env.IPC_INBOUND_BASE_URL ||
      "https://eur-enterprise.inreach.garmin.com/IPCInbound/V1",
    soapUsername:
      process.env.SATDESK22_INBOUND_USERNAME ||
      process.env.IPC_INBOUND_USERNAME ||
      "",
    soapPassword:
      process.env.SATDESK22_INBOUND_PASSWORD ||
      process.env.IPC_INBOUND_PASSWORD ||
      "",

    // REST (modern, what we want to use now)
    restBaseUrl:
      process.env.SATDESK22_REST_BASE_URL ||
      "https://ipcinbound.inreachapp.com/api",
    restApiKey: process.env.SATDESK22_REST_API_KEY || "",

    // Future: you could have per-tenant outbound token if needed
    outboundToken: GARMIN_OUTBOUND_AUTH_TOKEN,
  },
};

// Which tenant is “live” for outbound sends right now
const ACTIVE_TENANT_ID =
  process.env.ACTIVE_TENANT_ID || "satdesk22";

// --- IPC INBOUND REST (Messaging /Message) -----------------------------

function getActiveTenant() {
  const tenant = TENANTS[ACTIVE_TENANT_ID];
  if (!tenant) {
    console.warn(
      "[Tenant] ACTIVE_TENANT_ID",
      ACTIVE_TENANT_ID,
      "has no config – outbound sends will be skipped"
    );
  }
  return tenant;
}

/**
 * Send a normal text message via IPC Inbound REST /Message
 * Docs: POST /Message with Messages[ { Recipients, Sender, Timestamp, Message } ]
 */
async function callIpcInboundRestMessage({ imei, text }) {
  const tenant = getActiveTenant();
  if (!tenant || !tenant.rest || !tenant.rest.enabled) {
    console.warn(
      "[IPCInbound REST] REST not enabled for tenant – skipping outbound send"
    );
    return { skipped: true, reason: "rest-disabled" };
  }

  const baseUrl = (tenant.rest.baseUrl || "").replace(/\/+$/, "");
  const apiKey = tenant.rest.apiKey;

  if (!baseUrl || !apiKey) {
    console.warn("[IPCInbound REST] Missing baseUrl or apiKey – skipping send");
    return { skipped: true, reason: "missing-credentials" };
  }

  const url = baseUrl + "/Message";

  // Garmin wants /Date(ms)/ JSON timestamp
  const nowMs = Date.now();
  const jsonDate = `\\/Date(${nowMs})\\/`;

  const sender =
    tenant.rest.senderEmail ||
    tenant.rest.sender ||
    "ops@magnus.co.il"; // fallback – can tweak

  const payload = {
    Messages: [
      {
        Recipients: [imei],
        Sender: sender,
        Timestamp: jsonDate,
        Message: text,
      },
    ],
  };

  console.log("[IPCInbound REST] POST", url, "payload:", payload);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const rawBody = await res.text();
  let data = null;
  try {
    data = JSON.parse(rawBody);
  } catch (_) {
    // not JSON, ignore
  }

  if (!res.ok) {
    console.error(
      "[IPCInbound REST] HTTP error",
      res.status,
      res.statusText,
      rawBody
    );

    const garminCode = data && data.Code;
    const garminMsg = data && data.Message;
    const garminDesc = data && data.Description;

    throw new Error(
      `IPCInbound REST /Message failed: ${res.status} ${res.statusText}` +
        (garminCode != null
          ? ` (Code ${garminCode}: ${garminMsg || ""} - ${garminDesc || ""})`
          : ` – Body: ${rawBody}`)
    );
  }

  console.log("[IPCInbound REST] Message sent OK:", data);
  return data;
}

// --- MIDDLEWARE ------------------------------------------------------

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

// --- HELPERS: FRONTEND AUTH -----------------------------------------

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

// --- HELPERS: GARMIN OUTBOUND AUTH ----------------------------------

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

// --- IPC INBOUND (GARMIN REST + SOAP) -------------------------------

/**
 * REST v2 – POST /Emergency/SendMessage
 *
 * From Garmin docs:
 *   URL: https://ipcinbound.inreachapp.com/api/Emergency/SendMessage
 *   Body:
 *   {
 *     "IMEI": "tenant-imei",
 *     "UtcTimeStamp": "2024-04-07T21:28:24.968Z",
 *     "Message": "Text..."
 *   }
 *   Header: x-api-key: <your IPC Inbound API key>
 */
async function callIpcInboundMessagingRest(tenant, { imei, text }) {
  const base = (tenant.restBaseUrl || "").replace(/\/+$/, "");
  const url = base + "/Emergency/SendMessage";

  const payload = {
    IMEI: String(imei),
    UtcTimeStamp: new Date().toISOString(),
    Message: text,
  };

  console.log("[IPCInbound REST] POST", url, {
    tenantId: tenant.id,
    imei: payload.IMEI,
    timestamp: payload.UtcTimeStamp,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": tenant.restApiKey,
    },
    body: JSON.stringify(payload),
  });

  const rawBody = await res.text();
  let data = null;
  try {
    data = rawBody ? JSON.parse(rawBody) : null;
  } catch (_) {
    // empty or non-JSON body on 200 is fine
  }

  if (!res.ok) {
    console.error(
      "[IPCInbound REST] HTTP error",
      res.status,
      res.statusText,
      data || rawBody
    );
    throw new Error(
      `IPCInbound REST /Emergency/SendMessage failed: ${res.status} ${res.statusText}`
    );
  }

  // Error payloads from Garmin use Code / Message etc.
  if (data && typeof data.Code !== "undefined" && data.Code !== 0) {
    console.error("[IPCInbound REST] Logical error:", data);
    throw new Error(
      `IPCInbound REST /Emergency/SendMessage failed: Code=${data.Code} ${data.Message}`
    );
  }

  console.log("[IPCInbound REST] Message sent OK", {
    imei,
    status: res.status,
  });

  return {
    ok: true,
    mode: "rest",
    httpStatus: res.status,
    body: data,
  };
}

/**
 * SOAP-style JSON over /Messaging.svc/Message
 * (legacy path, used only if REST isn't configured)
 */
async function callIpcInboundMessagingSoap(tenant, { imei, text }) {
  if (!tenant.soapUsername || !tenant.soapPassword) {
    console.warn(
      "[IPCInbound SOAP] Username/password not set – skipping"
    );
    return { skipped: true, reason: "missing-soap-credentials" };
  }

  const base = (tenant.soapBaseUrl || "").replace(/\/+$/, "");
  const url = base + "/Messaging.svc/Message";

  const payload = {
    Username: tenant.soapUsername,
    Password: tenant.soapPassword,
    Message: {
      Imei: imei,
      Text: text,
      SendToInbox: true,
    },
  };

  console.log("[IPCInbound SOAP] POST", url, {
    tenantId: tenant.id,
    imei,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const rawBody = await res.text();
  let data = null;
  try {
    data = rawBody ? JSON.parse(rawBody) : null;
  } catch (_) {}

  if (!res.ok) {
    console.error(
      "[IPCInbound SOAP] HTTP error",
      res.status,
      res.statusText,
      data || rawBody
    );
    throw new Error(
      `IPCInbound SOAP /Messaging.svc/Message failed: ${res.status} ${res.statusText}`
    );
  }

  if (data && typeof data.Code !== "undefined" && data.Code !== 0) {
    console.error("[IPCInbound SOAP] Logical error:", data);
    throw new Error(
      `IPCInbound SOAP /Messaging.svc/Message failed: Code=${data.Code} ${data.Message}`
    );
  }

  console.log("[IPCInbound SOAP] Message sent OK", { imei });
  return { ok: true, mode: "soap", data };
}

/**
 * Unified outbound send: prefer REST, fallback to SOAP, otherwise skip.
 */
async function callIpcInboundMessaging({ imei, text }) {
  const tenant = getActiveTenant();
  if (!tenant) {
    console.warn("[IPCInbound] No active tenant – skipping send");
    return { skipped: true, reason: "no-tenant" };
  }

  const hasRest = !!(tenant.restBaseUrl && tenant.restApiKey);
  const hasSoap =
    !!tenant.soapBaseUrl &&
    !!tenant.soapUsername &&
    !!tenant.soapPassword;

  console.log("[IPCInbound] Tenant config for send:", {
    tenantId: tenant.id,
    baseUrl: tenant.restBaseUrl || tenant.soapBaseUrl,
    restBaseUrl: tenant.restBaseUrl,
    apiKeyPresent: !!tenant.restApiKey,
    soapUsernamePresent: !!tenant.soapUsername,
    soapPasswordPresent: !!tenant.soapPassword,
  });

  if (hasRest) {
    return callIpcInboundMessagingRest(tenant, { imei, text });
  }

  if (hasSoap) {
    return callIpcInboundMessagingSoap(tenant, { imei, text });
  }

  console.warn(
    "[IPCInbound] Missing REST and SOAP credentials – skipping outbound send"
  );
  return { skipped: true, reason: "missing-credentials" };
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
      // Sometimes Garmin sends weird timestamps; fall back to now
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
    activeTenant: ACTIVE_TENANT_ID,
  });
});

// --- FRONTEND API ROUTES --------------------------------------------

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
      // store outbound in ECC history
      devicesStore.addOutboundMessage(imei, {
        text: is_sos ? "SOS: " + text : text,
        is_sos: !!is_sos,
      });

       try {
    const result = await callIpcInboundRestMessage({
      imei,
      text: is_sos ? "SOS: " + text : text,
    });
    res.json({ ok: true, gateway: result });
  } catch (err) {
    console.error(
      "[POST /message] IPCInbound REST error:",
      err.message
    );
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

      // If you later wire /Emergency/AcknowledgeDeclareEmergency, call it here.

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
      // In future: wire to /Location/SendLocationRequest
      res.json({
        ok: true,
        note:
          "Locate request accepted locally. Implement /Location/SendLocationRequest if needed.",
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

app.post(
  "/garmin/ipc-outbound",
  authenticateGarminOutbound,
  async (req, res) => {
    try {
      const { headers, body } = req;

      console.log("HEADERS FROM GARMIN:", {
        host: headers.host,
        "user-agent": headers["user-agent"],
        "content-length": headers["contf=ent-length"],
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
  console.log("Active tenant:", ACTIVE_TENANT_ID);
});
