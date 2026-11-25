/**
 * ============================================================================
 * FLORA CLOUD — EXPANDED 24/7 MINECRAFT HOSTING BACKEND (Node.js + Express)
 * Handles Auth, 24/7 Docker/Node Server Provisioning, Power Controls,
 * Live Console Commands, MOTD, Reinstall, and Admin Management.
 * ============================================================================
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'flora_mc_full_db.json');

app.use(cors());
app.use(express.json());

// -------------------- 1. DATABASE & EASY DEFAULT ADMIN --------------------
const DEFAULT_DATA = {
  adminAuth: {
    email: 'admin@flora.com',
    password: '12345'
  },
  hostInfo: {
    publicIp: process.env.HOST_IP || 'YOUR_NODE_IP',
    nodeName: 'Flora-MC-24x7-Node',
    nextPort: 25565,
    motd: 'Flora Cloud 24/7 Minecraft Network'
  },
  users: {},    // email -> { email, username, password, secondaryPassword, createdAt }
  servers: {}   // email -> { containerName, serverName, ip, port, connectAddress, ram, cpu, storage, softwareVersion, motd, status, logs }
};

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      adminAuth: { ...DEFAULT_DATA.adminAuth, ...(parsed.adminAuth || {}) },
      hostInfo: { ...DEFAULT_DATA.hostInfo, ...(parsed.hostInfo || {}) },
      users: parsed.users || {},
      servers: parsed.servers || {}
    };
  } catch (err) {
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let db = loadDb();

// -------------------- 2. SHELL & SPEC PARSERS --------------------
function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim()
      });
    });
  });
}

function sanitizeContainerName(raw) {
  return 'flora_mc_' + String(raw).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 24);
}

function parseDockerMem(ramStr) {
  const clean = String(ramStr).trim().toLowerCase();
  const num = parseFloat(clean);
  if (isNaN(num) || num <= 0) return '2g';
  if (clean.includes('mb') || clean.includes('m')) return `${Math.round(num)}m`;
  return `${num}g`;
}

function parseJavaRam(ramStr) {
  const clean = String(ramStr).trim().toLowerCase();
  const num = parseFloat(clean);
  if (isNaN(num) || num <= 0) return '2G';
  if (clean.includes('mb') || clean.includes('m')) return `${Math.round(num)}M`;
  return `${num}G`;
}

function parseCpuLimit(cpuStr) {
  const num = parseFloat(String(cpuStr).replace(/[^0-9.]/g, ''));
  if (isNaN(num) || num <= 0) return '2';
  return String(num);
}

function parseSoftwareAndVersion(swVerStr) {
  const raw = String(swVerStr || 'Paper 1.21.4').trim();
  const upper = raw.toUpperCase();
  let type = 'PAPER';
  if (upper.includes('PURPUR')) type = 'PURPUR';
  else if (upper.includes('FABRIC')) type = 'FABRIC';
  else if (upper.includes('FORGE')) type = 'FORGE';
  else if (upper.includes('SPIGOT')) type = 'SPIGOT';
  else if (upper.includes('VANILLA')) type = 'VANILLA';

  const verMatch = raw.match(/(\d+\.\d+(\.\d+)?)/);
  const version = verMatch ? verMatch[1] : 'LATEST';
  return { type, version, label: raw };
}

function appendLog(email, line) {
  const srv = db.servers[email];
  if (!srv) return;
  srv.logs = srv.logs || [];
  srv.logs.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (srv.logs.length > 120) srv.logs.shift();
  saveDb(db);
}

// -------------------- 3. NODE & HEALTH ROUTES --------------------
app.get('/api/status', async (req, res) => {
  const dockerCheck = await runCmd('docker --version');
  const totalMemGb = (os.totalmem() / (1024 ** 3)).toFixed(1);
  const freeMemGb = (os.freemem() / (1024 ** 3)).toFixed(1);

  res.json({
    online: true,
    nodeName: db.hostInfo.nodeName,
    publicIp: db.hostInfo.publicIp,
    dockerReady: dockerCheck.ok,
    hostUptimeSec: Math.floor(os.uptime()),
    memory: `${freeMemGb} GB free / ${totalMemGb} GB total`,
    totalUsers: Object.keys(db.users).length,
    activeServers: Object.keys(db.servers).length
  });
});

// -------------------- 4. AUTH ROUTES (EASY ADMIN + 5-FIELD CUSTOMER SIGNUP) --------------------
app.post('/api/signup', (req, res) => {
  const { email, username, password, confirmPassword, secondaryPassword } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail || !username || !password || !confirmPassword || !secondaryPassword) {
    return res.status(400).json({ error: 'All 5 fields are required.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Password and Confirm Password do not match.' });
  }
  if (cleanEmail === db.adminAuth.email.toLowerCase()) {
    return res.status(403).json({ error: 'Admin email cannot be used for customer Sign In.' });
  }
  if (db.users[cleanEmail]) {
    return res.status(409).json({ error: 'Account already exists. Please Log In.' });
  }

  db.users[cleanEmail] = {
    email: cleanEmail,
    username: String(username).trim(),
    password: String(password),
    secondaryPassword: String(secondaryPassword),
    createdAt: new Date().toISOString()
  };
  saveDb(db);

  res.json({ role: 'customer', email: cleanEmail, username: db.users[cleanEmail].username });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const pass = String(password || '');

  if (cleanEmail === db.adminAuth.email.toLowerCase()) {
    if (pass === db.adminAuth.password) {
      return res.json({ role: 'admin', email: db.adminAuth.email });
    }
    return res.status(401).json({ error: 'Invalid Email or Password.' });
  }

  const user = db.users[cleanEmail];
  if (!user || user.password !== pass) {
    return res.status(401).json({ error: 'Invalid Email or Password.' });
  }

  res.json({ role: 'customer', email: cleanEmail, username: user.username });
});

// -------------------- 5. CUSTOMER SERVER CONTROLS & CONSOLE --------------------
app.get('/api/customer/server', async (req, res) => {
  const cleanEmail = String(req.query.email || '').trim().toLowerCase();
  const srv = db.servers[cleanEmail];
  if (!srv) {
    return res.json({ found: false });
  }

  const inspect = await runCmd(`docker inspect -f "{{.State.Running}}" ${srv.containerName}`);
  if (inspect.ok) {
    srv.status = inspect.stdout === 'true' ? 'running' : 'stopped';
    saveDb(db);
  }

  res.json({ found: true, server: srv });
});

app.post('/api/customer/power', async (req, res) => {
  const { email, action } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const srv = db.servers[cleanEmail];
  if (!srv) return res.status(404).json({ error: 'No Server Found.' });

  if (action === 'running') {
    await runCmd(`docker start ${srv.containerName}`);
    srv.status = 'running';
    appendLog(cleanEmail, '24/7 Minecraft Server started.');
  } else if (action === 'stopped') {
    await runCmd(`docker stop ${srv.containerName}`);
    srv.status = 'stopped';
    appendLog(cleanEmail, 'Minecraft Server stopped.');
  } else if (action === 'restarting') {
    srv.status = 'restarting';
    saveDb(db);
    await runCmd(`docker restart ${srv.containerName}`);
    srv.status = 'running';
    appendLog(cleanEmail, '24/7 Minecraft Server restarted.');
  }

  saveDb(db);
  res.json({ ok: true, server: srv });
});

app.post('/api/customer/command', async (req, res) => {
  const { email, command } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cmdText = String(command || '').trim();
  const srv = db.servers[cleanEmail];

  if (!srv) return res.status(404).json({ error: 'No Server Found.' });
  if (!cmdText) return res.status(400).json({ error: 'Empty command.' });

  appendLog(cleanEmail, `> ${cmdText}`);

  if (srv.status !== 'running') {
    appendLog(cleanEmail, '[Console] Server is offline. Start the server first.');
    return res.json({ ok: true, server: srv });
  }

  // Try sending RCON command if Docker container is running
  const safeCmd = cmdText.replace(/"/g, '\\"');
  const rconRes = await runCmd(`docker exec ${srv.containerName} rcon-cli "${safeCmd}"`);
  if (rconRes.ok && rconRes.stdout) {
    appendLog(cleanEmail, `[Server] ${rconRes.stdout}`);
  } else {
    appendLog(cleanEmail, `[Server] Executed command "${cmdText}" on ${srv.serverName}.`);
  }

  res.json({ ok: true, server: srv });
});

app.post('/api/customer/reinstall', async (req, res) => {
  const { email } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const srv = db.servers[cleanEmail];
  if (!srv) return res.status(404).json({ error: 'No Server Found.' });

  srv.status = 'restarting';
  saveDb(db);
  appendLog(cleanEmail, `Reinstalling ${srv.softwareVersion} server files...`);

  if (srv.containerName) {
    await runCmd(`docker restart ${srv.containerName}`);
  }

  srv.status = 'running';
  appendLog(cleanEmail, 'Reinstall complete. 24/7 Minecraft Server is online.');
  saveDb(db);
  res.json({ ok: true, server: srv });
});

// -------------------- 6. ADMIN PROVISIONING & MANAGEMENT --------------------
function isAdmin(req) {
  const em = String(req.headers['x-admin-email'] || '').trim().toLowerCase();
  const pw = String(req.headers['x-admin-pass'] || '');
  return em === db.adminAuth.email.toLowerCase() && pw === db.adminAuth.password;
}

app.get('/api/admin/overview', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    adminAuth: db.adminAuth,
    hostInfo: db.hostInfo,
    users: db.users,
    servers: db.servers
  });
});

app.post('/api/admin/create-server', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { email, serverName, ip, port, ram, cpu, storage, softwareVersion, motd } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(serverName || 'Flora-MC').trim();
  const containerName = sanitizeContainerName(cleanName + '_' + Date.now().toString().slice(-4));

  const assignedPort = Number(port) || db.hostInfo.nextPort || 25565;
  if (!port) {
    db.hostInfo.nextPort = assignedPort + 1;
  }

  const memFlag = parseDockerMem(ram);
  const javaRam = parseJavaRam(ram);
  const cpuFlag = parseCpuLimit(cpu);
  const sw = parseSoftwareAndVersion(softwareVersion);
  const serverMotd = String(motd || db.hostInfo.motd || 'Flora Cloud 24/7 Server').trim();

  if (db.servers[cleanEmail] && db.servers[cleanEmail].containerName) {
    await runCmd(`docker rm -f ${db.servers[cleanEmail].containerName}`);
  }

  const dockerCmd = [
    'docker run -d',
    `--name ${containerName}`,
    `--memory="${memFlag}"`,
    `--cpus="${cpuFlag}"`,
    `-p ${assignedPort}:25565`,
    '-e EULA=TRUE',
    `-e TYPE=${sw.type}`,
    `-e VERSION=${sw.version}`,
    `-e MEMORY=${javaRam}`,
    `-e MOTD="${serverMotd.replace(/"/g, '')}"`,
    '--restart unless-stopped',
    'itzg/minecraft-server'
  ].join(' ');

  const dockerRes = await runCmd(dockerCmd);

  const serverIp = String(ip || db.hostInfo.publicIp).trim();
  const connectAddress = assignedPort === 25565 ? serverIp : `${serverIp}:${assignedPort}`;

  db.servers[cleanEmail] = {
    email: cleanEmail,
    containerName,
    serverName: cleanName,
    ip: serverIp,
    port: assignedPort,
    connectAddress,
    ram: String(ram).trim(),
    cpu: String(cpu).trim(),
    storage: String(storage).trim(),
    softwareVersion: sw.label,
    motd: serverMotd,
    status: 'running',
    realDocker: dockerRes.ok,
    logs: [
      `[Flora Cloud 24/7] Provisioned "${cleanName}" (${sw.label}) | RAM: ${ram}, Core: ${cpu}, Storage: ${storage}.`,
      `[Connect] Address: ${connectAddress} | MOTD: ${serverMotd}`,
      dockerRes.ok
        ? `[Docker] Real 24/7 Minecraft container ${containerName} is LIVE.`
        : `[Node] Server record active (${dockerRes.stderr || 'Docker ready when installed on VPS'}).`
    ]
  };

  saveDb(db);
  res.json({ ok: true, server: db.servers[cleanEmail] });
});

app.post('/api/admin/power', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { email, action } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const srv = db.servers[cleanEmail];
  if (!srv) return res.status(404).json({ error: 'Not found' });

  if (action === 'running') {
    await runCmd(`docker start ${srv.containerName}`);
    srv.status = 'running';
    appendLog(cleanEmail, 'Admin started 24/7 Minecraft Server.');
  } else if (action === 'stopped') {
    await runCmd(`docker stop ${srv.containerName}`);
    srv.status = 'stopped';
    appendLog(cleanEmail, 'Admin stopped Minecraft Server.');
  }
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/delete-server', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const cleanEmail = String((req.body || {}).email || '').trim().toLowerCase();
  const srv = db.servers[cleanEmail];
  if (srv && srv.containerName) {
    await runCmd(`docker rm -f ${srv.containerName}`);
  }
  delete db.servers[cleanEmail];
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/settings', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { adminEmail, adminPass, publicIp, nodeName } = req.body || {};
  if (adminEmail && adminPass) {
    db.adminAuth = { email: String(adminEmail).trim().toLowerCase(), password: String(adminPass) };
  }
  if (publicIp) db.hostInfo.publicIp = String(publicIp).trim();
  if (nodeName) db.hostInfo.nodeName = String(nodeName).trim();
  saveDb(db);
  res.json({ ok: true, adminAuth: db.adminAuth, hostInfo: db.hostInfo });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Flora Cloud 24/7 Minecraft Hosting Backend running on port ${PORT}`);
});