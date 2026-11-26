const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;
const PANEL_KEY = process.env.PANEL_KEY || "flora-secret-2026";
const WORK_DIR = path.join(__dirname, "flora-workspace");

if (!fs.existsSync(WORK_DIR)) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

const QUICK_COMMANDS = {
  "help": "Commands: help, status, specs, ram, disk, ip, uptime, clear",
  "status": "VPS status: ONLINE",
  "ram": "free -h",
  "disk": "df -h /",
  "ip": "curl -s ifconfig.me || hostname -I",
  "uptime": "uptime -p || uptime"
};

function resolveCommand(rawCmd) {
  const trimmed = rawCmd.trim();
  if (QUICK_COMMANDS[trimmed]) {
    return QUICK_COMMANDS[trimmed];
  }
  return trimmed;
}

app.get("/api/ping", (req, res) => {
  res.json({
    ok: true,
    service: "Flora Cloud VPS Bridge",
    commands: Object.keys(QUICK_COMMANDS)
  });
});

app.post("/api/run", (req, res) => {
  const { key, command } = req.body || {};

  if (key !== PANEL_KEY) {
    return res.status(401).json({
      ok: false,
      output: "Unauthorized: Invalid Panel Key."
    });
  }

  if (!command || typeof command !== "string" || !command.trim()) {
    return res.status(400).json({
      ok: false,
      output: "Error: Command cannot be empty."
    });
  }

  const finalCommand = resolveCommand(command);

  exec(
    finalCommand,
    { cwd: WORK_DIR, timeout: 20000, maxBuffer: 1024 * 1024 },
    (err, stdout, stderr) => {
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      res.json({
        ok: !err,
        ran: finalCommand,
        output: combined || (err ? err.message : "Executed.")
      });
    }
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Flora Cloud VPS bridge running on port ${PORT}`);
});