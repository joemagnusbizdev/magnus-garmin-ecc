// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const https = require("https");
const { URL } = require("url");

const app = express();

// --- CONFIG ----------------------------------------------------------

const PORT = process.env.PORT || 10000;

// Comma-separated list of allowed frontends
// e.g. "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000"
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Internal API key for ECC frontend calls
const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY || "MAGNUS302010!";

// Garmin Outbound auth token – must match x-outbound-auth-token
const GARMIN_OUTBOUND_AUTH_TOKEN =
  process.env.GARMIN_OUTBOUND_AUTH_TOKEN || "";

// IPC Inbound (sending messages / future locate etc.)
const IPC_INBOUND_BASE_URL =
  process.env.IPC_INBOUND_BASE_URL ||
  "https://eur-enterprise.inreach.garmin.com/IPCInbound/V1";

const IPC_INBOUND_USERNAME =
  process.env.IPC_INBOUND_USERNAME || "MagnusDash";

const IPC_INBOUND_PASSWORD =
  process.env.IPC_INBOUND_PASSWORD || "MagnusDash1";

// --- MIDDLEWARE ------------------------------------------------------

app.set("trust proxy", true); // behind Render/Cloudflare

app.use(
  cors({
    origin(origin, callback) {
      // allow server-side tools (no Origin) + whitelisted origins
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(morgan("combined"));

// --- AUTH HELPERS ----------------------------------------------------

function authenticateApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) {
    console.warn(
      "[APIAuth] INTERNAL_API_KEY not set – /api routes are open. Set it in Render env."
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

// --- IN-MEMORY DEVICE STORE ------------------------------------------

// Shape we keep per device:
// {
//   imei,
//   label,
//   status: 'open' | 'closed',
//   isActiveSos: boolean,
//   lastPosition: {lat, lon, altitude, gpsFix, course, speed, timestamp} | null,
//   lastPositionAt: ISO | null,
//   lastMessageAt: ISO | null,
//   lastEventAt: ISO | null,
//   lastSosEventAt: ISO | null,
//   lastSosAckAt: ISO | null,
//   messages: [{ id, direction, text, is_sos, timestamp }],
//   positions: [{ lat, lon, altitude, gpsFix, course, speed, timestamp }]
// }

const devicesStore = new Map();

function normalizeTimestamp(ms) {
  if (typeof ms !== "number") return new Date().toISOString();
  // Garmin sometimes sends the "zero" date as -62135596800000
  if (ms < 0) return new Date().toISOString();
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function upsertDeviceFromIpc(evt) {
  const imeiRaw = evt.imei || evt.IMEI || "UNKNOWN";
  const imei = String(imeiRaw).trim() || "UNKNOWN";

  const tsIso = normalizeTimestamp(evt.timeStamp);
  const point = evt.point || {};
  const status = evt.status || {};
  const messageCode = evt.messageCode ?? null;

  // messageCode 7 = SOS / Emergency
  const isSos = messageCode === 7;

  let device = devicesStore.get(imei);
  if (!device) {
    device = {
      imei,
      label: imei,
      status: "open",
      isActiveSos: false,
      lastPosition: null,
      lastPositionAt: null,
      lastMessageAt: null,
      lastEventAt: null,
      lastSosEventAt: null,
      lastSosAckAt: null,
      messages: [],
      positions: [],
    };
    devicesStore.set(imei, device);
  }

  device.lastEventAt = tsIso;

  // Position update
  if (
    point &&
    typeof point.latitude === "number" &&
    typeof point.longitude === "number"
  ) {
    const pos = {
      lat: point.latitude,
      lon: point.longitude,
      altitude: typeof point.altitude === "number" ? point.altitude : null,
      gpsFix: point.gpsFix ?? 0,
      course: typeof point.course === "number" ? point.course : null,
      speed: typeof point.speed === "number" ? point.speed : null,
      timestamp: tsIso,
    };
    device.positions.push(pos);
    device.lastPosition = pos;
    device.lastPositionAt = tsIso;
  }

  // Inbound text / SOS message
  const hasText = evt.freeText && String(evt.freeText).length > 0;
  if (hasText || isSos) {
    const msgText = hasText
      ? String(evt.freeText)
      : isSos
      ? "[SOS event]"
      : "";

    const msg = {
      id: `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      direction: "inbound",
      text: msgText,
      is_sos: isSos,
      timestamp: tsIso,
    };

    device.messages.push(msg);
    device.lastMessageAt = tsIso;
  }

  // SOS state
  if (isSos) {
    device.isActiveSos = true;
    device.status = "open";
    device.lastSosEventAt = tsIso;
  }

  console.log(
    `[DevicesStore] Upserted device ${imei}. Total devices: ${devicesStore.size}`
  );
}

// --- IPC INBOUND: SEND MESSAGE HELPER --------------------------------

function sendTextMessageToGarmin({ imei, text }) {
  return new Promise((resolve, reject) => {
    try {
      const base = IPC_INBOUND_BASE_URL || "";
      const full =
        base.endsWith("/")
          ? `${base}Messaging.svc/Text`
          : `${base}/Messaging.svc/Text`;

      const url = new URL(full);

      const recipient =
        /^\d+$/.test(String(imei)) ? Number(imei) : String(imei);

      const payload = {
        Messages: [
          {
            MessageText: text,
            Recipients: [recipient],
            Sender: "MAGNUS ECC",
            Timestamp: new Date().toISOString(),
          },
        ],
      };

      const body = JSON.stringify(payload);

      const authString = `${IPC_INBOUND_USERNAME}:${IPC_INBOUND_PASSWORD}`;
      const headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      };

      // Basic auth if we have creds
      if (IPC_INBOUND_USERNAME && IPC_INBOUND_PASSWORD) {
        headers.Authorization =
          "Basic " + Buffer.from(authString, "utf8").toString("base64");
      }

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers,
      };

      console.log(
        "[Messaging] Sending text message to Garmin:",
        options.hostname + options.path
      );

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          console.log(
            "[Messaging] Garmin response:",
            res.statusCode,
            data.slice(0, 500)
          );
          // Garmin may return XML or JSON; we just pass raw back up
          resolve({ statusCode: res.statusCode, body: data });
        });
      });

      req.on("error", (err) => {
        console.error("[Messaging] HTTPS error:", err);
        reject(err);
      });

      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// --- FRONTEND API ROUTES ---------------------------------------------

// List devices for ECC UI
app.get("/api/garmin/devices", authenticateApiKey, async (req, res) => {
  try {
    const list = Array.from(devicesStore.values()).map((d) => {
      const {
        messages,
        positions,
        ...summary
      } = d;
      return summary;
    });
    res.json(list);
  } catch (err) {
    console.error("[/api/garmin/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// Single device detail (for chat, track etc.)
app.get(
  "/api/garmin/devices/:imei",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = String(req.params.imei).trim();
      const device = devicesStore.get(imei);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }
      res.json(device);
    } catch (err) {
      console.error("[/api/garmin/devices/:imei] Error:", err);
      res.status(500).json({ error: "Failed to fetch device detail" });
    }
  }
);

// Send a text message TO the device (IPC Inbound)
app.post(
  "/api/garmin/devices/:imei/message",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = String(req.params.imei).trim();
      const { text } = req.body || {};

      if (!text || !String(text).trim()) {
        return res.status(400).json({ error: "Missing message text" });
      }

      const tsIso = new Date().toISOString();

      // Call Garmin IPC Inbound Messaging.svc/Text
      const garminResp = await sendTextMessageToGarmin({ imei, text });

      let device = devicesStore.get(imei);
      if (!device) {
        device = {
          imei,
          label: imei,
          status: "open",
          isActiveSos: false,
          lastPosition: null,
          lastPositionAt: null,
          lastMessageAt: null,
          lastEventAt: null,
          lastSosEventAt: null,
          lastSosAckAt: null,
          messages: [],
          positions: [],
        };
        devicesStore.set(imei, device);
      }

      const msg = {
        id: `out-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
        direction: "outbound",
        text: String(text),
        is_sos: false,
        timestamp: tsIso,
      };

      device.messages.push(msg);
      device.lastMessageAt = tsIso;
      device.lastEventAt = tsIso;

      res.json({
        ok: true,
        garmin: garminResp,
        device,
      });
    } catch (err) {
      console.error("[/api/garmin/devices/:imei/message] Error:", err);
      res.status(502).json({
        error: "Failed to send message to Garmin",
        detail: err.message || String(err),
      });
    }
  }
);

// Acknowledge SOS (local only for now)
app.post(
  "/api/garmin/devices/:imei/ack-sos",
  authenticateApiKey,
  async (req, res) => {
    try {
      const imei = String(req.params.imei).trim();
      const device = devicesStore.get(imei);
      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }

      const tsIso = new Date().toISOString();
      device.isActiveSos = false;
      device.lastSosAckAt = tsIso;

      device.messages.push({
        id: `ack-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
        direction: "outbound",
        text: "SOS acknowledged by MAGNUS ECC",
        is_sos: true,
        timestamp: tsIso,
      });

      res.json({ ok: true, device });
    } catch (err) {
      console.error("[/api/garmin/devices/:imei/ack-sos] Error:", err);
      res.status(500).json({ error: "Failed to acknowledge SOS" });
    }
  }
);

// (Optional) locate endpoint stub – not wired to IPC yet
app.post(
  "/api/garmin/devices/:imei/locate",
  authenticateApiKey,
  async (req, res) => {
    // TODO: Implement Device.svc/Locate if/when needed
    res.json({ ok: false, message: "Locate not implemented yet" });
  }
);

// --- GARMIN IPC OUTBOUND WEBHOOK -------------------------------------

// This is the URL you configured in Garmin as IPC outbound
// e.g. https://magnus-garmin-ecc.onrender.com/garmin/ipc-outbound
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

      const events = (body && body.Events) || [];

      if (!Array.isArray(events) || events.length === 0) {
        console.log("[GarminOutbound] No Events in payload");
      } else {
        for (const evt of events) {
          upsertDeviceFromIpc(evt);
        }
      }

      console.log(
        "[DevicesStore] After IPC, total devices:",
        devicesStore.size
      );

      // Always respond quickly so Garmin is happy
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[GarminOutbound] Handler error:", err);
      res.status(500).json({ error: "Internal server error" });
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
