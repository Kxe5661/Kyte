// Self-learning: after each job, keep what worked, what failed, and who people are.
// Playbooks are injected into the next system prompt so Kyte actually improves.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { DATA_DIR, appendMemory } = require('./memory');
const { saveContact } = require('./contacts');

const LESSONS_PATH = path.join(DATA_DIR, 'lessons.json');
const MAX_LESSONS = 80;
const MAX_PROMPT_CHARS = 3500;

const SEED = [
  {
    kind: 'playbook',
    title: 'FaceTime',
    body: 'Use facetime_call with the person\'s name. A preview with Cancel + green Call is not done — find the green Call circle and click it. Never click the gray Cancel X.',
  },
  {
    kind: 'playbook',
    title: 'Forms',
    body: 'Purchase/config/form: ask_user first for the choices you already know. If the page later shows a new decision the user has not answered, ask_user again for only that choice, then continue the original request. Do not guess. Then fill and click Submit/Continue yourself.',
  },
  {
    kind: 'playbook',
    title: 'Phone polls',
    body: 'For buy/configure/checkout: poll immediately with every question/field. Do not fetch retailer pages first. Do not chat the question. After they submit, fill Safari yourself and click the CTA.',
  },
  {
    kind: 'playbook',
    title: 'Research',
    body: 'Look this up / research: Google Search plus fetch_url on at least 3 sources. Never curl, wget, or run_shell to download a page. If fetch_url fails, try another URL and still answer. Do not click around Safari for research. Filling a form or completing a site task is different — use Safari tools / web_task.',
  },
  {
    kind: 'playbook',
    title: 'Safari web tasks',
    body: 'Complete web tasks in visible Safari.app. Find Continue/Next/Add to Bag/Check Out by DOM text, scrollIntoView, click. Scroll down if the control is off-screen. Vision only if JS and mouse both fail.',
  },
];

function emptyStore() {
  return { lessons: [], stats: {} };
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(LESSONS_PATH, 'utf8'));
    const lessons = Array.isArray(raw.lessons) ? raw.lessons : [];
    const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
    const behaviors = raw.behaviors && typeof raw.behaviors === 'object' ? raw.behaviors : {};
    if (!lessons.length) {
      const seeded = { lessons: SEED.map(seedLesson), stats, behaviors };
      saveStore(seeded);
      return seeded;
    }
    return ensureSeeds({ lessons, stats, behaviors });
  } catch {
    const seeded = { lessons: SEED.map(seedLesson), stats: {}, behaviors: {} };
    try {
      saveStore(seeded);
    } catch {
      /* first run */
    }
    return seeded;
  }
}

function seedLesson(item) {
  return {
    id: 'seed-' + norm(item.title).replace(/\s+/g, '-'),
    kind: item.kind,
    title: item.title,
    body: item.body,
    hits: 1,
    created: Date.now(),
    updated: Date.now(),
  };
}

function ensureSeeds(store) {
  let changed = false;
  for (const item of SEED) {
    const seeded = seedLesson(item);
    const existing = store.lessons.find((l) => l.id === seeded.id);
    if (!existing) {
      const byTitle = store.lessons.find((l) => similar(l.title, item.title));
      if (!byTitle) {
        store.lessons.push(seeded);
        changed = true;
      }
    } else if (item.body && existing.body !== item.body) {
      existing.body = item.body;
      existing.updated = Date.now();
      changed = true;
    }
  }
  if (changed) saveStore(store);
  return store;
}

function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LESSONS_PATH, JSON.stringify(store, null, 2));
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+@.]+/g, ' ')
    .trim();
}

function similar(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function looksSecret(s) {
  return /api[_-]?key|password\s*[:=]|secret\s*[:=]|bearer\s+[a-z0-9]|-----begin /i.test(String(s || ''));
}

function upsertLesson({ kind, title, body }) {
  const cleanTitle = String(title || '').trim().slice(0, 80);
  const cleanBody = String(body || '').trim().slice(0, 400);
  if (!cleanTitle || !cleanBody || looksSecret(cleanBody)) return null;
  const store = loadStore();
  const existing = store.lessons.find(
    (l) => l.kind === kind && (similar(l.title, cleanTitle) || similar(l.body, cleanBody))
  );
  if (existing) {
    existing.hits = (existing.hits || 1) + 1;
    existing.updated = Date.now();
    if (cleanBody.length > String(existing.body || '').length) existing.body = cleanBody;
    if (cleanTitle.length > String(existing.title || '').length) existing.title = cleanTitle;
    store.lessons = [existing, ...store.lessons.filter((l) => l !== existing)].slice(0, MAX_LESSONS);
    saveStore(store);
    return existing;
  }
  const lesson = {
    id: `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: kind || 'playbook',
    title: cleanTitle,
    body: cleanBody,
    hits: 1,
    created: Date.now(),
    updated: Date.now(),
  };
  store.lessons.unshift(lesson);
  store.lessons = store.lessons.slice(0, MAX_LESSONS);
  saveStore(store);
  return lesson;
}

function recordTool(name, ok) {
  const store = loadStore();
  const row = store.stats[name] || { ok: 0, fail: 0 };
  if (ok) row.ok += 1;
  else row.fail += 1;
  row.last = Date.now();
  store.stats[name] = row;
  saveStore(store);
}

function loadLessonsPrompt() {
  const store = loadStore();
  const ranked = [...store.lessons].sort((a, b) => {
    const weight = (l) =>
      (l.kind === 'correction' ? 20 : l.kind === 'person' ? 5 : 2) * (l.hits || 1) + (l.updated || 0) / 1e12;
    return weight(b) - weight(a);
  });
  const lines = [];
  const behaviors = store.behaviors || {};
  if (behaviors.alwaysFinishPrimary || behaviors.neverStopOnPreview) {
    lines.push('- [rule] Always finish the on-screen primary action (Call, Submit, Send, Allow). A preview is not done.');
  }
  if (behaviors.completeWithoutAsking) {
    lines.push('- [rule] Do not ask the user to tap anything on the Mac. Execute, then report.');
  }
  let used = lines.join('\n').length;
  for (const l of ranked.slice(0, 18)) {
    const prefix = l.kind === 'correction' ? 'HARD RULE' : l.kind;
    const line = `- [${prefix}] ${l.title}: ${l.body}`;
    if (used + line.length > MAX_PROMPT_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

function isCorrection(text) {
  return /\b(you (didn'?t|forgot|should(?:'ve| have)|never|always|need to|have to)|don'?t (ask|stop|do that|click cancel)|not what i|you missed|click the|try again|still didn'?t|why didn'?t|instead of|actually|wrong|incorrect|that'?s not)\b/i.test(
    String(text || '')
  );
}

function isTeaching(text) {
  return /\b(from now on|next time you|you should always|you should never|make sure you (always|never)|remember to always|learn (this|that|to)|the correct (way|behavior)|behave like|standing rule|add .{0,40}(feature|behavior))\b/i.test(
    String(text || '')
  );
}

function correctionTitle(text) {
  const t = String(text || '');
  if (/call|facetime/i.test(t)) return 'Always click Call';
  if (/submit|send|form/i.test(t)) return 'Always submit forms';
  if (/allow|permission/i.test(t)) return 'Always click Allow';
  if (/don'?t ask/i.test(t)) return 'Do not ask — execute';
  return 'Phone correction';
}

function toRule(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (/click.{0,32}call|green (call|button|camera)|didn'?t click/i.test(t)) {
    return 'Always click the green FaceTime Call button. A Cancel + Call preview is not a completed call. Never click Cancel.';
  }
  if (/click.{0,32}(submit|send)/i.test(t)) {
    return 'After filling a form, click Submit or Send yourself. Do not leave the form sitting there.';
  }
  if (/don'?t ask|stop asking/i.test(t)) {
    return 'Do not ask the user to confirm routine steps. Execute, then report what you did.';
  }
  return `Standing order from the user's phone: ${t.slice(0, 280)}`;
}

function applyBehaviorsFromText(text) {
  const t = String(text || '').toLowerCase();
  const store = loadStore();
  store.behaviors = store.behaviors || {};
  if (/click.{0,32}(call|submit|send|allow|button)|didn'?t click|finish the/.test(t)) {
    store.behaviors.alwaysFinishPrimary = true;
    store.behaviors.neverStopOnPreview = true;
  }
  if (/don'?t ask|just do it|execute/.test(t)) store.behaviors.completeWithoutAsking = true;
  saveStore(store);
  return store.behaviors;
}

function lastTurns(history, n = 6) {
  const bits = [];
  for (const msg of (history || []).slice(-n)) {
    for (const p of msg.parts || []) {
      if (p.text) bits.push(p.text.slice(0, 240));
      if (p.functionCall) bits.push(`tool:${p.functionCall.name}`);
    }
  }
  return bits.join('\n').slice(0, 1200);
}

async function captureFeedback(userText, history, config, emit) {
  if (!isCorrection(userText) && !isTeaching(userText)) return [];
  applyBehaviorsFromText(userText);
  const heuristic = upsertLesson({
    kind: 'correction',
    title: correctionTitle(userText),
    body: toRule(userText),
  });
  // Never await Gemini extract here — it sat on the ask_user hot path (~12s).
  extractLessons(
    {
      userText,
      tools: [],
      replies: [lastTurns(history)],
      failed: true,
      correction: true,
    },
    config
  )
    .then((extracted) => applyExtracted(extracted))
    .catch(() => {});
  return uniqueLessons([heuristic].filter(Boolean));
}

function compactResult(result) {
  if (!result || typeof result !== 'object') return result;
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (k === 'image' || k === 'ui' || k === 'steps') continue;
    if (typeof v === 'string') out[k] = v.slice(0, 220);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (v && typeof v === 'object') out[k] = JSON.stringify(v).slice(0, 180);
  }
  return out;
}

function heuristicLearn(trace) {
  const saved = [];
  const text = String(trace.userText || '');

  if (isCorrection(text) || isTeaching(text)) {
    const lesson = upsertLesson({
      kind: 'correction',
      title: correctionTitle(text),
      body: toRule(text),
    });
    if (lesson) saved.push(lesson);
  }

  for (const t of trace.tools || []) {
    recordTool(t.name, t.ok !== false && !t.error);
    if (t.name === 'find_contact' && t.ok) {
      const matches = t.detail && t.detail.matches;
      // matches may be a JSON string from compact
    }
    if (t.name === 'facetime_call') {
      const lesson = upsertLesson({
        kind: 'playbook',
        title: 'FaceTime',
        body: t.ok
          ? 'Calling works: Contacts search → FaceTime → click the green Call button. Do not stop on the preview.'
          : 'A FaceTime preview is not a completed call. Keep going until the green Call button is clicked and the preview is gone.',
      });
      if (lesson) saved.push(lesson);
      const handle = t.detail && t.detail.handle;
      const name = t.detail && t.detail.name;
      if (name && handle && /@|\d{6,}/.test(String(handle))) {
        saveContact({ name: String(name), phone: /\d/.test(String(handle)) && !String(handle).includes('@') ? String(handle) : '', email: String(handle).includes('@') ? String(handle) : '' }).catch(() => {});
        const person = upsertLesson({
          kind: 'person',
          title: String(name),
          body: `Call ${name} via FaceTime using ${handle}.`,
        });
        if (person) saved.push(person);
      }
    }
    if (t.name === 'use_computer' && t.ok) {
      const lesson = upsertLesson({
        kind: 'playbook',
        title: 'On-screen finish',
        body: 'When a primary button is visible (Call, Submit, Send, Allow), click it. Do not report done while it is still on screen.',
      });
      if (lesson) saved.push(lesson);
    }
    if (t.name === 'ask_user') {
      const lesson = upsertLesson({
        kind: 'playbook',
        title: 'Phone polls',
        body: 'Poll first for known choices. If Safari shows a new decision that was not in that poll, ask_user again for only those options, then continue the original request. Do not guess.',
      });
      if (lesson) saved.push(lesson);
    }
    if (t.name === 'web_task' || t.name === 'safari_click' || t.name === 'safari_fill') {
      const lesson = upsertLesson({
        kind: 'playbook',
        title: 'Safari web tasks',
        body: t.ok
          ? 'Web tasks in Safari: open, fill, scroll to the CTA, click Submit/Continue/Next/Add to Bag yourself. Never Chrome. Vision only if JS and mouse fail.'
          : 'Do not stop after filling. Scroll to and click Submit/Continue/Next/Add to Bag in Safari. JS first, then mouse, vision last.',
      });
      if (lesson) saved.push(lesson);
    }
  }

  const personNum = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)[^\n]{0,24}(\+?\d[\d\s().-]{7,}\d)/.exec(text);
  if (personNum) {
    saveContact({ name: personNum[1], phone: personNum[2].replace(/[^\d+]/g, '') }).catch(() => {});
    const person = upsertLesson({
      kind: 'person',
      title: personNum[1],
      body: `${personNum[1]}'s number is ${personNum[2]}.`,
    });
    if (person) saved.push(person);
    appendMemory(`${personNum[1]}: ${personNum[2]}`).catch(() => {});
  }

  return saved;
}

async function extractLessons(trace, config) {
  if (!config?.apiKey) return [];
  const tools = (trace.tools || []).slice(-12).map((t) => ({
    name: t.name,
    ok: t.ok,
    error: t.error,
    detail: t.detail,
  }));
  if (!tools.length && !isCorrection(trace.userText)) return [];

  const prompt = [
    trace.correction
      ? `The user is CORRECTING Kyte from their iPhone. Turn this into 1-3 standing rules Kyte must follow forever, written as imperatives.`
      : `You are Kyte's memory. Extract 0-3 DURABLE lessons that will make the NEXT job better.`,
    `Skip one-off chatter. Prefer: how to finish a UI, who people are, user preferences, corrections, what failed and the fix.`,
    `body must be an instruction ("Always click the green Call button"), not a recap of this chat.`,
    `Return JSON only: {"lessons":[{"kind":"playbook|correction|preference|person","title":"...","body":"..."}]}`,
    `If nothing durable: {"lessons":[]}`,
    ``,
    `User: ${String(trace.userText || '').slice(0, 800)}`,
    `Tools: ${JSON.stringify(tools).slice(0, 3500)}`,
    `Reply: ${String((trace.replies || []).slice(-1)[0] || '').slice(0, 600)}`,
    `Outcome: ${trace.failed ? 'failed or stopped short' : 'finished'}`,
  ].join('\n');

  const models = [config.model || 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-flash-latest'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json();
      if (!res.ok) continue;
      const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n');
      const json = text.replace(/^```json\s*|```$/g, '').trim();
      const start = json.indexOf('{');
      const end = json.lastIndexOf('}');
      if (start < 0) return [];
      const parsed = JSON.parse(json.slice(start, end + 1));
      return Array.isArray(parsed.lessons) ? parsed.lessons.slice(0, 3) : [];
    } catch {
      /* try next model */
    }
  }
  return [];
}

function uniqueLessons(saved) {
  const unique = [];
  const seen = new Set();
  for (const l of saved) {
    if (!l || seen.has(l.id)) continue;
    seen.add(l.id);
    unique.push(l);
  }
  return unique;
}

function applyExtracted(extracted) {
  const saved = [];
  for (const item of extracted || []) {
    const lesson = upsertLesson(item);
    if (lesson) saved.push(lesson);
    if (item.kind === 'preference' && item.body) {
      appendMemory(item.body).catch(() => {});
    }
    if (item.kind === 'person' && item.title) {
      const phone = (/\+?\d[\d\s().-]{6,}\d/.exec(item.body || '') || [])[0];
      const email = (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(item.body || '') || [])[0];
      if (phone || email) {
        saveContact({ name: item.title, phone: phone || '', email: email || '' }).catch(() => {});
      }
    }
  }
  return uniqueLessons(saved);
}

function learnFromRun(trace, config, emit) {
  const saved = uniqueLessons(heuristicLearn(trace));
  if (isCorrection(trace.userText) || isTeaching(trace.userText)) return saved;
  extractLessons(trace, config)
    .then((extracted) => {
      const extra = applyExtracted(extracted);
      if (extra.length && emit) {
        emit({
          type: 'learned',
          summary: extra.slice(0, 3).map((l) => l.title).join(' · '),
        });
      }
    })
    .catch(() => {});
  return saved;
}

module.exports = {
  loadLessonsPrompt,
  learnFromRun,
  captureFeedback,
  isCorrection,
  isTeaching,
  upsertLesson,
  compactResult,
  LESSONS_PATH,
};
