const express = require("express");
const path = require("path");

const app = express();
const PORT = 4100; // different port so we don't clash with your main server

const publicDir = path.join(__dirname, "public");
console.log("Mini server serving static from:", publicDir);

// serve static files under /console
app.use("/console", express.static(publicDir));

// explicit route for /console (no trailing slash)
app.get("/console", (req, res) => {
  console.log("GET /console hit");
  res.sendFile(path.join(publicDir, "index.html"));
});

// tiny health endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Mini server listening on http://localhost:${PORT}`);
});
