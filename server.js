// MAGNUS Garmin ECC backend - full server.js
// Requires: express, cors
// Node 18+ recommended (built-in fetch)

require("dotenv").config();
const express = require("express");
const cors = require("cors");

// --- BASIC CONFIG ----------------------------------------------------
const PORT = process.env.PORT || 10000;

// Auth token Garmin will use when calling /garmin/ipc-outbound
const OUTBOUND_AUTH_TOKEN = process.env.OUTBOUND_AUTH_TOKEN || "EDF01295";

// IPC Inbound (to send messages / locate) - MUST be set correctly in env
const IPC_INBOUND_BASE =
  process.env.IPC_INBOUND_BASE ||
  "https://eur-enterprise.inreach.garmin.com/IPCInbound/V1";
const IPC_INBOUND_USERNAME =
  process.env.IPC_INBOUND_USERNAME || "MagnusDash";
const IPC_INBOUND_PASSWORD =
  process.env.IPC_INBOUND_PASSWORD || "CHANGEME";

// --- APP INIT --------------------------------------------------------
const app = express();
app.use(express.json());

// Allow your WordPress / ECC frontends
app.use(
  cors({
    origin: [
      "https://blog.magnusafety.com",
      "https://magnusafety.com",
      "http://localhost:3000",
      "http://localhost:5173",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

// Simple health root
app.get("/", (_req, res) => {
  res
    .status(200)
    .send(
      "MAGNUS Garmin ECC backend is running. Endpoints: /garmin/ipc-outbound, /api/garmin/devices, /api/garmin/devices/:imei"
    );
});

// --- IN-MEMORY DEVICE STORE ------------------------------------------
// This keeps state while the container is running. For production
// you would move this to a real DB (Postgres, etc.)

class DevicesStore {
  constructor() {
    this.devices = new Map(); // imei => device object
  }

  _ensureDevice(imei) {
    if (!this.devices.has(imei)) {
      const dev = {
        imei,
        label: null, // optional human label
        status: "open", // "open" | "closed"
        isActiveSos: false,

        lastEventAt: null,
        lastPositionAt: null,
        lastMessageAt: null,
        lastSosEventAt: null,
        lastSosAckAt: null,
        closedAt: null,

        lastPosition: null, // { lat, lon, altitude, gpsFix, speed, course, timestamp }
        positions: [], // array of last positions
        messages: [], // array of { direction, text, timestamp, is_sos, rawCode }
      };
      this.devices.set(imei, dev);
    }
    return this.devices.get(imei);
  }

  upsertFromOutboundEvent(evt, receivedAtIso) {
    const imei = String(evt.imei || "").trim();
    if (!imei) {
      console.warn("[DevicesStore] Outbound event missing IMEI:", evt);
      return null;
    }

    const dev = this._ensureDevice(imei);
    dev.lastEventAt = receivedAtIso;

    const code = evt.messageCode;
    const text = (evt.freeText || "").trim();
    const point = evt.point || {};
    const status = evt.status || {};

    const hasValidPosition =
      point &&
      typeof point.latitude === "number" &&
      typeof point.longitude === "number" &&
      !Number.isNaN(point.latitude) &&
      !Number.isNaN(point.longitude) &&
      !(point.latitude === 0 && point.longitude === 0);

    // SOS logic: treat messageCode 7 as SOS (update or start)
    if (code === 7) {
      dev.isActiveSos = true;
      dev.lastSosEventAt = receivedAtIso;
    }

    // Position / tracking
    if (hasValidPosition) {
      const pos = {
        lat: point.latitude,
        lon: point.longitude,
        altitude: point.altitude ?? null,
        gpsFix: point.gpsFix ?? null,
        speed: point.speed ?? null,
        course: point.course ?? null,
        timestamp: receivedAtIso,
        status,
      };
      dev.lastPosition = pos;
      dev.lastPositionAt = receivedAtIso;
      dev.positions.push(pos);
      // keep history bounded
      if (dev.positions.length > 1000) {
        dev.positions = dev.positions.slice(-1000);
      }
    }

    // Message text (inbound from device)
    if (text) {
      const msg = {
        direction: "inbound",
        text,
        timestamp: receivedAtIso,
        is_sos: code === 7 ? 1 : 0,
        rawCode: code,
      };
      dev.messages.push(msg);
      dev.lastMessageAt = receivedAtIso;
      if (dev.messages.length > 2000) {
        dev.messages = dev.messages.slice(-2000);
      }
    }

    console.log(
      `[DevicesStore] Upserted device ${imei}. Total devices: ${this.devices.size}`
    );
    return dev;
  }

  markSosAck(imei, atIso) {
    const dev = this.devices.get(imei);
    if (!dev) return null;
    dev.isActiveSos = false;
    dev.lastSosAckAt = atIso;
    console.log(`[DevicesStore] SOS ACK for ${imei} at ${atIso}`);
    return dev;
  }

  listDevices() {
    return Array.from(this.devices.values());
  }

  getDevice(imei) {
    return this.devices.get(imei) || null;
  }

  addOutboundMessage(imei, text, isSos, atIso) {
    const dev = this._ensureDevice(imei);
    const msg = {
      direction: "outbound",
      text,
      timestamp: atIso,
      is_sos: isSos ? 1 : 0,
      rawCode: null,
    };
    dev.messages.push(msg);
    dev.lastMessageAt = atIso;
    if (isSos) {
      dev.isActiveSos = true;
      dev.lastSosEventAt = atIso;
    }
    if (dev.messages.length > 2000) {
      dev.messages = dev.messages.slice(-2000);
    }
    console.log(
      `[DevicesStore] Stored outbound message for ${imei} (SOS=${!!isSos})`
    );
    return dev;
  }
}

const store = new DevicesStore();

// --- HELPER: parse Garmin timestamp (ms since epoch or ticks) --------
function parseGarminTimestamp(ts) {
  if (typeof ts !== "number") return new Date();
  // In all the examples, ts looks like Unix ms
  try {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d;
  } catch (e) {
    console.warn("Failed to parse Garmin timestamp:", ts, e);
  }
  return new Date();
}

// --- GARMIN OUTBOUND (EVENTS/IPCs INBOUND TO MAGNUS) -----------------
// Garmin calls this URL when a message / track / SOS arrives.

app.post("/garmin/ipc-outbound", (req, res) => {
  try {
    const token = req.headers["x-outbound-auth-token"];
    if (!token || token !== OUTBOUND_AUTH_TOKEN) {
      console.warn(
        "[GarminOutbound] Invalid auth token:",
        token,
        "expected:",
        OUTBOUND_AUTH_TOKEN
      );
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("[GarminOutbound] Auth OK");
    console.log("HEADERS FROM GARMIN:", req.headers);

    const payload = req.body || {};
    console.log("[GarminOutbound] FULL IPC PAYLOAD:", JSON.stringify(payload, null, 2));

    const events = Array.isArray(payload.Events) ? payload.Events : [];
    const now = new Date().toISOString();

    events.forEach((evt) => {
      const eventTime = parseGarminTimestamp(evt.timeStamp).toISOString();
      store.upsertFromOutboundEvent(evt, eventTime || now);
    });

    console.log(
      "[DevicesStore] After IPC, total devices:",
      store.listDevices().length
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[GarminOutbound] Error handling IPC outbound:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// --- IPC INBOUND HELPERS (MAGNUS -> GARMIN) --------------------------
// These call Garmin's IPCInbound services (Messaging, Locate, etc.)
// Requires Node 18+ (global fetch).

async function callIpcInboundMessaging(imei, text) {
  const url = `${IPC_INBOUND_BASE}/Messaging.svc/Message`;
  const body = {
    Username: IPC_INBOUND_USERNAME,
    Password: IPC_INBOUND_PASSWORD,
    Message: {
      Imei: imei,
      Text: text,
      SendToInbox: true,
    },
  };

  console.log("[IPCInbound] POST", url, "payload:", body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const textBody = await res.text();
  let json;
  try {
    json = JSON.parse(textBody);
  } catch {
    json = null;
  }

  if (!res.ok) {
    console.error("[IPCInbound] Error response", res.status, textBody);
    throw new Error(
      `IPCInbound ${url} failed: ${res.status} ${
        (json && json.Message) || textBody
      }`
    );
  }

  console.log("[IPCInbound] Messaging OK:", json || textBody);
  return json || textBody;
}

// Optional locate stub (does not actually call Garmin Locate API yet)
async function callIpcInboundLocate(imei) {
  console.log(
    "[IPCInbound] Locate called for IMEI",
    imei,
    "- NOT wired to Garmin Locate.svc yet."
  );
  // If/when you get Locate.svc docs you can implement it here.
  return { ok: true, note: "Locate not wired to Garmin yet." };
}

// --- PUBLIC API FOR FRONTEND ----------------------------------------

// List devices (for left column + map)
app.get("/api/garmin/devices", (_req, res) => {
  try {
    const list = store.listDevices();
    return res.json(list);
  } catch (err) {
    console.error("GET /api/garmin/devices error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Detail for a specific device: device + positions + messages
app.get("/api/garmin/devices/:imei", (req, res) => {
  try {
    const imei = String(req.params.imei || "").trim();
    const dev = store.getDevice(imei);
    if (!dev) {
      return res.status(404).json({ error: "Device not found" });
    }

    const positions = [...dev.positions].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp)
    );
    const messages = [...dev.messages].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp)
    );

    return res.json({
      device: dev,
      positions,
      messages,
    });
  } catch (err) {
    console.error("GET /api/garmin/devices/:imei error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Send message from ECC -> device via IPCInbound Messaging
app.post("/api/garmin/devices/:imei/message", async (req, res) => {
  const imei = String(req.params.imei || "").trim();
  const { text, is_sos } = req.body || {};
  if (!imei) {
    return res.status(400).json({ error: "Missing IMEI" });
  }
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Message text is required" });
  }

  try {
    const nowIso = new Date().toISOString();

    // Actually call Garmin IPCInbound
    await callIpcInboundMessaging(imei, text.trim());

    // Cache outbound message in local store
    store.addOutboundMessage(imei, text.trim(), !!is_sos, nowIso);

    return res.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/garmin/devices/:imei/message] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to send message" });
  }
});

// Request "locate" (currently just stubbed)
app.post("/api/garmin/devices/:imei/locate", async (req, res) => {
  const imei = String(req.params.imei || "").trim();
  if (!imei) {
    return res.status(400).json({ error: "Missing IMEI" });
  }
  try {
    const result = await callIpcInboundLocate(imei);
    return res.json({ ok: true, result });
  } catch (err) {
    console.error("[POST /api/garmin/devices/:imei/locate] Error:", err);
    return res.status(500).json({ error: err.message || "Failed to send locate" });
  }
});

// Acknowledge / locally clear SOS (does NOT call Emergency.svc yet)
app.post("/api/garmin/devices/:imei/ack-sos", (req, res) => {
  const imei = String(req.params.imei || "").trim();
  if (!imei) {
    return res.status(400).json({ error: "Missing IMEI" });
  }
  try {
    const nowIso = new Date().toISOString();
    const dev = store.markSosAck(imei, nowIso);
    if (!dev) {
      return res.status(404).json({ error: "Device not found" });
    }
    // TODO: If you decide to use Emergency.svc Acknowledge/Close,
    // you'll need an EmergencyId from Garmin to send here.
    // For now we only clear local flag so UI hides the red banner.
    return res.json({ ok: true });
  } catch (err) {
    console.error("[POST /api/garmin/devices/:imei/ack-sos] Error:", err);
    return res.status(500).json({ error: "Failed to ack SOS" });
  }
});

// --- START SERVER ----------------------------------------------------
app.listen(PORT, () => {
  console.log("Bootstrapping MAGNUS Garmin ECC backend...");
  console.log(`MAGNUS Garmin ECC backend running on port ${PORT}`);
});
