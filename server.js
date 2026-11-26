const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3001;
// Change this secret token before using on a public VPS
const PANEL_KEY = process.env.PANEL_KEY || "flora-secret-2026";

app.use(cors());
app.use(express.json());

app.get("/api/ping", (req, res) => {
  res.json({ ok: true, service: "Flora VPS Command Bridge" });
});

app.post("/api/run", (req, res) => {
  const { key, command } = req.body || {};
  if (key !== PANEL_KEY) {
    return res.status(401).json({ ok: false, output: "Unauthorized: Wrong Panel Key." });
  }
  if (!command || typeof command !== "string") {
    return res.status(400).json({ ok: false, output: "Empty command." });
  }

  exec(command, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    res.json({
      ok: !err,
      output: combined || (err ? err.message : "Command executed (no output).")
    });
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Flora VPS bridge listening on port ${PORT}`);
});