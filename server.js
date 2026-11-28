const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const crypto = require("crypto");

const PORT = process.env.PORT || 3001;
const DB_FILE = path.join(__dirname, "flora-db.json");
const ADMIN_EMAIL = "admin@floracloud.host";
const ADMIN_PASS = "admin123";

function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const initial = { users: [], vpsList: [] };
      fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
      return initial;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (_) {
    return { users: [], vpsList: [] };
  }
}

function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function hashPass(email, pass) {
  return crypto.createHash("sha256").update(`${email}::${pass}`).digest("hex");
}

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || "").trim(), stderr: (stderr || "").trim() });
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  // Serve index.html directly if opened from http://SERVER_IP:3001
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const htmlPath = path.join(__dirname, "index.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(htmlPath, "utf8"));
    }
    return sendJson(res, 404, { error: "index.html not found next to server.js" });
  }

  // Health Check
  if (req.method === "GET" && req.url === "/api/health") {
    const dockerCheck = await runCmd("docker --version");
    return sendJson(res, 200, {
      ok: true,
      dockerReady: dockerCheck.ok,
      dockerVersion: dockerCheck.stdout || "Docker not installed"
    });
  }

  // Sign In (Register)
  if (req.method === "POST" && req.url === "/api/signup") {
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!username || !email || !password) {
      return sendJson(res, 400, { ok: false, error: "Username, email and password required" });
    }

    const db = readDb();
    const passHash = hashPass(email, password);
    const idx = db.users.findIndex((u) => u.email === email);
    if (idx >= 0) {
      db.users[idx].username = username;
      db.users[idx].passHash = passHash;
    } else {
      db.users.unshift({ email, username, passHash });
    }
    writeDb(db);

    const role = email === ADMIN_EMAIL && password === ADMIN_PASS ? "admin" : "customer";
    return sendJson(res, 200, { ok: true, role, email, username });
  }

  // Login
  if (req.method === "POST" && req.url === "/api/login") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || !password) {
      return sendJson(res, 400, { ok: false, error: "Email and password required" });
    }

    const db = readDb();
    const found = db.users.find((u) => u.email === email);
    const username = found ? found.username : email.split("@")[0];

    if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
      if (!found) {
        db.users.unshift({ email, username: "Admin", passHash: hashPass(email, password) });
        writeDb(db);
      }
      return sendJson(res, 200, { ok: true, role: "admin", email, username: "Admin" });
    }

    const enteredHash = hashPass(email, password);
    if (found && found.passHash && found.passHash !== enteredHash) {
      return sendJson(res, 401, { ok: false, error: "Incorrect password for " + email });
    }

    if (!found) {
      db.users.unshift({ email, username, passHash: enteredHash });
      writeDb(db);
    }

    return sendJson(res, 200, { ok: true, role: "customer", email, username });
  }

  // Get Signed-In Emails
  if (req.method === "GET" && req.url === "/api/users") {
    const db = readDb();
    const safeUsers = db.users.map((u) => ({ email: u.email, username: u.username }));
    return sendJson(res, 200, { ok: true, users: safeUsers });
  }

  // Get VPS List
  if (req.method === "GET" && req.url.startsWith("/api/vps")) {
    const db = readDb();
    return sendJson(res, 200, { ok: true, list: db.vpsList });
  }

  // Create Real Docker VPS Container & Assign to Customer Email
  if (req.method === "POST" && req.url === "/api/vps/create") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) {
      return sendJson(res, 400, { ok: false, error: "Customer email required" });
    }

    const cpu = String(body.cpu || "2").replace(/[^0-9.]/g, "") || "2";
    const ram = String(body.ram || "4").replace(/[^0-9.]/g, "") || "4";
    const storage = String(body.storage || "40").replace(/[^0-9]/g, "") || "40";
    const os = String(body.os || "Ubuntu 24.04 LTS").trim();
    const region = String(body.region || "India (Mumbai) · ~25-45 ms").trim();
    const ip = String(body.ip || "127.0.0.1").trim();
    const port = String(body.port || "25565").replace(/[^0-9]/g, "") || "25565";

    const id = "vps-" + Date.now();
    const containerName = "flora_" + id.replace(/[^a-z0-9_]/gi, "_");
    const image = os.toLowerCase().includes("debian") ? "debian:12" : "ubuntu:24.04";

    // Create real isolated Docker container with CPU, RAM, and Port mapping
    const dockerCmd = `docker run -d --name ${containerName} --cpus="${cpu}" --memory="${ram}g" -p ${port}:22 ${image} sleep infinity`;
    const dockerRes = await runCmd(dockerCmd);

    const db = readDb();
    if (!db.users.some((u) => u.email === email)) {
      db.users.unshift({ email, username: email.split("@")[0], passHash: "" });
    }

    const record = {
      id,
      containerName,
      email,
      region,
      cpu,
      ram,
      storage,
      os,
      ip,
      port,
      status: "Running",
      realDockerCreated: dockerRes.ok,
      dockerInfo: dockerRes.ok ? dockerRes.stdout.slice(0, 12) : dockerRes.stderr
    };

    db.vpsList.unshift(record);
    writeDb(db);

    return sendJson(res, 200, { ok: true, vps: record });
  }

  // Power Control (Start / Stop / Restart / Reinstall OS)
  if (req.method === "POST" && req.url === "/api/vps/power") {
    const body = await readBody(req);
    const id = String(body.id || "");
    const action = String(body.action || "");
    const db = readDb();
    const item = db.vpsList.find((x) => x.id === id);
    if (!item) {
      return sendJson(res, 404, { ok: false, error: "VPS not found" });
    }

    if (item.containerName) {
      if (action === "Start") await runCmd(`docker start ${item.containerName}`);
      if (action === "Stop") await runCmd(`docker stop ${item.containerName}`);
      if (action === "Restart") await runCmd(`docker restart ${item.containerName}`);
    }

    item.status = action === "Stop" ? "Stopped" : "Running";
    writeDb(db);
    return sendJson(res, 200, { ok: true, status: item.status });
  }

  // Delete VPS & Remove Docker Container
  if (req.method === "POST" && req.url === "/api/vps/delete") {
    const body = await readBody(req);
    const id = String(body.id || "");
    const db = readDb();
    const item = db.vpsList.find((x) => x.id === id);
    if (item && item.containerName) {
      await runCmd(`docker rm -f ${item.containerName}`);
    }
    db.vpsList = db.vpsList.filter((x) => x.id !== id);
    writeDb(db);
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { ok: false, error: "Route not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Flora Cloud Self-Hosted Server running on http://0.0.0.0:${PORT}`);
});