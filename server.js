// Kyte server: serves the phone UI, streams events, runs the agent,
// and handles approve/deny for risky actions.

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { runAgent } = require('./agent');
const { DATA_DIR } = require('./memory');

const PORT = Number(process.env.PORT || 3171);

// --- Password: generate one on first launch if not set ---
let PASSWORD = process.env.KYTE_PASSWORD;
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(4).toString('hex'); // e.g. "a3f09c21"
  const envPath = path.join(__dirname, '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  if (/^KYTE_PASSWORD=\s*$/m.test(existing)) {
    fs.writeFileSync(envPath, existing.replace(/^KYTE_PASSWORD=\s*$/m, `KYTE_PASSWORD=${PASSWORD}`));
  } else {
    fs.writeFileSync(envPath, existing + (existing.endsWith('\n') || !existing ? '' : '\n') + `KYTE_PASSWORD=${PASSWORD}\n`);
  }
  console.log(`\n  Generated a password and saved it to .env`);
}

const config = {
  apiKey: process.env.GEMINI_API_KEY || '',
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
};

// --- State (single conversation, persisted to disk) ---
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const history = []; // Gemini "contents"
const uiLog = []; // events replayed to the UI on connect
const clients = new Set(); // SSE responses
const approvals = new Map(); // id -> resolve(boolean)
let busy = false;

try {
  const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  history.push(...(saved.history || []));
  uiLog.push(...(saved.uiLog || []));
} catch {
  /* first run — nothing saved yet */
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_PATH, JSON.stringify({ history, uiLog }));
    } catch (e) {
      console.error('Failed to save state:', e.message);
    }
  }, 400);
}

// Keep history from growing forever: trim oldest turns at a safe boundary
// (a user text message) so function call/response pairs stay intact.
function trimHistory() {
  const MAX = 240;
  while (history.length > MAX) {
    history.shift();
    while (history.length && !(history[0].role === 'user' && history[0].parts?.some((p) => p.text))) {
      history.shift();
    }
  }
}

function emit(event) {
  const ev = { ...event, ts: Date.now() };
  uiLog.push(ev);
  if (uiLog.length > 500) uiLog.splice(0, uiLog.length - 500);
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(payload);
  saveState();
}

function requestApproval(name, args) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (approvals.has(id)) {
        approvals.delete(id);
        emit({ type: 'approval_resolved', id, approved: false, reason: 'timeout' });
        resolve(false);
      }
    }, 5 * 60 * 1000);
    approvals.set(id, (approved) => {
      clearTimeout(timer);
      approvals.delete(id);
      emit({ type: 'approval_resolved', id, approved });
      resolve(approved);
    });
    emit({ type: 'approval_request', id, name, args });
  });
}

// --- App ---
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function authorized(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.auth;
  return token === PASSWORD;
}

app.use('/api', (req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// Live event stream (replays recent log on connect)
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const ev of uiLog) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

app.post('/api/message', (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty message' });
  if (busy) return res.status(409).json({ error: 'Kyte is still working on the previous request' });

  busy = true;
  emit({ type: 'user', text });
  emit({ type: 'status', state: 'thinking' });
  runAgent(text, history, config, emit, requestApproval)
    .catch((e) => emit({ type: 'error', text: String(e.message) }))
    .finally(() => {
      busy = false;
      trimHistory();
      emit({ type: 'status', state: 'idle' });
    });
  res.json({ ok: true });
});

// --- Live Screen: capture the Mac's display for the phone ---
// Needs macOS Screen Recording permission for your terminal the first time.
let lastShot = { t: 0, buf: null };
let capturing = false;
app.get('/api/screen', async (req, res) => {
  if (lastShot.buf && Date.now() - lastShot.t < 700) {
    return res.type('image/jpeg').send(lastShot.buf);
  }
  if (capturing && lastShot.buf) {
    return res.type('image/jpeg').send(lastShot.buf);
  }
  capturing = true;
  const tmp = path.join(os.tmpdir(), 'kyte-screen.jpg');
  try {
    await new Promise((resolve, reject) =>
      execFile('screencapture', ['-x', '-t', 'jpg', tmp], (err) => (err ? reject(err) : resolve()))
    );
    // Downscale to keep the stream light over Wi-Fi.
    await new Promise((resolve) =>
      execFile('sips', ['-Z', '1280', tmp], () => resolve())
    );
    const buf = fs.readFileSync(tmp);
    lastShot = { t: Date.now(), buf };
    res.type('image/jpeg').send(buf);
  } catch (e) {
    res.status(500).json({
      error:
        'Screen capture failed. Grant Screen Recording permission to your terminal in System Settings → Privacy & Security → Screen Recording, then restart Kyte.',
      detail: String(e.message),
    });
  } finally {
    capturing = false;
  }
});

app.post('/api/approve', (req, res) => {
  const { id, approved } = req.body || {};
  const resolve = approvals.get(id);
  if (!resolve) return res.status(404).json({ error: 'no such pending approval' });
  resolve(Boolean(approved));
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  history.length = 0;
  uiLog.length = 0;
  emit({ type: 'status', state: 'idle', note: 'New conversation started.' });
  saveState();
  res.json({ ok: true });
});

// Which Gemini models does your key have access to?
app.get('/api/models', async (req, res) => {
  if (!config.apiKey) return res.status(400).json({ error: 'GEMINI_API_KEY not set in .env' });
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(config.apiKey)}`
    );
    const data = await r.json();
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
    res.json({ current: config.model, available: names });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = Object.values(nets)
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);

  console.log(`\n  Kyte is flying.\n`);
  console.log(`  On this Mac:    http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  On your iPhone: http://${ip}:${PORT}  (same Wi-Fi)`);
  console.log(`\n  Password: ${PASSWORD}`);
  console.log(`  Model:    ${config.model}${config.apiKey ? '' : '   ⚠ no GEMINI_API_KEY set yet — see .env.example'}\n`);
});
