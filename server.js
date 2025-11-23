// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();

// --- CONFIG ----------------------------------------------------------

const PORT = process.env.PORT || 10000;

// Comma-separated list of allowed frontends
// e.g. "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Simple API key for your internal frontend calls (devices, map, etc.)
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";

// Garmin outbound auth token – must match what Garmin sends in x-outbound-auth-token
// Example (from your test): EDF01295
const GARMIN_OUTBOUND_AUTH_TOKEN = process.env.GARMIN_OUTBOUND_AUTH_TOKEN || "";

// --- IN-MEMORY DEVICE STORE -----------------------------------------

/**
 * Very simple in-memory store:
 *  Map<imei, {
 *    imei, label, status, isActiveSos,
 *    lastPosition, lastPositionAt,
 *    lastMessageAt, lastEventAt,
 *    lastSosEventAt, lastSosAckAt,
 *    messages[], positions[]
 *  }>
 */
const devicesStore = new Map();

/**
 * Try to normalize a Garmin IPC payload into our device model
 * `body` is the JSON Garmin posts to /garmin/ipc-outbound
 */
function upsertDeviceFromIpc(body) {
  const events = Array.isArray(body?.Events) ? body.Events : [];
  if (events.length === 0) {
    console.log("[DevicesStore] No Events in payload");
    return;
  }

  events.forEach((ev, idx) => {
    // --- IMEI detection (try multiple common paths) ------------------
    let imei =
      ev.DeviceImei ||
      ev.deviceImei ||
      ev?.Device?.Imei ||
      ev?.Device?.IMEI ||
      body.DeviceImei ||
      body.Imei ||
      null;

    if (!imei) {
      imei = "VIRTUAL-TEST";
      console.log(
        `[DevicesStore] No IMEI in event[${idx}] – falling back to`,
        imei
      );
    }

    const now = new Date().toISOString();

    const existing = devicesStore.get(imei) || {
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

    // --- generic "this device had an event" timestamp ----------------
    existing.lastEventAt = now;

    // --- SOS detection -----------------------------------------------
    const type = ev.EventType || ev.Type || "";
    const typeStr = (typeof type === "string" ? type : "").toLowerCase();
    const isSosEvent = typeStr.includes("sos");

    if (isSosEvent) {
      existing.isActiveSos = true;
      existing.lastSosEventAt = now;
    }

    // --- Position parsing (best-effort guesses) ----------------------
    const pos = ev.Position || ev.PositionInfo || ev.Location || null;
    if (pos) {
      const lat =
        pos.Latitude ??
        pos.latitude ??
        pos.Lat ??
        pos.lat ??
        null;
      const lon =
        pos.Longitude ??
        pos.longitude ??
        pos.Lon ??
        pos.lon ??
        null;

      if (lat != null && lon != null) {
        const ts =
          pos.Timestamp ||
          pos.Time ||
          ev.Timestamp ||
          ev.EventTime ||
          now;

        const p = {
          lat: Number(lat),
          lon: Number(lon),
          timestamp: ts,
          gpsFix: true,
        };

        existing.lastPosition = p;
        existing.lastPositionAt = ts;
        existing.positions = existing.positions || [];
        existing.positions.push(p);
      }
    }

    // --- Message parsing (if present) --------------------------------
    if (ev.MessageText || ev.Message || ev.Text) {
      const text = ev.MessageText || ev.Message || ev.Text;
      const dirRaw = ev.Direction || "";
      const ts =
        ev.Timestamp || ev.MessageTime || ev.EventTime || now;

      const msg = {
        direction: dirRaw.toLowerCase().includes("out")
          ? "outbound"
          : "inbound",
        text,
        timestamp: ts,
        is_sos: isSosEvent,
      };

      existing.lastMessageAt = ts;
      existing.messages = existing.messages || [];
      existing.messages.push(msg);
    }

    devicesStore.set(imei, existing);
    console.log(
      "[DevicesStore] Upserted device",
      imei,
      "Total devices:",
      devicesStore.size
    );
  });
}

// --- MIDDLEWARE ------------------------------------------------------

app.set("trust proxy", true); // because you're behind Render/Cloudflare

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

function authenticateApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) {
    console.warn(
      "[APIAuth] INTERNAL_API_KEY not set – all /api routes are open. Set it in Render env."
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

// --- FRONTEND API ROUTES ---------------------------------------------
// ECC UI will call these from blog.magnusafety.com

// LIST DEVICES (used by ECC sidebar + map)
app.get("/api/garmin/devices", authenticateApiKey, (req, res) => {
  const devices = Array.from(devicesStore.values());
  res.json(devices); // bare array – your frontend normalizes this
});

// MAP DEVICES (if you want a lighter payload later)
app.get("/api/garmin/map/devices", authenticateApiKey, (req, res) => {
  const devices = Array.from(devicesStore.values()).map((d) => ({
    imei: d.imei,
    label: d.label,
    status: d.status,
    isActiveSos: d.isActiveSos,
    lastPosition: d.lastPosition,
    lastPositionAt: d.lastPositionAt,
  }));
  res.json(devices);
});

// --- GARMIN IPC OUTBOUND ENDPOINT ------------------------------------
// This is the URL you gave Garmin as the IPC outbound webhook
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
        "[GarminOutbound] Received IPC payload, top-level keys:",
        body && Object.keys(body)
      );

      // ⬇️ NEW: store into in-memory devices for ECC
      upsertDeviceFromIpc(body);

      // For Garmin: always respond 200 quickly
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
