// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();

// --- CONFIG ----------------------------------------------------------

const PORT = process.env.PORT || 10000;

// Frontends allowed to call this backend
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Garmin outbound auth token – must match what Garmin sends in x-outbound-auth-token
// Example from your test: EDF01295
const GARMIN_OUTBOUND_AUTH_TOKEN =
  process.env.GARMIN_OUTBOUND_AUTH_TOKEN || "";

// In-memory store for devices (reset on restart)
const devicesStore = {};

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

// --- HELPER MIDDLEWARE ----------------------------------------------

// 🔓 DEV MODE: internal API key check is DISABLED for now.
// All /api routes are open so the ECC can talk to the backend without headers.
function authenticateApiKey(req, res, next) {
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

// --- SIMPLE DEVICE HELPERS ------------------------------------------

function upsertDevice(imei, partial) {
  if (!imei) imei = "VIRTUAL-TEST";

  const existing = devicesStore[imei] || {};
  const now = new Date().toISOString();

  devicesStore[imei] = {
    imei,
    label: existing.label || partial.label || "Garmin Device",
    status: partial.status || existing.status || "open",
    isActiveSos:
      typeof partial.isActiveSos === "boolean"
        ? partial.isActiveSos
        : existing.isActiveSos || false,
    lastEventAt: partial.lastEventAt || existing.lastEventAt || now,
    lastPosition: partial.lastPosition || existing.lastPosition || null,
  };

  console.log(
    "[DevicesStore] Upserted device",
    imei,
    ". Total devices:",
    Object.keys(devicesStore).length
  );
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
// These are what your ECC frontend calls.

// List devices for sidebar + map
app.get("/api/garmin/devices", authenticateApiKey, async (req, res) => {
  try {
    const list = Object.values(devicesStore);
    res.json(list); // ECC expects an array
  } catch (err) {
    console.error("[/api/garmin/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// Devices for map overlay (same data shape for now)
app.get("/api/garmin/map/devices", authenticateApiKey, async (req, res) => {
  try {
    const list = Object.values(devicesStore);
    res.json(list);
  } catch (err) {
    console.error("[/api/garmin/map/devices] Error:", err);
    res.status(500).json({ error: "Failed to fetch map devices" });
  }
});

// --- GARMIN IPC OUTBOUND ENDPOINT ------------------------------------
// This is the URL you gave to Garmin:
//   https://magnus-garmin-ecc.onrender.com/garmin/ipc-outbound

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
        "cf-connecting-ip": headers["cf-connecting-ip"],
        "x-forwarded-for": headers["x-forwarded-for"],
      });

      console.log(
        "[GarminOutbound] Received IPC payload, top-level keys:",
        body && Object.keys(body)
      );

      // Very simple example handling:
      // Grab IMEI if present; for virtual test, fall back to VIRTUAL-TEST.
      let imei = null;

      try {
        if (body && Array.isArray(body.Events) && body.Events.length > 0) {
          const evt = body.Events[0];
          // IMEI location will depend on Garmin payload structure – adjust later.
          imei =
            evt.DeviceImei ||
            evt.Imei ||
            (evt.Device && evt.Device.IMEI) ||
            null;
        }
      } catch (e) {
        console.log("[GarminOutbound] Could not extract IMEI:", e.message);
      }

      if (!imei) {
        console.log("[DevicesStore] No IMEI in payload – using VIRTUAL-TEST");
        imei = "VIRTUAL-TEST";
      }

      // Minimal upsert – you can enrich this once you map Garmin fields.
      upsertDevice(imei, {
        label: imei === "VIRTUAL-TEST" ? "Garmin Virtual Test" : `Device ${imei}`,
        isActiveSos: true, // assume test is SOS-like; adjust when you parse event types
        lastEventAt: new Date().toISOString(),
      });

      // Respond quickly to Garmin
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
