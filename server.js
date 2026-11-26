/**
 * Flora Cloud — Complete VPS Control, Session & Execution Bridge (v5.0.0)
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { exec } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

const app = express();

// ============================================================================
// 1. CONFIGURATION & DIRECTORIES
// ============================================================================
const CONFIG = {
  env: process.env.NODE_ENV || "production",
  port: Number(process.env.PORT) || 3001,
  host: process.env.HOST || "0.0.0.0",
  panelKey: process.env.PANEL_KEY || "flora-secret-2026",
  workDir: process.env.WORK_DIR || path.join(__dirname, "flora-workspace"),
  logDir: process.env.LOG_DIR || path.join(__dirname, "logs"),
  dataDir: process.env.DATA_DIR || path.join(__dirname, "data"),
  backupDir: process.env.BACKUP_DIR || path.join(__dirname, "backups"),
  defaultTimeoutMs: Number(process.env.CMD_TIMEOUT_MS) || 120000,
  maxTimeoutMs: 300000,
  maxBufferBytes: 50 * 1024 * 1024,
  rateWindowMs: 60 * 1000,
  rateMaxPerWindow: Number(process.env.RATE_LIMIT_MAX) || 240,
  sessionTtlMs: 24 * 60 * 60 * 1000 // 24 hours
};

const FILES = {
  auditLog: path.join(CONFIG.logDir, "audit.log"),
  errorLog: path.join(CONFIG.logDir, "error.log"),
  nodesRegistry: path.join(CONFIG.dataDir, "nodes.json"),
  sessionsFile: path.join(CONFIG.dataDir, "sessions.json")
};

for (const dir of [CONFIG.workDir, CONFIG.logDir, CONFIG.dataDir, CONFIG.backupDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

if (!fs.existsSync(FILES.nodesRegistry)) {
  fs.writeFileSync(
    FILES.nodesRegistry,
    JSON.stringify(
      [
        {
          id: "node-main-01",
          label: "Primary VPS Node",
          region: "AP-South",
          status: "ONLINE",
          createdAt: new Date().toISOString()
        }
      ],
      null,
      2
    ),
    "utf8"
  );
}

if (!fs.existsSync(FILES.sessionsFile)) {
  fs.writeFileSync(FILES.sessionsFile, JSON.stringify([], null, 2), "utf8");
}

// ============================================================================
// 2. LOGGING, SESSION & AUTH HELPERS
// ============================================================================
function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "0.0.0.0";
}

function writeLog(filePath, payload) {
  try {
    fs.appendFile(
      filePath,
      JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n",
      () => {}
    );
  } catch (_) {}
}

function audit(event, req, extra = {}) {
  writeLog(FILES.auditLog, {
    event,
    ip: getClientIp(req),
    requestId: req.requestId || null,
    ...extra
  });
}

function logErr(err, ctx = {}) {
  writeLog(FILES.errorLog, {
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : null,
    ...ctx
  });
}

function loadSessions() {
  try {
    const raw = fs.readFileSync(FILES.sessionsFile, "utf8");
    const list = JSON.parse(raw);
    const now = Date.now();
    return Array.isArray(list) ? list.filter((s) => s.expiresAt > now) : [];
  } catch (_) {
    return [];
  }
}

function saveSessions(list) {
  fs.writeFileSync(FILES.sessionsFile, JSON.stringify(list, null, 2), "utf8");
}

function createSession(role = "OPERATOR", label = "Panel Client") {
  const sessions = loadSessions();
  const token = crypto.randomBytes(24).toString("hex");
  const session = {
    token,
    role,
    label,
    createdAt: Date.now(),
    expiresAt: Date.now() + CONFIG.sessionTtlMs
  };
  sessions.push(session);
  saveSessions(sessions);
  return session;
}

function findValidSession(token) {
  if (!token || typeof token !== "string") return null;
  const sessions = loadSessions();
  const match = sessions.find((s) => s.token === token.trim());
  return match || null;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function extractTokenOrKey(req) {
  const bodyKey = req.body && typeof req.body.key === "string" ? req.body.key.trim() : "";
  const queryKey = req.query && typeof req.query.key === "string" ? req.query.key.trim() : "";
  const hdrKey = typeof req.headers["x-panel-key"] === "string" ? req.headers["x-panel-key"].trim() : "";
  const hdrToken = typeof req.headers["x-session-token"] === "string" ? req.headers["x-session-token"].trim() : "";
  const auth = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return {
    key: bodyKey || hdrKey || queryKey || "",
    token: hdrToken || (bearer && !safeEqual(bearer, CONFIG.panelKey) ? bearer : "") || (safeEqual(bearer, CONFIG.panelKey) ? "" : bearer)
  };
}

function authorize(req, res, next) {
  const { key, token } = extractTokenOrKey(req);

  if (key && safeEqual(key, CONFIG.panelKey)) {
    req.authRole = "ADMIN";
    return next();
  }

  if (token) {
    const sess = findValidSession(token);
    if (sess) {
      req.authRole = sess.role;
      req.sessionLabel = sess.label;
      return next();
    }
  }

  audit("AUTH_DENIED", req, { path: req.originalUrl });
  return res.status(401).json({
    ok: false,
    code: "UNAUTHORIZED",
    requestId: req.requestId,
    output: "Unauthorized: Provide valid Panel Key or Session Token."
  });
}

function requireAdmin(req, res, next) {
  if (req.authRole !== "ADMIN") {
    return res.status(403).json({
      ok: false,
      code: "FORBIDDEN",
      requestId: req.requestId,
      output: "Forbidden: Admin key required for this action."
    });
  }
  return next();
}

// ============================================================================
// 3. MIDDLEWARE PIPELINE
// ============================================================================
app.disable("x-powered-by");

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString("hex");
  res.setHeader("X-Request-Id", req.requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Panel-Key", "X-Session-Token", "X-Request-Id"]
  })
);

app.use(express.json({ limit: "5mb" }));

const rateBuckets = new Map();
app.use((req, res, next) => {
  const ip = getClientIp(req);
  const now = Date.now();
  const b = rateBuckets.get(ip);
  if (!b || now - b.start > CONFIG.rateWindowMs) {
    rateBuckets.set(ip, { start: now, count: 1 });
    res.setHeader("X-RateLimit-Limit", String(CONFIG.rateMaxPerWindow));
    res.setHeader("X-RateLimit-Remaining", String(CONFIG.rateMaxPerWindow - 1));
    return next();
  }
  b.count += 1;
  res.setHeader("X-RateLimit-Limit", String(CONFIG.rateMaxPerWindow));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, CONFIG.rateMaxPerWindow - b.count)));
  if (b.count > CONFIG.rateMaxPerWindow) {
    return res.status(429).json({
      ok: false,
      code: "RATE_LIMIT",
      requestId: req.requestId,
      output: "Rate limit exceeded."
    });
  }
  return next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `[${new Date().toISOString()}] [${req.requestId.slice(0, 8)}] ${getClientIp(req)} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

// ============================================================================
// 4. TELEMETRY & BASH EXECUTION ENGINE
// ============================================================================
function toGB(bytes) {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2));
}

function getTelemetry() {
  const cpus = os.cpus() || [];
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpuModel: cpus[0] ? cpus[0].model.trim() : "Unknown CPU",
    cores: cpus.length,
    totalRamGB: toGB(total),
    usedRamGB: toGB(used),
    freeRamGB: toGB(free),
    uptimeSec: Math.floor(os.uptime()),
    loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
    workspace: CONFIG.workDir
  };
}

function resolveWorkspace(rel) {
  if (!rel || typeof rel !== "string" || !rel.trim()) return CONFIG.workDir;
  const resolved = path.resolve(CONFIG.workDir, rel.replace(/^\/+/, ""));
  const rootSep = CONFIG.workDir.endsWith(path.sep) ? CONFIG.workDir : CONFIG.workDir + path.sep;
  if (resolved !== CONFIG.workDir && !resolved.startsWith(rootSep)) {
    throw new Error("Path outside workspace is not allowed.");
  }
  return resolved;
}

function runBash(command, cwd = CONFIG.workDir, timeoutMs = CONFIG.defaultTimeoutMs) {
  const timeout = Math.min(Math.max(Number(timeoutMs) || CONFIG.defaultTimeoutMs, 1000), CONFIG.maxTimeoutMs);
  const useBash = fs.existsSync("/bin/bash");
  const finalCmd = useBash ? `bash -lc ${JSON.stringify(command)}` : command;

  return new Promise((resolve) => {
    const t0 = Date.now();
    exec(
      finalCmd,
      {
        cwd,
        timeout,
        maxBuffer: CONFIG.maxBufferBytes,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          DEBIAN_FRONTEND: "noninteractive"
        }
      },
      (err, stdout, stderr) => {
        const ms = Date.now() - t0;
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (err) {
          resolve({
            ok: false,
            code: typeof err.code === "number" ? err.code : 1,
            timedOut: Boolean(err.killed),
            durationMs: ms,
            output: output || err.message || "Command failed."
          });
          return;
        }
        resolve({
          ok: true,
          code: 0,
          timedOut: false,
          durationMs: ms,
          output: output || "Done."
        });
      }
    );
  });
}

// ============================================================================
// 5. ROUTES (PING, AUTH SESSION, TELEMETRY, RUN, NODES, BACKUP, AUDIT)
// ============================================================================
app.get("/api/ping", (req, res) => {
  res.json({
    ok: true,
    service: "Flora Cloud VPS Bridge",
    version: "5.0.0",
    requestId: req.requestId,
    timestamp: new Date().toISOString()
  });
});

app.post("/api/session/issue", authorize, requireAdmin, (req, res) => {
  const { role, label } = req.body || {};
  const validRole = role === "ADMIN" || role === "CLIENT" ? role : "OPERATOR";
  const sess = createSession(validRole, label || "Client Session");
  audit("SESSION_ISSUED", req, { role: validRole, label: sess.label });
  return res.json({
    ok: true,
    requestId: req.requestId,
    token: sess.token,
    role: sess.role,
    label: sess.label,
    expiresAt: new Date(sess.expiresAt).toISOString()
  });
});

app.get("/api/status", authorize, (req, res) => {
  const t = getTelemetry();
  res.json({
    ok: true,
    requestId: req.requestId,
    role: req.authRole,
    hostname: t.hostname,
    cores: t.cores,
    totalRamGB: t.totalRamGB,
    freeRamGB: t.freeRamGB,
    uptimeSec: t.uptimeSec,
    loadAvg: t.loadAvg
  });
});

app.get("/api/health", authorize, (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    requestId: req.requestId,
    telemetry: getTelemetry(),
    timestamp: new Date().toISOString()
  });
});

app.post("/api/run", authorize, async (req, res) => {
  const body = req.body || {};
  const command = typeof body.command === "string" ? body.command.trim() : "";

  if (!command) {
    return res.status(400).json({
      ok: false,
      code: "EMPTY_COMMAND",
      requestId: req.requestId,
      output: "Error: Command cannot be empty."
    });
  }

  if (command === "clear") {
    return res.json({
      ok: true,
      code: 0,
      ran: "clear",
      durationMs: 0,
      requestId: req.requestId,
      output: ""
    });
  }

  if (command === "help") {
    return res.json({
      ok: true,
      code: 0,
      ran: "help",
      durationMs: 0,
      requestId: req.requestId,
      output: [
        "Flora Cloud Shell v5.0.0:",
        "  help      Show available commands",
        "  status    Show CPU, RAM, load & uptime",
        "  specs     Show full system JSON",
        "  clear     Clear screen",
        "  <command> Execute bash command on VPS"
      ].join("\n")
    });
  }

  if (command === "status") {
    const t = getTelemetry();
    return res.json({
      ok: true,
      code: 0,
      ran: "status",
      durationMs: 0,
      requestId: req.requestId,
      output: `Host: ${t.hostname} (${t.platform}/${t.arch}) | Cores: ${t.cores} | RAM: ${t.usedRamGB}/${t.totalRamGB} GB used (${t.freeRamGB} GB free) | Load: ${t.loadAvg.join(", ")} | Uptime: ${t.uptimeSec}s`
    });
  }

  if (command === "specs") {
    return res.json({
      ok: true,
      code: 0,
      ran: "specs",
      durationMs: 0,
      requestId: req.requestId,
      output: JSON.stringify(getTelemetry(), null, 2)
    });
  }

  let cwd = CONFIG.workDir;
  try {
    cwd = resolveWorkspace(body.cwd);
  } catch (err) {
    return res.status(400).json({
      ok: false,
      code: "INVALID_PATH",
      requestId: req.requestId,
      output: err.message
    });
  }

  audit("RUN_CMD", req, { role: req.authRole, command, cwd });
  const result = await runBash(command, cwd, body.timeoutMs);
  return res.json({
    ...result,
    ran: command,
    requestId: req.requestId
  });
});

app.get("/api/nodes", authorize, (req, res) => {
  try {
    const nodes = JSON.parse(fs.readFileSync(FILES.nodesRegistry, "utf8"));
    return res.json({ ok: true, requestId: req.requestId, nodes });
  } catch (err) {
    logErr(err, { route: "GET /api/nodes" });
    return res.status(500).json({ ok: false, requestId: req.requestId, output: "Failed to load nodes." });
  }
});

app.post("/api/nodes", authorize, requireAdmin, (req, res) => {
  try {
    const { id, label, region, status } = req.body || {};
    if (!id || !label) {
      return res.status(400).json({ ok: false, requestId: req.requestId, output: "id and label are required." });
    }
    const existing = JSON.parse(fs.readFileSync(FILES.nodesRegistry, "utf8"));
    const filtered = Array.isArray(existing) ? existing.filter((x) => x.id !== String(id)) : [];
    const entry = {
      id: String(id).trim(),
      label: String(label).trim(),
      region: region ? String(region).trim() : "Global",
      status: status ? String(status).trim() : "ONLINE",
      updatedAt: new Date().toISOString()
    };
    filtered.push(entry);
    fs.writeFileSync(FILES.nodesRegistry, JSON.stringify(filtered, null, 2), "utf8");
    audit("NODE_SAVE", req, { nodeId: entry.id });
    return res.json({ ok: true, requestId: req.requestId, node: entry, nodes: filtered });
  } catch (err) {
    logErr(err, { route: "POST /api/nodes" });
    return res.status(500).json({ ok: false, requestId: req.requestId, output: "Failed to save node." });
  }
});

app.post("/api/backup", authorize, requireAdmin, async (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveName = `workspace-backup-${stamp}.tar.gz`;
  const archivePath = path.join(CONFIG.backupDir, archiveName);
  const cmd = `tar -czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(CONFIG.workDir)} .`;
  audit("BACKUP_CREATE", req, { archiveName });
  const result = await runBash(cmd, CONFIG.workDir, 120000);
  return res.json({
    ...result,
    archiveName,
    archivePath,
    requestId: req.requestId
  });
});

app.get("/api/audit", authorize, requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  if (!fs.existsSync(FILES.auditLog)) {
    return res.json({ ok: true, requestId: req.requestId, entries: [] });
  }
  const lines = fs.readFileSync(FILES.auditLog, "utf8").trim().split("\n").filter(Boolean);
  const entries = lines.slice(-limit).map((l) => {
    try {
      return JSON.parse(l);
    } catch (_) {
      return { raw: l };
    }
  });
  return res.json({ ok: true, requestId: req.requestId, count: entries.length, entries });
});

// ============================================================================
// 6. ERROR HANDLERS & GRACEFUL SHUTDOWN
// ============================================================================
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    code: "NOT_FOUND",
    requestId: req.requestId,
    output: `Not found: ${req.method} ${req.originalUrl}`
  });
});

app.use((err, req, res, next) => {
  logErr(err, { requestId: req.requestId, path: req.originalUrl });
  res.status(500).json({
    ok: false,
    code: "SERVER_ERROR",
    requestId: req.requestId,
    output: "Internal server error."
  });
});

let server = null;
function gracefulExit(sig) {
  console.log(`[${new Date().toISOString()}] Stopping on ${sig}...`);
  if (!server) return process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGINT", () => gracefulExit("SIGINT"));
process.on("SIGTERM", () => gracefulExit("SIGTERM"));

server = app.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`Flora Cloud VPS Bridge v5.0.0 running at http://${CONFIG.host}:${CONFIG.port}`);
});