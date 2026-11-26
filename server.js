const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;
const PANEL_KEY = process.env.PANEL_KEY || "flora-secret-2026";
const SERVER_DIR = path.join(__dirname, "mc-server");

if (!fs.existsSync(SERVER_DIR)) {
  fs.mkdirSync(SERVER_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

// रेडी-मेड शॉर्टकट कमांड्स (ताकि यूज़र को लंबी बैश कमांड याद न रखनी पड़े)
const PRESET_COMMANDS = {
  "vps-info": "uname -a && uptime",
  "vps-ram": "free -h",
  "vps-disk": "df -h /",
  "vps-ports": "ss -tulpn || netstat -tulpn || true",
  "java-check": "java -version || true",
  "java-install": "sudo apt update && sudo apt install -y openjdk-21-jre-headless",
  "mc-ls": "ls -la",
  "mc-status": "ps aux | grep -E 'java|server.jar|purpur|paper' | grep -v grep || echo 'No MC server process running'",
  "mc-eula": "echo 'eula=true' > eula.txt && cat eula.txt",
  "mc-start-2g": "nohup java -Xmx2G -Xms1G -jar server.jar nogui > mc.log 2>&1 & echo 'Started MC server (2G) in background'",
  "mc-start-4g": "nohup java -Xmx4G -Xms2G -jar server.jar nogui > mc.log 2>&1 & echo 'Started MC server (4G) in background'",
  "mc-stop": "pkill -f 'server.jar' || pkill -f 'java' || echo 'No running server found'",
  "mc-log": "tail -n 30 mc.log 2>/dev/null || echo 'mc.log not found yet'"
};

function resolveCommand(rawCmd) {
  const trimmed = rawCmd.trim();

  // अगर सीधे शॉर्टकट कमांड लिखा गया है
  if (PRESET_COMMANDS[trimmed]) {
    return PRESET_COMMANDS[trimmed];
  }

  // Minecraft in-game style commands को log/console helper में बदलना
  if (trimmed.startsWith("say ")) {
    const msg = trimmed.slice(4).replace(/"/g, '\\"');
    return `echo "[CHAT/CONSOLE] ${msg}" >> mc-commands.log && echo "Sent message: ${msg}"`;
  }

  if (trimmed.startsWith("op ")) {
    const player = trimmed.slice(3).trim();
    return `echo "[OP REQUEST] ${player}" >> mc-commands.log && echo "Queued OP for player: ${player}"`;
  }

  if (trimmed === "list") {
    return `ps aux | grep -E 'java|server.jar' | grep -v grep || echo "Server offline / 0 players"`;
  }

  // बाकी कोई भी बैश या Linux कमांड सीधे चला दें
  return trimmed;
}

app.get("/api/ping", (req, res) => {
  res.json({
    ok: true,
    service: "Flora Minecraft + VPS Command Bridge",
    presets: Object.keys(PRESET_COMMANDS)
  });
});

app.get("/api/commands", (req, res) => {
  res.json({
    ok: true,
    presets: PRESET_COMMANDS
  });
});

app.post("/api/run", (req, res) => {
  const { key, command } = req.body || {};

  if (key !== PANEL_KEY) {
    return res.status(401).json({ ok: false, output: "Unauthorized: Wrong Panel Key." });
  }

  if (!command || typeof command !== "string" || !command.trim()) {
    return res.status(400).json({ ok: false, output: "Empty command." });
  }

  if (command.trim() === "presets") {
    return res.json({
      ok: true,
      output: "Available Preset Commands:\n" + Object.keys(PRESET_COMMANDS).map((k) => `  • ${k}`).join("\n")
    });
  }

  const finalCommand = resolveCommand(command);

  exec(finalCommand, { cwd: SERVER_DIR, timeout: 20000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    res.json({
      ok: !err,
      ran: finalCommand,
      output: out || (err ? err.message : "Command executed.")
    });
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Flora MC + VPS bridge running on port ${PORT}`);
});