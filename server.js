// Kyte server: serves the phone UI, streams events, runs the agent,
// and handles approve/deny for risky actions.

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgent, capHistory } = require('./agent');
const { DATA_DIR } = require('./memory');
const { startPermissionWatch } = require('./permissions');
const { captureScreen } = require('./screen');
const { startScheduler, loadJobs, delayJob, markRan } = require('./scheduler');
const { summarizePolicy } = require('./gatekeeper');
const vault = require('./vault');
const { loadContacts } = require('./contacts');

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
  apiKey: (process.env.GEMINI_API_KEY || '').trim(),
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
};

// --- State (single conversation, persisted to disk) ---
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const history = []; // Gemini "contents"
const uiLog = []; // events replayed to the UI on connect
const clients = new Set(); // SSE responses
const approvals = new Map(); // id -> resolve(boolean)
const polls = new Map(); // id -> resolve(answers)
let busy = false;
let epoch = 0; // bumped by New chat so an in-flight run stops mutating history
let suppressEmit = false;
let loadedStateBytes = 0;

try {
  const st = fs.statSync(STATE_PATH);
  loadedStateBytes = st.size;
  if (st.size > 8 * 1024 * 1024) {
    fs.renameSync(STATE_PATH, `${STATE_PATH}.oversized`);
    loadedStateBytes = 0;
    console.error('state.json was too large to load; set it aside');
  } else {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (Array.isArray(saved.history)) history.push(...saved.history);
    if (Array.isArray(saved.uiLog)) {
      uiLog.push(...saved.uiLog.filter((ev) => {
        if (!ev || ev.type !== 'assistant') return true;
        return !/^\s*(Called [\w.-]+ with\b|Result of [\w.-]+:)/i.test(String(ev.text || ''));
      }));
    }
  }
} catch {
  /* first run — nothing saved yet */
}

let saveTimer = null;
const MAX_PERSIST_CHARS = 280_000;

function clipStored(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 800 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 240))) return '[image omitted]';
    return value.length > 1200 ? value.slice(0, 1200) + '…' : value;
  }
  if (typeof value !== 'object' || depth > 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => clipStored(v, depth + 1));
  const out = {};
  for (const k of Object.keys(value).slice(0, 20)) {
    if (/image|inlineData|screenshot|base64|bytes|buffer|buf/i.test(k)) continue;
    out[k] = clipStored(value[k], depth + 1);
  }
  return out;
}

function snapshotState() {
  try { capHistory(history); } catch { /* still persist what we can */ }
  const disk = [];
  for (const item of history) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.parts)) continue;
    const parts = [];
    for (const p of item.parts) {
      if (!p || typeof p !== 'object') continue;
      if (p.inlineData) parts.push({ text: '[image omitted]' });
      else if (typeof p.text === 'string') parts.push({ text: p.text.slice(0, 4000) });
      else if (p.functionCall) {
        const part = { functionCall: { name: p.functionCall.name, args: clipStored(p.functionCall.args) } };
        if (typeof p.thoughtSignature === 'string' && p.thoughtSignature) part.thoughtSignature = p.thoughtSignature;
        parts.push(part);
      }
      else if (p.functionResponse) parts.push({ functionResponse: { name: p.functionResponse.name, response: clipStored(p.functionResponse.response) } });
    }
    if (parts.length) disk.push({ role: item.role === 'model' ? 'model' : 'user', parts });
  }
  while (disk.length > 40) disk.shift();
  let ui = uiLog.slice(-40);
  let payload = { history: disk, uiLog: ui };
  let text = JSON.stringify(payload);
  while (text.length > MAX_PERSIST_CHARS && disk.length > 1) {
    disk.shift();
    payload = { history: disk, uiLog: ui };
    text = JSON.stringify(payload);
  }
  if (text.length > MAX_PERSIST_CHARS) {
    text = JSON.stringify({ history: disk.slice(-8), uiLog: ui.slice(-10) });
  }
  return text;
}

const fsp = fs.promises;
let saveQueue = Promise.resolve();

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    let text;
    try {
      text = snapshotState();
    } catch (e) {
      console.error('Failed to snapshot state:', e.message);
      return;
    }
    if (!text || text.length > MAX_PERSIST_CHARS) {
      try { text = JSON.stringify({ history: [], uiLog: [] }); } catch { return; }
    }
    const payload = text;
    saveQueue = saveQueue
      .then(async () => {
        await fsp.mkdir(DATA_DIR, { recursive: true });
        await fsp.writeFile(STATE_PATH, payload);
      })
      .catch((e) => console.error('Failed to save state:', e.message));
  }, 400);
}

function trimHistory() {
  try { capHistory(history); } catch (e) { console.error('trim failed:', e.message); }
}

const REPLAY_LIMIT = 40;
const UILOG_LIMIT = 80;
const OMIT_KEYS = new Set([
  'image', 'images', 'inlineData', 'screenshot', 'bytes', 'buffer', 'buf', 'png', 'jpeg', 'base64',
]);

function scrub(value, max) {
  let out = String(value == null ? '' : value);
  out = out.replace(/KYTE_PASSWORD=\S+/gi, 'KYTE_PASSWORD=••••');
  out = out.replace(/GEMINI_API_KEY=\S+/gi, 'GEMINI_API_KEY=••••');
  out = out.replace(/AIza[0-9A-Za-z\-_]{20,}/g, '••••');
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer ••••');
  if (out.length > 800 && /^[A-Za-z0-9+/=\r\n]+$/.test(out.slice(0, 240))) return '[image omitted]';
  if (out.length > max) return out.slice(0, max) + '…';
  return out;
}

function slimValue(value, depth, max) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrub(value, max);
  if (typeof value !== 'object') return undefined;
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => slimValue(v, depth + 1, max));
  const out = {};
  for (const k of Object.keys(value).slice(0, 20)) {
    if (OMIT_KEYS.has(k) || /image|screenshot|base64/i.test(k)) continue;
    if (vault.isSecretKey(k)) {
      out[k] = '••••';
      continue;
    }
    out[k] = slimValue(value[k], depth + 1, max);
  }
  return out;
}

function slimOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.slice(0, 20).map((o) => {
    if (o == null || typeof o !== 'object') {
      const label = scrub(o, 80);
      return { id: label, label };
    }
    const label = scrub(o.label || o.id || '', 120);
    return { id: scrub(o.id || o.label || '', 80), label };
  });
}

function slimFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.slice(0, 24).map((f, i) => {
    if (!f || typeof f !== 'object') {
      return { id: 'field' + i, label: scrub(f, 80), type: 'text' };
    }
    const out = {
      id: scrub(f.id || f.label || 'field' + i, 60),
      label: scrub(f.label || f.id || 'Field', 80),
      type: scrub(f.type || 'text', 20),
    };
    if (f.required) out.required = true;
    if (f.placeholder) out.placeholder = scrub(f.placeholder, 80);
    if (f.autocomplete) out.autocomplete = scrub(f.autocomplete, 40);
    const secret = vault.isSecretKey(f.id) || vault.isSecretKey(f.label);
    if (f.value != null && f.value !== '') {
      if (secret) out.value = '••••';
      else if (typeof f.value === 'boolean' || typeof f.value === 'number') out.value = f.value;
      else out.value = scrub(f.value, 300);
    }
    if (Array.isArray(f.options)) out.options = slimOptions(f.options);
    return out;
  });
}

function slimAnswers(answers) {
  if (!answers || typeof answers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(answers).slice(0, 30)) {
    if (vault.isSecretKey(k)) {
      out[k] = '••••';
      continue;
    }
    if (Array.isArray(v)) out[k] = v.slice(0, 12).map((x) => scrub(typeof x === 'string' ? x : JSON.stringify(x), 80));
    else if (v && typeof v === 'object') out[k] = scrub(JSON.stringify(v), 160);
    else if (typeof v === 'string') out[k] = scrub(v, 200);
    else if (v != null) out[k] = v;
  }
  return out;
}

function slimToolResult(result) {
  if (result == null) return {};
  if (typeof result !== 'object') return { text: scrub(result, 240) };
  const out = {};
  if (result.ok !== undefined) out.ok = Boolean(result.ok);
  if (result.status != null && typeof result.status !== 'object') out.status = result.status;
  for (const k of ['error', 'summary', 'note', 'hint', 'title', 'url']) {
    if (result[k] != null && typeof result[k] !== 'object') out[k] = scrub(result[k], k === 'error' ? 240 : 180);
  }
  if (result.text) out.text = scrub(result.text, 280);
  if (result.stdout) out.stdout = scrub(result.stdout, 280);
  if (result.stderr) out.stderr = scrub(result.stderr, 160);
  if (result.raw) out.raw = scrub(result.raw, 160);
  if (Array.isArray(result.matches)) {
    out.matches = result.matches.slice(0, 5).map((m) => ({ name: scrub(m && m.name, 80) }));
  }
  return out;
}

function slimForPhone(event) {
  if (!event || typeof event !== 'object') return { type: 'error', text: 'Dropped an unreadable update', ts: Date.now() };
  const type = String(event.type || 'note');
  const base = { type, ts: typeof event.ts === 'number' ? event.ts : Date.now() };
  switch (type) {
    case 'user':
      base.text = scrub(event.text || '', 6000);
      if (Array.isArray(event.attachments)) {
        base.attachments = event.attachments.slice(0, 12).map((a) => scrub(typeof a === 'string' ? a : a && a.name, 120));
      }
      break;
    case 'assistant':
    case 'error':
      base.text = scrub(event.text || '', 6000);
      break;
    case 'status':
      base.state = event.state || 'idle';
      if (event.note) base.note = scrub(event.note, 160);
      break;
    case 'tool_start':
    case 'gate':
      base.name = scrub(event.name || '', 80);
      if (event.args && typeof event.args === 'object') base.args = slimValue(event.args, 0, 400);
      if (event.verdict) base.verdict = scrub(event.verdict, 20);
      if (event.class) base.class = scrub(event.class, 40);
      if (event.reason) base.reason = scrub(event.reason, 240);
      break;
    case 'tool_result':
      base.name = scrub(event.name || '', 80);
      base.result = slimToolResult(event.result);
      break;
    case 'approval_request':
      base.id = String(event.id || '');
      base.name = scrub(event.name || '', 80);
      if (event.class) base.class = scrub(event.class, 40);
      if (event.reason) base.reason = scrub(event.reason, 300);
      if (event.args && typeof event.args === 'object') base.args = slimValue(event.args, 0, 800);
      break;
    case 'approval_resolved':
      base.id = String(event.id || '');
      base.approved = Boolean(event.approved);
      if (event.always) base.always = true;
      if (event.reason) base.reason = scrub(event.reason, 80);
      break;
    case 'poll':
      base.id = String(event.id || '');
      base.title = scrub(event.title || '', 200);
      if (event.context) base.context = scrub(event.context, 400);
      base.multi = Boolean(event.multi);
      base.options = slimOptions(event.options);
      break;
    case 'form':
      base.id = String(event.id || '');
      base.title = scrub(event.title || '', 200);
      if (event.context) base.context = scrub(event.context, 400);
      base.fields = slimFields(event.fields);
      break;
    case 'poll_resolved':
    case 'form_resolved':
      base.id = String(event.id || '');
      base.submitted = Boolean(event.submitted);
      if (event.reason) base.reason = scrub(event.reason, 80);
      if (event.answers) base.answers = slimAnswers(event.answers);
      break;
    case 'computer':
      if (event.summary) base.summary = scrub(event.summary, 180);
      base.done = Boolean(event.done);
      if (event.step) base.step = Number(event.step) || 0;
      break;
    case 'learned':
      base.summary = scrub(event.summary || '', 240);
      break;
    case 'schedule_run':
      base.label = scrub(event.label || '', 120);
      base.id = String(event.id || '');
      break;
    default:
      if (event.note || event.summary || event.text) {
        base.note = scrub(event.note || event.summary || event.text, 240);
      }
  }
  return base;
}

function compactUiLog() {
  const next = [];
  for (const ev of uiLog) {
    try { next.push(slimForPhone(ev)); } catch { /* drop one bad event */ }
  }
  uiLog.length = 0;
  uiLog.push(...next.slice(-UILOG_LIMIT));
}

compactUiLog();

try {
  capHistory(history, { images: 0 });
} catch {
  history.length = 0;
}
if (loadedStateBytes > 200000) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, snapshotState());
    console.error('Trimmed oversized state.json');
  } catch (e) {
    console.error('Failed to trim state.json:', e.message);
  }
}

function dropClient(res) {
  clients.delete(res);
}

function watchClient(res) {
  if (!res || res._kyteWatch) return;
  res._kyteWatch = true;
  res.on('error', () => dropClient(res));
}

function safeWrite(res, payload) {
  try {
    if (!res || res.destroyed || res.writableEnded || res.closed) {
      dropClient(res);
      return false;
    }
    res.write(payload);
    return true;
  } catch {
    dropClient(res);
    return false;
  }
}

function emit(event) {
  if (suppressEmit) return;
  let ev;
  try {
    ev = slimForPhone({ ...event, ts: Date.now() });
  } catch {
    ev = { type: 'error', text: 'Dropped an unreadable update', ts: Date.now() };
  }
  uiLog.push(ev);
  if (uiLog.length > UILOG_LIMIT) uiLog.splice(0, uiLog.length - UILOG_LIMIT);
  let payload;
  try {
    payload = `data: ${JSON.stringify(ev)}\n\n`;
  } catch {
    return;
  }
  for (const res of clients) {
    watchClient(res);
    if (!safeWrite(res, payload)) continue;
  }
  saveState();
}

function requestApproval(name, args, decision = {}) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (approvals.has(id)) {
        approvals.delete(id);
        emit({ type: 'approval_resolved', id, approved: false, reason: 'timeout' });
        resolve({ approved: false, always: false });
      }
    }, 5 * 60 * 1000);
    approvals.set(id, (payload) => {
      clearTimeout(timer);
      approvals.delete(id);
      const approved = typeof payload === 'object' ? Boolean(payload.approved) : Boolean(payload);
      const always = typeof payload === 'object' && Boolean(payload.always);
      emit({ type: 'approval_resolved', id, approved, always });
      resolve({ approved, always });
    });
    emit({ type: 'approval_request', id, name, args: vault.publicToolArgs(name, args), class: decision.class, reason: decision.reason });
  });
}

function requestPoll(payload = {}) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const kind = payload.type === 'form' ? 'form' : 'poll';
    const timer = setTimeout(() => {
      if (polls.has(id)) {
        polls.delete(id);
        emit({ type: `${kind}_resolved`, id, submitted: false, reason: 'timeout' });
        resolve({ submitted: false, reason: 'timeout', answers: null });
      }
    }, 10 * 60 * 1000);
    polls.set(id, (body) => {
      clearTimeout(timer);
      polls.delete(id);
      const answers = vault.publicAnswers(body && typeof body === 'object' ? body.answers || body : {});
      emit({ type: `${kind}_resolved`, id, submitted: true, answers });
      emit({ type: 'status', state: 'thinking', note: 'Got it — continuing…' });
      resolve({ submitted: true, answers: body && typeof body === 'object' ? body.answers || body : {} });
    });
    const event = {
      type: kind,
      id,
      title: payload.title || '',
      context: payload.context || '',
      multi: Boolean(payload.multi),
    };
    if (kind === 'form') event.fields = payload.fields || [];
    else event.options = payload.options || [];
    emit(event);
    emit({ type: 'status', state: 'waiting', note: payload.title || 'Waiting for your answer…' });
  });
}

// --- App ---
const app = express();
app.use(express.json({ limit: '8mb' }));
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
  watchClient(res);
  for (const ev of uiLog.slice(-REPLAY_LIMIT)) {
    let payload;
    try { payload = `data: ${JSON.stringify(slimForPhone(ev))}\n\n`; } catch { continue; }
    if (!safeWrite(res, payload)) break;
  }
  if (!res.destroyed && !res.writableEnded && !res.closed) clients.add(res);
  const ping = setInterval(() => {
    if (!safeWrite(res, ': ping\n\n')) clearInterval(ping);
  }, 25_000);
  const drop = () => {
    clearInterval(ping);
    dropClient(res);
  };
  req.on('close', drop);
  res.on('error', drop);
});

function beginRun(text, attachments, prelude) {
  const myEpoch = epoch;
  const live = () => epoch === myEpoch;
  // runAgent treats a true isCancelled as "stop". live() is the opposite.
  const cancelled = () => epoch !== myEpoch;
  const guarded = (ev) => { if (live()) emit(ev); };
  busy = true;
  try {
    if (prelude) prelude(guarded);
    else {
      const names = (attachments || []).map((a) => a && a.name).filter(Boolean);
      guarded({ type: 'user', text: text || '(attachment)', attachments: names });
      guarded({ type: 'status', state: 'thinking' });
    }
  } catch (e) {
    console.error('emit before run failed:', e.message);
  }
  runAgent(text, history, config, guarded, requestApproval, attachments || [], requestPoll, cancelled)
    .catch((e) => { if (live()) emit({ type: 'error', text: String(e && e.message || e).slice(0, 500) }); })
    .finally(() => {
      if (!live()) return;
      busy = false;
      try { trimHistory(); } catch { /* ignore */ }
      emit({ type: 'status', state: 'idle' });
    });
}

app.post('/api/message', (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, 12) : [];
    if (!text && !attachments.length) return res.status(400).json({ error: 'empty message' });
    if (busy) return res.status(409).json({ error: 'Kyte is still working on the previous request' });
    beginRun(text, attachments);
    res.json({ ok: true });
  } catch (e) {
    busy = false;
    console.error('message failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Couldn’t send that' });
  }
});

app.get('/api/screen', async (req, res) => {
  try {
    const buf = await captureScreen();
    res.type('image/jpeg').send(buf);
  } catch (e) {
    res.status(500).json({
      error:
        'Screen capture failed. Grant Screen Recording permission to the app that launched Kyte, then restart Kyte.',
      detail: String(e.message),
    });
  }
});

app.post('/api/approve', (req, res) => {
  const { id, approved, always } = req.body || {};
  const resolve = approvals.get(id);
  if (!resolve) return res.status(404).json({ error: 'no such pending approval' });
  resolve({ approved: Boolean(approved), always: Boolean(always) });
  res.json({ ok: true });
});

app.post('/api/poll/:id', (req, res) => {
  const resolve = polls.get(req.params.id);
  if (!resolve) return res.status(404).json({ error: 'no such pending poll' });
  resolve(req.body || {});
  res.json({ ok: true });
});

app.get('/api/vault', (req, res) => {
  res.json(vault.publicView());
});

app.get('/api/contacts', (req, res) => {
  const contacts = loadContacts()
    .map((c) => ({ name: String((c && c.name) || '').replace(/\s+/g, ' ').trim() }))
    .filter((c) => c.name && c.name.length <= 48)
    .slice(-20);
  res.json({ contacts });
});

app.post('/api/vault/profile', (req, res) => {
  const fields = req.body && typeof req.body === 'object' ? req.body.profile || req.body : {};
  res.json(vault.setProfile(fields));
});

app.post('/api/vault/account', (req, res) => {
  res.json(vault.setAccount(req.body || {}));
});

app.delete('/api/vault/account/:id', (req, res) => {
  res.json(vault.deleteAccount(req.params.id));
});

app.get('/api/schedule', (req, res) => {
  res.json({ jobs: loadJobs() });
});

app.get('/api/policy', (req, res) => {
  res.json(summarizePolicy());
});

function settlePending() {
  suppressEmit = true;
  try {
    for (const resolve of [...approvals.values()]) {
      try { resolve({ approved: false, always: false }); } catch (e) { console.error('approval cancel:', e.message); }
    }
    approvals.clear();
    for (const resolve of [...polls.values()]) {
      try { resolve({ submitted: false, reason: 'reset', answers: null }); } catch (e) { console.error('poll cancel:', e.message); }
    }
    polls.clear();
  } finally {
    suppressEmit = false;
  }
}

app.post('/api/reset', (req, res) => {
  try {
    epoch += 1;
    busy = false;
    history.length = 0;
    settlePending();
    uiLog.length = 0;
    emit({ type: 'status', state: 'idle', note: 'New conversation started.' });
    saveState();
    res.json({ ok: true });
  } catch (e) {
    console.error('reset failed:', e.message);
    try { history.length = 0; uiLog.length = 0; busy = false; } catch { /* ignore */ }
    if (!res.headersSent) res.status(500).json({ error: 'reset failed' });
  }
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

app.use((err, req, res, next) => {
  console.error('Request error:', err && err.message ? err.message : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Kyte hit an error and recovered' });
});

function fatalListen(err) {
  const code = err && err.code;
  return code === 'EADDRINUSE' || code === 'EACCES' || code === 'EADDRNOTAVAIL';
}

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && err.stack ? err.stack : err);
  if (fatalListen(err)) process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err && err.stack ? err.stack : err);
});

function recoverInterruptedRun() {
  const lastStatus = [...uiLog].reverse().find((e) => e && e.type === 'status');
  if (!lastStatus || (lastStatus.state !== 'thinking' && lastStatus.state !== 'waiting')) return;
  busy = false;
  emit({
    type: 'error',
    text: 'That run stopped when Kyte restarted. Send the question again.',
  });
  emit({ type: 'status', state: 'idle' });
  saveState();
}

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
  recoverInterruptedRun();
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
  try { startPermissionWatch(emit); } catch (e) { console.error('permission watch failed:', e.message); }
  try {
    startScheduler((job) => {
      try {
        if (busy) {
          delayJob(job.id, 30_000);
          return;
        }
        markRan(job.id);
        beginRun(job.prompt, [], (guarded) => {
          guarded({ type: 'schedule_run', label: job.label, id: job.id });
          guarded({ type: 'user', text: `Scheduled: ${job.label}` });
          guarded({ type: 'status', state: 'thinking' });
        });
      } catch (e) {
        busy = false;
        console.error('schedule failed:', e.message);
      }
    });
  } catch (e) {
    console.error('scheduler failed:', e.message);
  }
  });
  server.on('error', (err) => {
    console.error('listen failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { slimForPhone, REPLAY_LIMIT };
