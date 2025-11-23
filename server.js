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

// --- IN-MEMORY DEVICE STORE ------------------------------------------
// NOTE: In production you’ll want a real DB. For now this lets the ECC show data.
const devicesStore = new Map();

/**
 * Normalize a Garmin IPC payload into our ECC device shape and upsert it.
 * This is intentionally defensive and tries multiple common field names.
 */
function upsertDeviceFromGarminPayload(payload) {
  if (!payload) {
    console.log("[DevicesStore] No payload body – nothing to upsert");
    return;
  }

  // Try a bunch of possible places to find an IMEI / device ID
  const imei =
    payload.IMEI ||
    payload.imei ||
    payload.deviceImei ||
    payload.esn ||
    payload.deviceId ||
    (payload.device && (payload.device.IMEI || payload.device.imei));

  let deviceId = imei;

  // If we truly have no identifier (e.g. some virtual tests), still create a visible test device
  if (!deviceId) {
    console.log("[DevicesStore] No IMEI in payload – using VIRTUAL-TEST");
    deviceId = "VIRTUAL-TEST";
  }

  const nowIso = new Date().toISOString();

  // Try to extract a human label / name
  const label =
    payload.deviceName ||
    (payload.device && payload.device.name) ||
    (payload.device && payload.device.label) ||
    "Garmin Device";

  // Try to find position fields in various common shapes
  let lat = null;
  let lon = null;
  let posTime = null;

  if (typeof payload.Latitude === "number" && typeof payload.Longitude === "number") {
    // Style: { Latitude, Longitude, ReceiveTimeUTC }
    lat = payload.Latitude;
    lon = payload.Longitude;
    posTime = payload.ReceiveTimeUTC || payload.MessageUTC || nowIso;
  } else if (
    payload.position &&
    typeof payload.position.lat === "number" &&
    typeof payload.position.lon === "number"
  ) {
    // Style: { position: { lat, lon, timestamp } }
    lat = payload.position.lat;
    lon = payload.position.lon;
    posTime = payload.position.timestamp || payload.position.time || nowIso;
  } else if (
    payload.Position &&
    typeof payload.Position.Latitude === "number" &&
    typeof payload.Position.Longitude === "number"
  ) {
    // Style: { Position: { Latitude, Longitude, TimeUTC } }
    lat = payload.Position.Latitude;
    lon = payload.Position.Longitude;
    posTime = payload.Position.TimeUTC || nowIso;
  }

  const existing = devicesStore.get(deviceId) || {
    imei: deviceId,
    label,
    status: "open",
    isActiveSos: false,
    lastPosition: null,
    lastPositionAt: null,
    lastMessageAt: null,
    lastEventAt: null,
    lastSosEventAt: null,
    lastSosAckAt: null,
  };

  // Basic event bookkeeping
  existing.label = label || existing.label;
  existing.lastEventAt = nowIso;

  // If we got a position, update that too
  if (lat != null && lon != null) {
    existing.lastPosition = {
      lat,
      lon,
      timestamp: posTime || nowIso,
      gpsFix: true,
    };
    existing.lastPositionAt = posTime || nowIso;
  }

  // Very rough SOS detection – you can refine this once you see real payloads
  const messageType =
    payload.MessageType || payload.messageType || payload.eventType;
  const isSos =
    String(messageType || "").toUpperCase().includes("SOS") ||
    (payload.isSos === true || payload.is_sos === true);

  if (isSos) {
    existing.isActiveSos = true;
    existing.lastSosEventAt = nowIso;
  }

  devicesStore.set(deviceId, existing);
  console.log(
    `[DevicesStore] Upserted device ${deviceId}. Total devices: ${devicesStore.size}`
  );
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

// --- HELPER MIDDLEWARE -----------------------------------------------

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
  // Express lowercases header names; use req.get() which is case-insensitive
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
// These are what your map/frontend will call (from blog.magnusafety.com etc.)

// List devices for ECC
app.get("/api/garmin/devices", authenticateApiKey, async (req, res) => {
  try {
    const devices = Array.from(devicesStore.values());

    // Optional: if truly nothing yet, return a dummy device so UI isn't empty
    if (!devices.length) {
      const now = new Date().toISOString();
      const testDevice = {
        imei: "VIRTUAL-TEST",
        label: "Garmin Virtual Test (no real data yet)",
        status: "open",
        isActiveSos: false,
        lastPosition: {
          lat: 32.0853,
          lon: 34.7818,
          timestamp: now,
          gpsFix: true,
        },
        lastPositionAt: now,
        lastMessageAt: null,
        lastEventAt: now,
        lastSosEventAt: null,
        lastSosAckAt: null,
      };
      return res.json([testDevice]);
    }

    res.json(devices);
  } catch (err) {
    console.error("[/api/garmin/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// Devices for map overlay – reuse the same store
app.get("/api/garmin/map/devices", authenticateApiKey, async (req, res) => {
  try {
    const devices = Array.from(devicesStore.values());
    res.json({ devices });
  } catch (err) {
    console.error("[/api/garmin/map/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch map devices" });
  }
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

      // Log minimal info for debugging – avoid dumping huge bodies in prod
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

      // Upsert/update a device record from this payload
      try {
        upsertDeviceFromGarminPayload(body);
      } catch (upErr) {
        console.error("[GarminOutbound] upsertDeviceFromGarminPayload error:", upErr);
      }

      // Respond quickly so Garmin is happy
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
