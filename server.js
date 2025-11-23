// server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();

// --- CONFIG ----------------------------------------------------------

const PORT = process.env.PORT || 10000;

// Comma-separated list of allowed frontends
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://blog.magnusafety.com,https://magnusafety.com,http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Internal API key used by the ECC frontend
// (env overrides, but default is MAGNUS302010! as requested)
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "MAGNUS302010!";

// Garmin outbound auth token – must match x-outbound-auth-token header
const GARMIN_OUTBOUND_AUTH_TOKEN =
  process.env.GARMIN_OUTBOUND_AUTH_TOKEN || "";

// --- MIDDLEWARE ------------------------------------------------------

app.set("trust proxy", true); // behind Render/CF

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
      "[APIAuth] INTERNAL_API_KEY not set – all /api routes are open. Set it in env."
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

// --- SIMPLE IN-MEMORY DEVICE STORE ----------------------------------

const devicesStore = new Map();

function getOrCreateDevice(imei) {
  if (!devicesStore.has(imei)) {
    const now = new Date().toISOString();
    devicesStore.set(imei, {
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
      events: [],
      createdAt: now,
      updatedAt: now,
    });
  }
  return devicesStore.get(imei);
}

function listDevices() {
  return Array.from(devicesStore.values());
}

function upsertPosition(imei, position) {
  const d = getOrCreateDevice(imei);
  d.positions.push(position);
  d.lastPosition = position;
  d.lastPositionAt = position.timestamp || new Date().toISOString();
  d.lastEventAt = d.lastPositionAt;
  d.updatedAt = new Date().toISOString();
}

function upsertMessage(imei, msg) {
  const d = getOrCreateDevice(imei);
  d.messages.push(msg);
  d.lastMessageAt = msg.timestamp || new Date().toISOString();
  d.lastEventAt = d.lastMessageAt;
  d.updatedAt = new Date().toISOString();
}

function markSos(imei, opts) {
  const d = getOrCreateDevice(imei);
  if (opts.active != null) {
    d.isActiveSos = opts.active;
  }
  if (opts.eventAt) {
    d.lastSosEventAt = opts.eventAt;
    d.lastEventAt = opts.eventAt;
  }
  if (opts.ackAt) {
    d.lastSosAckAt = opts.ackAt;
    d.lastEventAt = opts.ackAt;
  }
  d.updatedAt = new Date().toISOString();
}

function closeIncident(imei) {
  const d = getOrCreateDevice(imei);
  d.status = "closed";
  d.updatedAt = new Date().toISOString();
}

// Helper to pull IMEI out of many possible IPC shapes
function extractImeiFromEvent(evt) {
  if (!evt || typeof evt !== "object") return null;

  if (evt.device && (evt.device.imei || evt.device.Imei)) {
    return evt.device.imei || evt.device.Imei;
  }
  if (evt.Device && (evt.Device.IMEI || evt.Device.Imei)) {
    return evt.Device.IMEI || evt.Device.Imei;
  }
  if (evt.imei || evt.Imei || evt.IMEI) {
    return evt.imei || evt.Imei || evt.IMEI;
  }
  if (evt.inReachDevice && (evt.inReachDevice.imei || evt.inReachDevice.Imei)) {
    return evt.inReachDevice.imei || evt.inReachDevice.Imei;
  }
  return null;
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

// --- SIMPLE OPERATOR LOGIN ------------------------------------------
// Frontend will call this, but the token is *not* enforced yet.
// Security for now is basically INTERNAL_API_KEY + obscurity.

app.post("/api/auth/login", authenticateApiKey, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Missing username or password" });
  }

  // For now, accept any non-empty credentials and return a dummy token.
  const token = `op-${username}-${Date.now()}`;
  console.log("[OperatorLogin] Login ok for user:", username);
  res.json({ token });
});

// --- FRONTEND API ROUTES (USED BY ECC UI) ---------------------------

// List devices (used by left sidebar + markers)
app.get("/api/garmin/devices", authenticateApiKey, (req, res) => {
  res.json(listDevices());
});

// Detailed view – used when clicking a device in the UI
app.get("/api/garmin/devices/:imei", authenticateApiKey, (req, res) => {
  const { imei } = req.params;
  if (!devicesStore.has(imei)) {
    return res.status(404).json({ error: "Device not found" });
  }
  const d = devicesStore.get(imei);
  res.json({
    device: {
      ...d,
      // Don't send the raw events array by default
      events: undefined,
    },
    messages: d.messages,
    positions: d.positions,
  });
});

// Send a message to a device (frontend stub – real send would hit Garmin API)
app.post(
  "/api/garmin/devices/:imei/message",
  authenticateApiKey,
  (req, res) => {
    const { imei } = req.params;
    const { text, isSos } = req.body || {};

    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing message text" });
    }

    const now = new Date().toISOString();
    const msg = {
      id: `local-${Date.now()}`,
      direction: "outbound",
      text,
      timestamp: now,
      is_sos: !!isSos,
      via: "ECC",
    };

    upsertMessage(imei, msg);

    if (isSos) {
      markSos(imei, { active: true, eventAt: now });
    }

    console.log("[Message] outbound message stored for", imei);
    res.json({ ok: true });
  }
);

// Acknowledge SOS (button in UI)
app.post(
  "/api/garmin/devices/:imei/ack-sos",
  authenticateApiKey,
  (req, res) => {
    const { imei } = req.params;
    const now = new Date().toISOString();
    markSos(imei, { active: false, ackAt: now });
    console.log("[SOS] ack for", imei);
    res.json({ ok: true });
  }
);

// Request location (stub – call Garmin Professional API in real version)
app.post(
  "/api/garmin/devices/:imei/locate",
  authenticateApiKey,
  (req, res) => {
    const { imei } = req.params;
    console.log("[Locate] requested new location for", imei);
    res.json({ ok: true });
  }
);

// Devices for map overlay (currently same as listDevices)
app.get("/api/garmin/map/devices", authenticateApiKey, (req, res) => {
  res.json(listDevices());
});

// --- GARMIN IPC OUTBOUND ENDPOINT -----------------------------------
// Garmin IPC webhook calls this with SOS, messages, positions, etc.

app.post(
  "/garmin/ipc-outbound",
  authenticateGarminOutbound,
  async (req, res) => {
    try {
      const { headers, body } = req;

      // Minimal header log for debugging
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

      const events = (body && body.Events) || body?.events || [];
      if (!Array.isArray(events)) {
        console.log("[GarminOutbound] No Events array in payload");
      } else {
        events.forEach((evt, idx) => {
          let imei = extractImeiFromEvent(evt);
          if (!imei) {
            imei = "VIRTUAL-TEST";
            console.log(
              "[DevicesStore] No IMEI in event index",
              idx,
              "- using VIRTUAL-TEST"
            );
          }

          const dev = getOrCreateDevice(imei);

          const baseTs =
            evt.timestamp ||
            evt.Timestamp ||
            evt.eventTime ||
            new Date().toISOString();

          // Generic event record
          dev.events.push({
            rawType: evt.Type || evt.type || evt.EventType || "unknown",
            raw: evt,
            timestamp: baseTs,
          });
          dev.lastEventAt = baseTs;
          dev.updatedAt = new Date().toISOString();

          const type = (evt.Type || evt.type || "").toLowerCase();

          // --- POSITION-LIKE EVENTS ---
          if (evt.Position || evt.position || type === "position") {
            const p = evt.Position || evt.position || evt;
            const lat = p.Latitude ?? p.latitude ?? p.lat;
            const lon = p.Longitude ?? p.longitude ?? p.lon;

            if (lat != null && lon != null) {
              const pos = {
                lat: Number(lat),
                lon: Number(lon),
                timestamp:
                  p.Timestamp ||
                  p.timestamp ||
                  p.FixTime ||
                  baseTs,
                gpsFix: p.GpsFix ?? p.gpsFix ?? true,
              };
              upsertPosition(imei, pos);
            }
          }

          // --- MESSAGE-LIKE EVENTS ---
          if (evt.Message || evt.message || type === "message") {
            const m = evt.Message || evt.message || evt;
            const text =
              m.Text ||
              m.text ||
              m.Body ||
              m.body ||
              m.MessageText ||
              "";
            const direction =
              m.Direction ||
              m.direction ||
              (m.IsOutbound ? "outbound" : "inbound");

            const msg = {
              id: m.Id || m.id || `evt-${idx}-${Date.now()}`,
              direction:
                (direction || "").toLowerCase() === "outbound"
                  ? "outbound"
                  : "inbound",
              text,
              timestamp: m.Timestamp || m.timestamp || baseTs,
              is_sos: !!(m.IsSos || m.isSos || m.Sos || m.sos),
              via: "Garmin IPC",
            };

            upsertMessage(imei, msg);
          }

          // --- SOS EVENTS ---
          const rawType = (evt.Type || evt.type || "").toLowerCase();
          const subType = (evt.SubType || evt.subType || "").toLowerCase();
          const sosFlag =
            evt.IsSos ||
            evt.isSos ||
            rawType.includes("sos") ||
            subType.includes("sos");

          if (
            sosFlag ||
            rawType === "sostriggered" ||
            rawType === "sos_triggered"
          ) {
            markSos(imei, { active: true, eventAt: baseTs });
          } else if (
            rawType === "soscleared" ||
            rawType === "sos_cleared" ||
            subType === "cleared"
          ) {
            markSos(imei, { active: false, eventAt: baseTs });
          }
        });

        console.log(
          "[DevicesStore] After IPC, total devices:",
          devicesStore.size
        );
      }

      // Always respond quickly to Garmin
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
