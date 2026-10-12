// Kyte's brain: plan, then execute. Google Search + tools. Almost no interruptions.

const os = require('os');
const { TOOL_DECLARATIONS, executeTool, readTextCap } = require('./tools');
const { loadMemory } = require('./memory');
const { decide, remember } = require('./gatekeeper');
const { loadLessonsPrompt, learnFromRun, captureFeedback, isCorrection, isTeaching, compactResult } = require('./learn');
const vault = require('./vault');
const { localAvailable, preferGoogle, callLocal, callGrok } = require('./llm');

const MAX_STEPS = 24;

function systemPrompt() {
  const lines = [
    `You are Kyte — a personal chief of staff running on the user's Mac (${os.hostname()}, macOS).`,
    `You think like a sharp, detail-obsessed operator: anticipate the next question, catch missing pieces, finish the job.`,
    `The user usually messages from their iPhone. Lead with the answer, then the evidence. No filler.`,
    `Never show tool names, JavaScript, or lines like "Called safari_…". Those stay internal.`,
    `Current date/time: ${new Date().toString()}.`,
    ``,
    `Autonomy:`,
    `- The user already trusted you. Do not ask permission for routine work. Execute.`,
    `- If they said do X, do all of X — not the first step, then wait.`,
    `- Only pause if a required fact is missing or a decision would change the action — and pause via ask_user on the phone, not by chatting a question.`,
    `- Never ask them to approve opening apps, visiting sites, searching, reading files, or researching.`,
    `- If macOS shows an Allow/permission popup, call approve_system_dialog and keep going. Do not tell the user to walk over to the Mac.`,
    ``,
    `Research (this is a hard rule):`,
    `- "Look this up", "research", "what's the best…", price questions, retailer questions (Best Buy, Amazon, Apple, Google Store) — do NOT click around Safari and do NOT download pages from the shell.`,
    `- Use Google Search when the API allows it, plus fetch_url on at least 3 independent sources (retailer + manufacturer + a review or comparison).`,
    `- fetch_url is the only way to read a page. Never curl, wget, python, or run_shell to fetch a URL.`,
    `- Then optionally safari_open so they can see the best page in Safari.`,
    `- Report: headline recommendation, price/availability, key specs, tradeoffs, and the links you used.`,
    `- If fetch_url fails, times out, or the page is thin, immediately try another URL. A tool error is data — answer from the sources that worked.`,
    `- Exception: buy / configure / reserve / fill-a-form (monthly vs unlocked, color, store, checkout fields) is NOT research. Poll first, then act on the site.`,
    ``,
    `Web tasks (this is a hard rule — separate from research):`,
    `- Filling a form, searching ON a site, signing in, booking, submitting, completing a page — use Safari tools. Never Chrome, never Playwright, never a hidden browser.`,
    `- Prefer web_task for an end-to-end job: it opens real Safari.app (visible on the Mac / Live Screen), goes to the URL or searches, fills from the goal + memory, clicks Submit/Search/Continue/Next/Add to Bag/Check Out itself, then reads the result.`,
    `- Or step through: safari_open → safari_fill → safari_click → safari_read. safari_eval runs JS in the current tab. safari_tabs lists tabs.`,
    `- fetch_url is READ-ONLY research. It cannot fill or submit. Do not stop after fetch_url when they asked you to complete a site task.`,
    `- Always finish the last click (Submit, Search, Continue, Next, Add to Bag, Check Out, Check Availability, Sign in, Send) yourself — same as FaceTime Call. The user is not at the Mac.`,
    `- Prefer DOM: find the button by visible text, scrollIntoView, click. If the next control is not on screen, scroll down (fast) and keep going. Do not sit and stare.`,
    `- use_computer / Gemini vision is LAST RESORT — only if Safari JS click and the mouse both fail. Never stack vision on top of a working JS click.`,
    `- If JavaScript from Apple Events is off, the Safari tools fall back to the mouse on the visible Safari window, then vision only if that also fails.`,
    ``,
    `Communications:`,
    `- Calling: facetime_call with the person's NAME. That opens Contacts, searches, clicks FaceTime, then MUST click the green Call button. A preview with Cancel + Call is not done. Do not ask for a number first. Do not stop at find_contact.`,
    `- Texting: find_contact then send_imessage. If no number, ask_user once for it.`,
    `- Never mention macOS Contacts, permission dialogs, or why a number is missing. Just ask_user for it.`,
    `- Do not invent AppleScript for Messages or FaceTime.`,
    `- If multiple contacts match, ask_user which one — otherwise send/call.`,
    `- Only text or call when they clearly asked you to.`,
    ``,
    `Mac control:`,
    `- open_app for launching native apps. Web pages and forms go through Safari tools, not Chrome. run_shell is for system facts only — never curl, wget, or any HTTP fetch. run_applescript only when no dedicated tool exists.`,
    `- Never rm, sudo, or overwrite credentials unless they explicitly named that exact action.`,
    `- If a tool fails, try a different method once, then report what blocked you and what you still accomplished.`,
    ``,
    `Phone polls (this is a hard rule):`,
    `- Purchase, product config, checkout, or any form that needs a decision or personal fields: call ask_user FIRST with every choice you already know about, THEN open Safari and act. Do not research-loop before that first poll.`,
    `- Read the page once with safari_read. It returns every decision on the page at once (decisions: question + options) plus the next buttons.`,
    `- If any of those decisions are not already answered, call ask_user ONE time with type=form and a select field for EVERY unanswered question. Never poll them one by one when they are all on the page.`,
    `- Then apply every answer and finish the original request. Do not guess. Do not start over. Do not call see_screen to discover choices.`,
    `- type=choice for decisions. type=form for info needed to submit on a website.`,
    `- Do NOT chat the question as markdown. Do not ask them to walk to the Mac.`,
    `- After they submit, enter it yourself in Safari and click the next step.`,
    `- Prefill from the autofill profile when autocomplete keys match. After a form, remember non-secret answers with vault_set / save_memory.`,
    `- For site passwords: safari_fill with from_vault:true and field/account set to the site name (e.g. "amazon"). Never put a password in chat or tool args.`,
    `- vault_get shows profile + account labels only. If a password is missing, tell them to add it under Autofill → Accounts on the phone, then continue.`,
    ``,
    `Memory: save lasting preferences, people, and routines with save_memory. A background learner files playbooks after each job.`,
    `Phone corrections are standing orders. If they tell you what you should have done, DO that action now and keep doing it forever. Do not only apologize. HARD RULES in the playbooks override habit.`,
    `When they attach files, treat them as first-class context and use them.`,
    ``,
    `Scheduling: if they want something repeating ("every 2 weeks fill out this form", "every morning at 8"), use schedule_task. Each run is a full job — research, fetch, open, fill — not a reminder.`,
    `Screen: after opening an app, always finish the last click yourself (Call, Submit, Send, Allow) — same as submitting a form. If a preview is sitting there, facetime_call / web_task / safari_click / use_computer must click Call or Submit. The user will not be at the Mac.`,
    `see_screen is only for a single look. Prefer use_computer for any multi-step UI job.`,
    `A separate gatekeeper allows, denies, or asks. Do not pause yourself for routine work. If a tool comes back denied, do not retry it.`,
  ];
  const memory = loadMemory();
  if (memory) {
    lines.push('', 'Long-term memory:', memory);
  }
  try {
    const pub = vault.publicView();
    const facts = Object.entries(pub.profile || {}).filter(([, v]) => v);
    if (facts.length) {
      lines.push('', 'Autofill profile (use when filling sites; never print passwords):', facts.map(([k, v]) => `${k}: ${v}`).join(', '));
    }
    if (pub.accounts && pub.accounts.length) {
      lines.push(
        'Saved accounts (labels only): ' +
          pub.accounts.map((a) => `${a.site || 'site'}${a.username ? ` (${a.username})` : ''}${a.has_secret ? '' : ' — no password yet'}`).join(', ')
      );
    }
  } catch {
    /* vault is optional */
  }
  const lessons = loadLessonsPrompt();
  if (lessons) {
    lines.push('', 'Self-taught playbooks (earned from past jobs — follow them):', lessons);
  }
  return lines.join('\n').slice(0, 24_000);
}

const FALLBACK_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status) {
  return status === 429 || status === 503;
}

function geminiTools(includeSearch) {
  const tools = [];
  if (includeSearch) tools.push({ googleSearch: {} });
  tools.push({ functionDeclarations: TOOL_DECLARATIONS });
  return tools;
}

const MAX_TURNS = 40;
const MAX_PART_TEXT = 12_000;
const MAX_IMAGE_CHARS = 280_000;
const SEND_BUDGET = 450_000;

function clipDeep(value, depth = 0, budget = null) {
  const book = budget || { n: 0, max: 6000 };
  if (book.n >= book.max) return undefined;
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 800 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 240))) {
      book.n += 16;
      return '[image omitted]';
    }
    const take = Math.min(value.length, 2000, book.max - book.n);
    if (take <= 0) return undefined;
    book.n += take;
    return value.length > take ? value.slice(0, take) + '…' : value;
  }
  if (typeof value !== 'object' || depth > 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => clipDeep(v, depth + 1, book));
  const out = {};
  for (const k of Object.keys(value).slice(0, 16)) {
    if (/image|inlineData|screenshot|base64|bytes|buffer|buf/i.test(k)) continue;
    out[k] = clipDeep(value[k], depth + 1, book);
  }
  return out;
}

function slimStoredPart(p, allowImage) {
  if (!p || typeof p !== 'object') return null;
  if (p.inlineData || p.fileData) {
    const data = p.inlineData ? String(p.inlineData.data || '') : '';
    if (!allowImage || !p.inlineData || data.length === 0 || data.length > MAX_IMAGE_CHARS) {
      return { text: '[image omitted]' };
    }
    return { inlineData: { mimeType: String(p.inlineData.mimeType || 'image/jpeg').slice(0, 80), data } };
  }
    if (p.functionCall && typeof p.functionCall === 'object') {
    const out = { functionCall: { name: String(p.functionCall.name || '').slice(0, 80), args: clipDeep(p.functionCall.args || {}) } };
    if (typeof p.thoughtSignature === 'string' && p.thoughtSignature.length > 0) {
      out.thoughtSignature = p.thoughtSignature;
    }
    return out;
  }
  if (p.functionResponse && typeof p.functionResponse === 'object') {
    const out = {
      functionResponse: {
        name: String(p.functionResponse.name || '').slice(0, 80),
        response: clipDeep(p.functionResponse.response || {}),
      },
    };
    if (typeof p.thoughtSignature === 'string' && p.thoughtSignature.length > 0 && p.thoughtSignature.length <= 4000) {
      out.thoughtSignature = p.thoughtSignature;
    }
    return out;
  }
  if (typeof p.text === 'string') {
    const out = { text: p.text.length > MAX_PART_TEXT ? p.text.slice(0, MAX_PART_TEXT) + '…' : p.text };
    if (typeof p.thoughtSignature === 'string' && p.thoughtSignature.length > 0 && p.thoughtSignature.length <= 4000) {
      out.thoughtSignature = p.thoughtSignature;
    }
    return out;
  }
  return { text: '[omitted]' };
}

// Drop stale screenshots and oversized tool payloads so one long run
// cannot JSON.stringify the process into an out-of-memory kill.
function capHistory(history, opts = {}) {
  if (!Array.isArray(history)) return;
  const maxImages = opts.images === 0 ? 0 : 1;
  let images = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (!item || typeof item !== 'object' || !Array.isArray(item.parts)) continue;
    const modelTurn = item.role === 'model';
    for (let j = item.parts.length - 1; j >= 0; j--) {
      const p = item.parts[j];
      const allowImage = !modelTurn && images < maxImages;
      const slim = slimStoredPart(p, allowImage);
      if (slim && slim.inlineData) images += 1;
      item.parts[j] = slim || { text: '[omitted]' };
    }
  }
  while (history.length > MAX_TURNS) history.shift();
  if (history.length && history[0].role !== 'user') {
    history.unshift({
      role: 'user',
      parts: [{ text: 'Continue the original request. Use the later tool results. Do not repeat old tool calls.' }],
    });
  }
}

function stringSize(value, depth = 0) {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object' || depth > 4) return 0;
  if (Array.isArray(value)) return value.reduce((n, v) => n + stringSize(v, depth + 1), 0);
  let n = 0;
  for (const k of Object.keys(value)) n += stringSize(value[k], depth + 1);
  return n;
}

function approxHistoryChars(history) {
  let n = 0;
  for (const item of history || []) {
    for (const p of (item && item.parts) || []) {
      if (!p) continue;
      if (typeof p.text === 'string') n += p.text.length;
      if (p.inlineData && p.inlineData.data) n += String(p.inlineData.data).length;
      if (typeof p.thoughtSignature === 'string') n += p.thoughtSignature.length;
      if (p.functionCall) n += stringSize(p.functionCall);
      if (p.functionResponse) n += stringSize(p.functionResponse);
      n += 40;
    }
  }
  return n;
}

function shrinkForSend(history) {
  capHistory(history, { images: 1 });
  let guard = 0;
  while (approxHistoryChars(history) > SEND_BUDGET && history.length > 2 && guard < 12) {
    guard += 1;
    capHistory(history, { images: 0 });
    history.splice(0, Math.max(1, Math.ceil(history.length / 3)));
    capHistory(history, { images: 0 });
  }
}

function stripModelMedia(content) {
  if (!content || typeof content !== 'object') return { role: 'model', parts: [{ text: '' }] };
  const parts = [];
  for (const p of content.parts || []) {
    if (!p || typeof p !== 'object') continue;
    if (p.inlineData || p.fileData) {
      parts.push({ text: '[image omitted]' });
      continue;
    }
    const next = {};
    if (typeof p.text === 'string') next.text = p.text.length > MAX_PART_TEXT ? p.text.slice(0, MAX_PART_TEXT) + '…' : p.text;
    if (p.functionCall && typeof p.functionCall === 'object') next.functionCall = p.functionCall;
    if (typeof p.thoughtSignature === 'string' && p.thoughtSignature.length > 0 && (next.text || next.functionCall)) {
      next.thoughtSignature = p.thoughtSignature;
    }
    if (next.text || next.functionCall) parts.push(next);
  }
  if (!parts.length) parts.push({ text: '' });
  return { role: content.role === 'user' ? 'user' : 'model', parts };
}

function hasSignature(part) {
  return part && typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0;
}

function isToolEcho(text) {
  return /^\s*(Called [\w.-]+ with\b|Result of [\w.-]+:|\[internal\])/i.test(String(text || ''));
}

// Gemini 3 rejects a follow-up if a tool call is missing its thought signature.
// Poll answers must still be usable, so unsigned calls become plain text.
function rewriteUnsignedCalls(history) {
  if (!Array.isArray(history)) return;
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (!item || item.role !== 'model' || !Array.isArray(item.parts)) continue;
    const unsigned = item.parts.filter((p) => p && p.functionCall && !hasSignature(p));
    if (!unsigned.length) continue;
    const names = new Set(unsigned.map((p) => p.functionCall.name));
    item.parts = item.parts.map((p) => {
      if (!p || !p.functionCall || hasSignature(p)) return p;
      return { text: `[internal] Used ${p.functionCall.name}. Continue the user's request. Do not mention tools or this note.` };
    });
    const next = history[i + 1];
    if (!next || !Array.isArray(next.parts)) continue;
    if (!next.parts.some((p) => p && p.functionResponse && names.has(p.functionResponse.name))) continue;
    next.parts = next.parts.map((p) => {
      if (!p || !p.functionResponse || !names.has(p.functionResponse.name)) return p;
      let body = '';
      try { body = JSON.stringify(p.functionResponse.response || {}).slice(0, 500); } catch { body = ''; }
      return { text: `[internal] ${p.functionResponse.name} finished. ${body} Do not quote this to the user.` };
    });
  }
  for (const item of history) {
    if (!item || !Array.isArray(item.parts)) continue;
    const kept = item.parts.filter((p) => !(p && p.text && isToolEcho(p.text) && /Called |Result of /.test(p.text)));
    if (kept.length !== item.parts.length) item.parts = kept.length ? kept : [{ text: '[internal] Continue the user\'s request without describing tools.' }];
  }
}

function geminiBody(history, includeSearch) {
  rewriteUnsignedCalls(history);
  shrinkForSend(history);
  if (!history.length) {
    throw new Error('I lost the thread on that one. Send the request once more.');
  }
  return JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt() }] },
    contents: history,
    tools: geminiTools(includeSearch),
  });
}

async function callGeminiOnce(history, config, model, includeSearch) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  let body;
  try {
    body = geminiBody(history, includeSearch);
  } catch {
    throw new Error('Conversation is too large to send');
  }
  if (body.length > 800_000) {
    capHistory(history, { images: 0 });
    while (history.length > 6) history.shift();
    try {
      body = geminiBody(history, includeSearch);
    } catch {
      throw new Error('Conversation is too large to send');
    }
  }
  if (body.length > 800_000) throw new Error('Conversation is too large to send');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('Gemini took too long and was stopped');
    }
    throw err;
  }
  const text = await readTextCap(res, 1_200_000);
  if (!res.ok) {
    const err = new Error(`Gemini API error ${res.status}: ${text.slice(0, 800)}`);
    err.status = res.status;
    err.body = text.slice(0, 2000);
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Gemini returned a response that could not be read');
  }
  const content = data.candidates?.[0]?.content;
  if (!content) {
    throw new Error(`Gemini returned no candidates: ${text.slice(0, 500)}`);
  }
  return stripModelMedia(content);
}

async function callGemini(history, config, emit, stop = () => false) {
  const halted = () => {
    try { return Boolean(stop()); } catch { return false; }
  };
  const models = [config.model, ...FALLBACK_MODELS.filter((m) => m !== config.model)];
  let lastError;
  let includeSearch = true;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (halted()) return null;
      try {
        return await callGeminiOnce(history, config, model, includeSearch);
      } catch (err) {
        if (halted()) return null;
        lastError = err;
        const body = String(err.body || err.message || '');
        if (includeSearch && /googleSearch|functionDeclarations|Tool use|INVALID_ARGUMENT/i.test(body) && err.status === 400) {
          includeSearch = false;
          try { emit({ type: 'status', state: 'thinking', note: 'Search tool unavailable on this model — continuing without it.' }); } catch { /* ignore */ }
          continue;
        }
        if (!isRetryable(err.status)) throw err;
        try { emit({ type: 'status', state: 'thinking', note: `${model} is busy — retrying…` }); } catch { /* ignore */ }
        await sleep(800 * (attempt + 1));
        if (halted()) return null;
      }
    }
    if (halted()) return null;
    try { emit({ type: 'status', state: 'thinking', note: `${model} is overloaded — switching models…` }); } catch { /* ignore */ }
  }
  throw lastError;
}

function buildUserParts(userText, attachments = []) {
  const parts = [];
  if (userText) parts.push({ text: userText });
  let images = 0;
  for (const att of attachments) {
    if (!att || !att.data) continue;
    const mime = att.mime || 'application/octet-stream';
    if (mime.startsWith('image/')) {
      const data = String(att.data);
      images += 1;
      if (images > 1 || data.length > MAX_IMAGE_CHARS) {
        parts.push({ text: `\n\nAttached image "${att.name || 'image'}" was too large to keep.` });
      } else {
        parts.push({ inlineData: { mimeType: mime, data } });
      }
    } else if (mime.startsWith('text/') || /json|javascript|xml|csv|markdown/.test(mime)) {
      try {
        const decoded = Buffer.from(att.data, 'base64').toString('utf8').slice(0, 80_000);
        parts.push({ text: `\n\nAttached file "${att.name}":\n${decoded}` });
      } catch {
        parts.push({ text: `\n\nAttached file "${att.name}" (${mime}) could not be decoded.` });
      }
    } else {
      parts.push({ text: `\n\nAttached file "${att.name}" (${mime}). Binary files are stored as context only — ask if you need them interpreted.` });
    }
  }
  if (!parts.length) parts.push({ text: '(empty message with attachments)' });
  return parts;
}

function closeDanglingToolCalls(history) {
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (!item || !Array.isArray(item.parts)) continue;
    const calls = item.parts.filter((p) => p && p.functionCall).map((p) => p.functionCall);
    if (!calls.length) continue;
    const next = history[i + 1];
    const answered = next && (next.parts || []).some((p) => p.functionResponse);
    if (answered) continue;
    history.splice(i + 1, 0, {
      role: 'user',
      parts: calls.map((c) => ({
        functionResponse: {
          name: c.name,
          response: { error: 'Previous tool call was interrupted. Continue from here.' },
        },
      })),
    });
  }
}

function runBoundedTool(name, args, requestPoll) {
  if (name === 'ask_user') return executeTool(name, args, { requestPoll });
  const ms = name === 'use_computer' || name === 'web_task' || name === 'facetime_call' ? 6 * 60 * 1000 : 60_000;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([executeTool(name, args, { requestPoll }), timeout]).finally(() => clearTimeout(timer));
}

async function runAgent(userText, history, config, emit, requestApproval, attachments = [], requestPoll, isCancelled = () => false) {
  const stop = () => {
    try { return typeof isCancelled === 'function' && Boolean(isCancelled()); } catch { return false; }
  };
  const say = (ev) => {
    if (stop()) return;
    try { emit(ev); } catch { /* a bad listener must not kill the run */ }
  };

  const localOk = await localAvailable();
  const grokOn = Boolean(String(process.env.XAI_API_KEY || '').trim());
  if (!grokOn && !config.apiKey && !localOk) {
    say({
      type: 'error',
      text: 'No model is available. Set an xAI key, start a local model, or set GEMINI_API_KEY in .env, then restart Kyte.',
    });
    return;
  }
  let brain = grokOn ? 'grok' : (localOk && !preferGoogle(userText) ? 'local' : 'google');
  if (brain === 'google' && !config.apiKey) brain = localOk ? 'local' : 'grok';

  const trace = { userText, tools: [], replies: [], failed: false };
  try {
    if (stop()) return;
    closeDanglingToolCalls(history);
    let filed = [];
    try {
      filed = await captureFeedback(userText, history, config, emit);
    } catch {
      filed = [];
    }
    if (stop()) return;
    const parts = buildUserParts(userText, attachments);
    if (isCorrection(userText) || isTeaching(userText)) {
      parts.push({
        text: '\n\n[This is a correction from the user\'s iPhone. Learn the intended behavior as a standing rule, then DO the corrected action in this turn. Do not only acknowledge it.]',
      });
    }
    history.push({ role: 'user', parts });
    if (filed.length) {
      say({ type: 'learned', summary: filed.slice(0, 3).map((l) => l.title).join(' · ') });
    }
    if (brain === 'grok') {
      say({ type: 'status', state: 'thinking', note: 'Thinking with Grok' });
    } else if (brain === 'local') {
      say({ type: 'status', state: 'thinking', note: 'Thinking on this Mac' });
    } else if (localOk) {
      say({ type: 'status', state: 'thinking', note: 'Using Google for this one' });
    }

    for (let step = 0; step < MAX_STEPS; step++) {
      if (stop()) return;
      try { capHistory(history); } catch { /* keep the run alive */ }
      let content;
      try {
        content = brain === 'grok'
          ? await callGrok(history, systemPrompt())
          : brain === 'local'
            ? await callLocal(history, systemPrompt())
            : await callGemini(history, config, emit, stop);
      } catch (err) {
        if (stop()) throw err;
        if (brain === 'grok' && localOk) {
          brain = 'local';
          say({ type: 'status', state: 'thinking', note: 'Grok stalled — continuing on this Mac' });
          content = await callLocal(history, systemPrompt());
        } else if (brain !== 'google' && config.apiKey) {
          brain = 'google';
          say({ type: 'status', state: 'thinking', note: 'Handing this step to Google' });
          content = await callGemini(history, config, emit, stop);
        } else {
          throw err;
        }
      }
      if (stop() || !content) return;
      history.push(content);

      const replyParts = content.parts || [];
      const text = replyParts.filter((p) => p && p.text).map((p) => p.text).join('\n').trim();
      const calls = replyParts.filter((p) => p && p.functionCall).map((p) => p.functionCall);

      if (text && !isToolEcho(text)) {
        say({ type: 'assistant', text });
        trace.replies.push(text);
      }
      if (calls.length === 0) return;

      const responseParts = [];
      for (const call of calls) {
        if (stop()) return;
        const name = call.name;
        let args = call.args || {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = { raw: args }; }
        }
        const repeats = trace.tools.filter((t) => t.name === name).length;
        if (repeats >= 4) {
          const result = { error: 'That tool already ran several times. Stop repeating it. Click the next button once, or tell the user what is blocking you.' };
          trace.tools.push({ name, ok: false, error: result.error, detail: {} });
          say({ type: 'tool_result', name, result });
          responseParts.push({ functionResponse: { name, response: result } });
          continue;
        }
        say({ type: 'tool_start', name, args: vault.publicToolArgs(name, args) });

        let decision;
        try {
          decision = decide(name, args);
        } catch (e) {
          decision = { verdict: 'allow', class: 'unknown', reason: `Gatekeeper recovered: ${e.message}` };
        }
        say({ type: 'gate', name, args: vault.publicToolArgs(name, args), ...decision });
        if (stop()) return;

        let result;
        try {
          if (decision.verdict === 'deny') {
            result = { error: `Gatekeeper denied this (${decision.class}): ${decision.reason}` };
          } else if (decision.verdict === 'ask') {
            const ans = await requestApproval(name, args, decision);
            if (stop()) return;
            const approved = typeof ans === 'object' ? ans.approved : ans;
            const always = typeof ans === 'object' && ans.always;
            remember(name, args, approved ? 'allow' : 'deny', always ? 'class' : 'fingerprint');
            result = approved
              ? await runBoundedTool(name, args, requestPoll)
              : { error: 'User denied this action. Do not retry it.' };
          } else {
            result = await runBoundedTool(name, args, requestPoll);
          }
        } catch (e) {
          result = { error: String(e.message || e) };
        }
        if (stop()) return;

        trace.tools.push({
          name,
          ok: !result?.error && result?.ok !== false,
          error: result?.error,
          detail: compactResult(result),
        });

        const response = vault.publicToolResult(name, { ...result });
        const image = result && result.image;
        if (response && typeof response === 'object') delete response.image;
        say({ type: 'tool_result', name, result: response });
        responseParts.push({ functionResponse: { name, response } });
        if (image && !stop()) {
          if (response && typeof response === 'object' && !response.note) {
            response.note = 'Screen was viewed. Do not screenshot again for choices — use safari_read decisions.';
          }
        }
      }
      if (stop()) return;
      if (responseParts.length) history.push({ role: 'user', parts: responseParts });
    }

    trace.failed = true;
    say({ type: 'error', text: `Stopped after ${MAX_STEPS} steps without finishing. Try a tighter request, or ask me to continue.` });
  } catch (e) {
    if (!stop()) say({ type: 'error', text: String(e && e.message || e).slice(0, 500) });
  } finally {
    if (stop()) return;
    try {
      const saved = learnFromRun(trace, config, emit);
      if (saved && saved.length) {
        say({
          type: 'learned',
          summary: saved.slice(0, 3).map((l) => l.title).join(' · '),
        });
      }
    } catch {
      /* learning must never block the user */
    }
  }
}

module.exports = { runAgent, capHistory };
