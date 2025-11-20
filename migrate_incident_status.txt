// migrate_incident_status.js
const Database = require("better-sqlite3");

const dbFile = process.env.DB_FILE || "garmin.db";
console.log("Using DB file:", dbFile);

const db = new Database(dbFile);

// Helper: run an ALTER TABLE but ignore "duplicate column" errors
function safeAlter(sql) {
  try {
    console.log("Running:", sql);
    db.exec(sql);
    console.log("OK");
  } catch (err) {
    if (
      err &&
      typeof err.message === "string" &&
      err.message.toLowerCase().includes("duplicate column")
    ) {
      console.log("Column already exists, skipping.");
    } else {
      console.error("Error running migration:", err.message);
    }
  }
}

// Add 'status' column (open/closed)
safeAlter("ALTER TABLE devices ADD COLUMN status TEXT DEFAULT 'open';");

// Add 'closedAt' column (ISO timestamp)
safeAlter("ALTER TABLE devices ADD COLUMN closedAt TEXT;");

console.log("Migration finished.");
db.close();
