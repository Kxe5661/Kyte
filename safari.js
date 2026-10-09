// Drive the real Safari.app the user can see — no Chrome, no Playwright, no hidden WebKit.
// AppleScript `open location` + `do JavaScript` in the current tab.
// If Develop → Allow JavaScript from Apple Events is off, try to enable it once,
// then fall back to cliclick / use_computer on the visible Safari window.

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const mouse = require('./mouse');
const { activateApp } = require('./ui_drive');
const { loadMemory } = require('./memory');
const vault = require('./vault');

const JS_HINT =
  'One-time Safari setting: Settings → Advanced → Show features for web developers, then Settings → Developer → Allow JavaScript from Apple Events (older Safari: Develop menu).';

let enableAttempted = false;
let jsAllowedCache = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function appleQuote(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function osa(script, timeout = 30000) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout, maxBuffer: 12 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || (err ? err.message : '') || '').trim(),
      });
    });
  });
}

function defaultsWrite(domain, key, flag) {
  return new Promise((resolve) => {
    execFile('defaults', ['write', domain, key, '-bool', flag], { timeout: 8000 }, () => resolve());
  });
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonish(out) {
  const s = String(out || '').trim();
  if (!s) return null;
  if (s.startsWith('KYTE_JS_ERROR:')) return { error: s.slice('KYTE_JS_ERROR:'.length) };
  if (s === 'KYTE_NO_WINDOW' || s === 'missing value') return { error: s };
  try {
    return JSON.parse(s);
  } catch {
    return { ok: true, result: s };
  }
}

function jsDisabled(err) {
  return /javascript through AppleScript is turned off|Allow JavaScript from Apple Events|Developer section of Safari Settings|AppleEvent handler failed|not allowed to send Apple events/i.test(
    String(err || '')
  );
}

function wrapBody(body) {
  return `(function(){
    try {
      var __out = (function(){ ${body} })();
      if (typeof __out === 'string') return __out;
      return JSON.stringify(__out === undefined ? {ok:true} : __out);
    } catch (e) {
      return JSON.stringify({error: String(e && e.message || e)});
    }
  })()`;
}

function wrapEval(code) {
  return wrapBody(`return eval(${JSON.stringify(String(code || ''))});`);
}

function pageRunner(jsSource) {
  const b64 = Buffer.from(jsSource, 'utf8').toString('base64');
  return `eval(new TextDecoder().decode(Uint8Array.from(atob("${b64}"),function(c){return c.charCodeAt(0)})))`;
}

async function activateSafari() {
  const simple = await osa('tell application "Safari" to activate', 12000);
  const shown = await activateApp('Safari');
  return shown.ok ? shown : simple;
}

async function tabMeta() {
  const r = await osa(`
    tell application "Safari"
      if (count of windows) is 0 then return "KYTE_NO_WINDOW"
      set t to current tab of front window
      return (name of t) & linefeed & (URL of t)
    end tell
  `);
  if (!r.ok || r.out === 'KYTE_NO_WINDOW') return { title: '', url: '', error: r.err || r.out };
  const [title, url] = r.out.split('\n');
  return { title: title || '', url: url || '' };
}

async function tryEnableJsFromAppleEvents() {
  enableAttempted = true;
  await defaultsWrite('com.apple.Safari', 'IncludeDevelopMenu', 'true');
  await defaultsWrite('com.apple.Safari', 'IncludeInternalDebugMenu', 'true');
  await defaultsWrite('com.apple.Safari', 'AllowJavaScriptFromAppleEvents', 'true');
  await defaultsWrite('com.apple.Safari.SandboxBroker', 'ShowDevelopMenu', 'true');
  const containerPlist = path.join(
    os.homedir(),
    'Library/Containers/com.apple.Safari/Data/Library/Preferences/com.apple.Safari'
  );
  await defaultsWrite(containerPlist, 'AllowJavaScriptFromAppleEvents', 'true');
  await defaultsWrite(containerPlist, 'IncludeDevelopMenu', 'true');

  await activateSafari();
  await sleep(400);
  return osa(`
    tell application "Safari" to activate
    delay 0.35
    tell application "System Events"
      tell process "Safari"
        set frontmost to true
        try
          set devMenu to menu "Develop" of menu bar 1
          set m to menu item "Allow JavaScript from Apple Events" of devMenu
          set marked to ""
          try
            set marked to value of attribute "AXMenuItemMarkChar" of m
          end try
          if marked is not "✓" then click m
          return "clicked"
        on error errMsg
          return "menu: " & errMsg
        end try
      end tell
    end tell
  `, 8000);
}

async function doJavaScript(jsSource) {
  const runner = appleQuote(pageRunner(jsSource));
  const r = await osa(`
    tell application "Safari"
      if (count of windows) is 0 then return "KYTE_NO_WINDOW"
      try
        return do JavaScript "${runner}" in current tab of front window
      on error errMsg
        return "KYTE_JS_ERROR:" & errMsg
      end try
    end tell
  `);
  if (r.out === 'KYTE_NO_WINDOW') return { ok: false, allowed: true, error: 'Safari has no windows.' };
  if (!r.out || r.out === 'missing value') {
    return {
      ok: false,
      allowed: false,
      error: r.err || 'Safari returned no JavaScript result.',
      hint: JS_HINT,
    };
  }
  const parsed = parseJsonish(r.out);
  const err = (parsed && parsed.error) || (!r.ok && r.err) || '';
  if (!r.ok && !parsed) return { ok: false, allowed: !jsDisabled(r.err), error: r.err };
  if (jsDisabled(err) || jsDisabled(r.out)) {
    return { ok: false, allowed: false, error: err || r.out, hint: JS_HINT };
  }
  if (parsed && parsed.error) return { ok: false, allowed: true, error: parsed.error, raw: parsed };
  return { ok: true, allowed: true, result: parsed && parsed.result !== undefined ? parsed.result : parsed, raw: r.out };
}

async function ensureJsAllowed() {
  if (jsAllowedCache && jsAllowedCache.allowed) return jsAllowedCache;
  const probe = await doJavaScript(wrapEval('1+1'));
  if (probe.ok && (probe.result === 2 || probe.raw === '2')) {
    jsAllowedCache = { allowed: true };
    return jsAllowedCache;
  }
  if (probe.allowed !== false && probe.ok) {
    jsAllowedCache = { allowed: true };
    return jsAllowedCache;
  }
  if (enableAttempted) {
    return { allowed: false, error: probe.error, hint: JS_HINT };
  }
  const enable = await tryEnableJsFromAppleEvents();
  await sleep(200);
  const probe2 = await doJavaScript(wrapEval('1+1'));
  if (probe2.ok && (probe2.result === 2 || probe2.raw === '2')) {
    jsAllowedCache = { allowed: true, enabled: true, enable };
    return jsAllowedCache;
  }
  return {
    allowed: false,
    error: probe2.error || probe.error,
    hint: JS_HINT,
    enable,
  };
}

async function waitForLoad(ms = 10000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < ms) {
    const state = await doJavaScript(wrapEval('document.readyState + "|" + location.href'));
    if (state.allowed === false) {
      await sleep(600);
      return { ok: true, js: false };
    }
    const val = String(state.result || state.raw || '');
    last = val;
    if (/complete\|/.test(val) && !/about:blank/.test(val)) {
      await sleep(120);
      return { ok: true, js: true, href: val.split('|').slice(1).join('|') };
    }
    await sleep(160);
  }
  return { ok: true, timeout: true, last };
}

function httpUrl(url) {
  return /^https?:\/\/.+/i.test(String(url || '').trim());
}

function googleUrl(query) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(String(query || '').trim());
}

function urlFromText(text) {
  const m = String(text || '').match(/https?:\/\/[^\s)>\]]+/i);
  return m ? m[0].replace(/[.,;]+$/, '') : '';
}

async function openUrl(url) {
  if (!httpUrl(url)) return { error: 'Only http(s) URLs are allowed. Use Safari, not Chrome.' };
  await activateSafari();
  const u = appleQuote(url);
  const r = await osa(`
    tell application "Safari"
      activate
      if (count of windows) is 0 then
        make new document
        delay 0.2
      end if
      open location "${u}"
      delay 0.12
      try
        set currentUrl to URL of current tab of front window
      on error
        set currentUrl to ""
      end try
      return currentUrl
    end tell
  `);
  if (!r.ok) return { ok: false, error: r.err || 'Safari did not open the URL.' };
  const loaded = await waitForLoad();
  const meta = await tabMeta();
  return {
    ok: true,
    via: 'Safari.app open location',
    opened: url,
    url: meta.url || r.out,
    title: meta.title,
    loaded,
  };
}

async function evalJs(javascript) {
  const js = await ensureJsAllowed();
  if (!js.allowed) {
    return { ok: false, error: js.error || 'JavaScript from Apple Events is off.', hint: JS_HINT, fallback: 'use_computer' };
  }
  const r = await doJavaScript(wrapEval(javascript));
  if (!r.ok) return { ok: false, error: r.error, hint: r.hint };
  return { ok: true, result: r.result, raw: r.raw };
}

const PAGE_LIB = `
function kyteVisible(el) {
  if (!el) return false;
  var r = el.getBoundingClientRect();
  var st = window.getComputedStyle(el);
  return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
}
function kyteInViewport(el) {
  if (!el || !kyteVisible(el)) return false;
  var r = el.getBoundingClientRect();
  var vh = window.innerHeight || document.documentElement.clientHeight || 0;
  var vw = window.innerWidth || document.documentElement.clientWidth || 0;
  return r.bottom > 48 && r.top < vh - 24 && r.right > 8 && r.left < vw - 8;
}
function kyteLabel(el) {
  var bits = [];
  if (el.id) {
    var lab = document.querySelector('label[for="' + el.id.replace(/"/g, '') + '"]');
    if (lab) bits.push(lab.innerText);
  }
  var wrap = el.closest('label');
  if (wrap) bits.push(wrap.innerText);
  bits.push(el.getAttribute('aria-label') || '');
  bits.push(el.placeholder || '');
  bits.push(el.name || '');
  bits.push(el.id || '');
  bits.push(el.title || '');
  bits.push(el.getAttribute('autocomplete') || '');
  bits.push(el.type || '');
  return bits.join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
}
function kyteControlText(el) {
  return ((el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.getAttribute('data-autom') || '') + '').replace(/\\s+/g, ' ').trim();
}
function kyteReveal(el) {
  if (!el) return false;
  try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch (e) {
    try { el.scrollIntoView(true); } catch (e2) {}
  }
  return kyteInViewport(el);
}
function kyteScrollPage(dir) {
  var before = window.scrollY || document.documentElement.scrollTop || 0;
  var max = Math.max(0, (document.documentElement.scrollHeight || document.body.scrollHeight || 0) - (window.innerHeight || 0));
  var step = Math.max(480, Math.round((window.innerHeight || 700) * 0.82));
  if (dir === 'up') step = -step;
  var target = Math.max(0, Math.min(max, before + step));
  try { window.scrollTo({ top: target, left: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, target); }
  return { ok: true, before: before, after: target, moved: Math.abs(target - before) > 8, max: max };
}
function kyteScreenPoint(el) {
  kyteReveal(el);
  var r = el.getBoundingClientRect();
  var chrome = (window.outerHeight - window.innerHeight) || 0;
  return {
    x: Math.round(window.screenX + r.left + r.width / 2),
    y: Math.round(window.screenY + chrome + r.top + r.height / 2),
    text: kyteControlText(el).slice(0, 80),
    inView: kyteInViewport(el)
  };
}
function kyteNativeSet(el, value) {
  el.focus();
  var tag = (el.tagName || '').toUpperCase();
  var type = (el.type || '').toLowerCase();
  if (tag === 'SELECT') {
    var v = String(value).toLowerCase();
    var opts = Array.prototype.slice.call(el.options || []);
    var hit = opts.filter(function(o) {
      return o.value.toLowerCase() === v || o.text.toLowerCase() === v || o.text.toLowerCase().indexOf(v) >= 0;
    })[0];
    if (hit) el.value = hit.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (type === 'checkbox' || type === 'radio') {
    el.checked = /^(1|true|yes|on|checked)$/i.test(String(value));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el.isContentEditable) {
    el.innerText = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  var proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, String(value));
  else el.value = String(value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
function kyteFields() {
  return Array.prototype.slice.call(document.querySelectorAll(
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=file]), textarea, select, [contenteditable=true]'
  )).filter(kyteVisible);
}
function kyteFindField(query) {
  var q = String(query || '').trim();
  if (!q) return null;
  try {
    var bySel = document.querySelector(q);
    if (bySel && kyteVisible(bySel)) return bySel;
  } catch (e) {}
  var n = q.toLowerCase();
  var all = kyteFields();
  var i, el, lab;
  for (i = 0; i < all.length; i++) {
    el = all[i];
    if ((el.name || '').toLowerCase() === n || (el.id || '').toLowerCase() === n) return el;
  }
  for (i = 0; i < all.length; i++) {
    el = all[i];
    lab = kyteLabel(el);
    if (lab === n || (n.length >= 2 && lab.indexOf(n) >= 0)) return el;
  }
  return null;
}
function kyteClickables() {
  return Array.prototype.slice.call(document.querySelectorAll(
    'a, button, input[type=submit], input[type=button], input[type=image], [role=button], [role=link], [role=tab], summary, label, [data-autom]'
  )).filter(kyteVisible);
}
function kyteFindClickable(query) {
  var q = String(query || '').trim();
  if (!q) return null;
  try {
    var bySel = document.querySelector(q);
    if (bySel && kyteVisible(bySel)) return bySel;
  } catch (e) {}
  var n = q.toLowerCase();
  var all = kyteClickables();
  var exact = null, part = null, i, el, t;
  for (i = 0; i < all.length; i++) {
    el = all[i];
    t = kyteControlText(el).toLowerCase();
    if (t === n) { exact = el; break; }
    if (!part && n.length >= 2 && t.indexOf(n) >= 0) part = el;
  }
  return exact || part;
}
function kytePrimary(preferred) {
  if (preferred) {
    var list = String(preferred).split(/\\s*\\|\\s*/);
    var p, hit;
    for (p = 0; p < list.length; p++) {
      if (!list[p]) continue;
      hit = kyteFindClickable(list[p]);
      if (hit) return hit;
    }
  }
  var re = /submit|search|continue|next|sign in|log in|login|go|send|apply|save|confirm|done|start|book|subscribe|register|sign up|create|check availability|add to bag|add to cart|add to basket|check out|checkout|buy now|purchase|place order/i;
  var all = kyteClickables();
  var best = null, bestScore = 0, i, el, t, score;
  for (i = 0; i < all.length; i++) {
    el = all[i];
    t = kyteControlText(el);
    score = 0;
    if (re.test(t)) score += 10;
    if (/add to bag|check out|checkout|check availability/i.test(t)) score += 4;
    if ((el.type || '').toLowerCase() === 'submit') score += 8;
    if (el.closest('form')) score += 2;
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}
function kyteClick(el) {
  if (!el) return null;
  var pt = kyteScreenPoint(el);
  el.focus();
  var ev = { bubbles: true, cancelable: true, view: window, clientX: 0, clientY: 0 };
  var r = el.getBoundingClientRect();
  ev.clientX = r.left + r.width / 2;
  ev.clientY = r.top + r.height / 2;
  ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function(type) {
    try { el.dispatchEvent(new MouseEvent(type, ev)); } catch (e) {}
  });
  if (typeof el.click === 'function') el.click();
  return pt;
}
`;

async function fillOnce(map) {
  const body = `
    ${PAGE_LIB}
    var fields = ${JSON.stringify(map)};
    var filled = [];
    var missed = [];
    Object.keys(fields).forEach(function(key) {
      var el = kyteFindField(key);
      if (!el) { missed.push(key); return; }
      kyteReveal(el);
      kyteNativeSet(el, fields[key]);
      filled.push({ key: key, name: el.name || el.id || key });
    });
    return { ok: missed.length === 0, filled: filled, missed: missed, url: location.href, title: document.title };
  `;
  const r = await doJavaScript(wrapBody(body));
  if (!r.ok) return { ok: false, error: r.error, hint: r.hint };
  return { ok: !r.result?.missed?.length, ...r.result };
}

async function fillFields(fields) {
  const map = parseFields(fields);
  const keys = Object.keys(map);
  if (!keys.length) return { ok: false, error: 'No fields to fill. Pass fields JSON or selector + value.' };
  const js = await ensureJsAllowed();
  if (!js.allowed) return { ok: false, allowed: false, error: js.error, hint: JS_HINT, fallback: 'use_computer' };
  let result = await fillOnce(map);
  const remaining = () => (result.missed || []).filter(Boolean);
  for (let i = 0; i < 4 && remaining().length; i++) {
    const scrolled = await scrollPage('down');
    if (!scrolled.moved) break;
    const retryMap = {};
    remaining().forEach((key) => {
      retryMap[key] = map[key];
    });
    const again = await fillOnce(retryMap);
    result = {
      ...again,
      filled: [...(result.filled || []), ...(again.filled || [])],
      missed: again.missed || [],
    };
  }
  return { ok: !result.missed?.length, ...result };
}

async function clickTarget(target, { primary = false } = {}) {
  const js = await ensureJsAllowed();
  if (!js.allowed) {
    return { ok: false, allowed: false, error: js.error, hint: JS_HINT, fallback: 'use_computer' };
  }
  const body = `
    ${PAGE_LIB}
    var preferred = ${JSON.stringify(target || '')};
    var el = ${primary ? 'kytePrimary(preferred)' : 'kyteFindClickable(preferred) || kytePrimary(preferred)'};
    if (!el) return { ok: false, found: false, error: 'No matching control', url: location.href };
    var revealed = kyteReveal(el);
    var pt = kyteClick(el);
    return {
      ok: true,
      found: true,
      revealed: revealed,
      clicked: kyteControlText(el).slice(0, 80) || preferred,
      point: pt,
      url: location.href
    };
  `;
  const r = await doJavaScript(wrapBody(body));
  if (!r.ok) return { ok: false, error: r.error, hint: r.hint };
  return { ok: Boolean(r.result && r.result.ok !== false), ...r.result };
}

async function scrollPage(direction = 'down') {
  const js = await ensureJsAllowed();
  if (js.allowed) {
    const r = await doJavaScript(wrapBody(`${PAGE_LIB} return kyteScrollPage(${JSON.stringify(direction || 'down')});`));
    if (r.ok && r.result) {
      await sleep(110);
      return { ok: true, via: 'safari_js', ...r.result };
    }
    if (r.allowed === false) {
      /* fall through to wheel */
    } else if (r.result && r.result.moved === false) {
      return { ok: true, via: 'safari_js', moved: false, ...r.result };
    }
  }
  return mouseScrollFlick(direction);
}

async function mouseScrollFlick(direction = 'down') {
  await activateSafari();
  const pts = await mouse.displayPoints();
  await mouse.move(Math.round((pts.w || 1400) * 0.5), Math.round((pts.h || 900) * 0.58));
  const wheeled = await mouse.scroll(direction, { flicks: 3, lines: 18 });
  await sleep(90);
  return { ok: wheeled.ok !== false, via: 'wheel', moved: true, direction, ...wheeled };
}

async function revealAndClick(target, { primary = true } = {}) {
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = await clickTarget(target, { primary });
    if (last.allowed === false) return last;
    if (last.ok) return last;
    const scrolled = await scrollPage('down');
    if (scrolled.moved === false) break;
  }
  return last || { ok: false, error: 'No matching control' };
}

async function clickWithMouse(point) {
  if (!point || point.x == null || point.y == null) return { ok: false, error: 'No screen point.' };
  await activateSafari();
  await sleep(80);
  return mouse.click(point.x, point.y);
}

async function visionFallback(goal) {
  const { useComputer } = require('./computer_use');
  await activateSafari();
  return useComputer(
    `In the visible Safari.app window (not Chrome): ${goal}. Fill any empty fields from the goal, then click Submit, Search, Continue, Next, or Sign in. Never stop before that last click.`,
    {
      apiKey: (process.env.GEMINI_API_KEY || '').trim(),
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    }
  );
}

const DEFAULT_CTA = 'Continue|Next|Add to Bag|Check Out|Check Availability|Submit|Search|Sign in';

async function clickAndFinish(target, { vision = true } = {}) {
  const want = target || DEFAULT_CTA;
  const jsClick = await revealAndClick(want, { primary: true });
  if (jsClick.ok) {
    return { ok: true, via: 'safari_js', ...jsClick };
  }
  if (jsClick.point) {
    const mouseClick = await clickWithMouse(jsClick.point);
    if (mouseClick.ok) return { ok: true, via: 'cliclick', js: jsClick, mouse: mouseClick };
  }
  if (jsClick.allowed === false) {
    for (let i = 0; i < 4; i++) {
      await mouseScrollFlick('down');
    }
  }
  if (!vision) {
    return { ok: false, via: 'safari_js', ...jsClick };
  }
  const visionResult = await visionFallback(
    `Click "${target || 'Submit / Continue / Next / Add to Bag / Check Out'}" in the visible Safari window. If it is not on screen, scroll down quickly and click it.`
  );
  return { ok: Boolean(visionResult?.ok), via: 'use_computer', js: jsClick, vision: visionResult };
}

const PAGE_SCAN = `(function(){
  function t(el){ return ((el && (el.innerText || el.getAttribute && el.getAttribute('aria-label') || '')) || '').replace(/\\s+/g,' ').trim(); }
  var seen = {};
  var decisions = [];
  function add(q, opts){
    q = String(q||'').replace(/\\s+/g,' ').trim();
    var clean = [];
    for (var i=0;i<opts.length && clean.length<8;i++){
      var o = String(opts[i]||'').replace(/\\s+/g,' ').trim();
      if (o.length<2 || o.length>100) continue;
      if (clean.indexOf(o)>=0) continue;
      clean.push(o);
    }
    if (q.length<8 || clean.length<2) return;
    var k = q + '|' + clean.join('~');
    if (seen[k]) return;
    seen[k] = 1;
    decisions.push({ question: q.slice(0,160), options: clean });
  }
  var groups = {};
  var radios = document.querySelectorAll('input[type=radio]');
  for (var i=0;i<radios.length;i++){
    var r = radios[i];
    var name = r.name || ('radio'+i);
    if (!groups[name]) groups[name] = [];
    var lab = t(r.closest && r.closest('label') || r.parentElement) || r.value || '';
    groups[name].push(lab.slice(0,100));
  }
  Object.keys(groups).forEach(function(name){
    var box = null;
    try { box = document.querySelector('input[type=radio][name="'+name.replace(/"/g,'')+'"]'); } catch(e) {}
    var field = box && (box.closest('fieldset') || box.closest('section') || box.closest('[role=group]') || box.parentElement);
    var qEl = field && field.querySelector('legend,h2,h3,h4,[role=heading]');
    add((qEl && t(qEl)) || name, groups[name]);
  });
  var boxes = document.querySelectorAll('fieldset,[role=radiogroup],[role=group]');
  for (var b=0;b<boxes.length;b++){
    var box = boxes[b];
    var qEl = box.querySelector('legend,h2,h3,h4,[role=heading]');
    var opts = [];
    var clicks = box.querySelectorAll('[role=radio],button,label');
    for (var c=0;c<clicks.length && opts.length<8;c++) opts.push(t(clicks[c]).slice(0,100));
    add(qEl ? t(qEl) : '', opts);
  }
  var heads = document.querySelectorAll('h1,h2,h3,h4,legend,[role=heading]');
  for (var h=0;h<heads.length && decisions.length<8;h++){
    var qt = t(heads[h]);
    if (!/\\?$/.test(qt) || qt.length>160) continue;
    var parent = heads[h].parentElement;
    if (!parent) continue;
    var opts = [];
    var kids = parent.querySelectorAll('button,[role=radio],[role=option],label,a');
    for (var k=0;k<kids.length && opts.length<8;k++){
      if (heads[h].contains(kids[k])) continue;
      opts.push(t(kids[k]).slice(0,100));
    }
    add(qt, opts);
  }
  var actions = [];
  var btns = document.querySelectorAll('button,[role=button],input[type=submit]');
  for (var n=0;n<btns.length && actions.length<6;n++){
    var lab = t(btns[n]).slice(0,48);
    if (lab && /continue|next|add to bag|check out|buy|review bag|select|submit/i.test(lab) && actions.indexOf(lab)<0) actions.push(lab);
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    decisions: decisions.slice(0,8),
    actions: actions,
    text: (document.body && document.body.innerText || '').replace(/[\\t ]+/g,' ').trim().slice(0,3500)
  });
})()`;

function detectDecision(text) {
  const lines = String(text || '')
    .split(/\n|(?<=\?)\s+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const qIndex = lines.findIndex((l) => /\?$/.test(l) && l.length >= 12 && l.length <= 140);
  if (qIndex < 0) return null;
  const options = [];
  for (let i = qIndex + 1; i < lines.length && options.length < 6; i++) {
    const line = lines[i];
    if (/\?$/.test(line)) break;
    if (line.length < 3 || line.length > 80) continue;
    if (/^(home|bag|search|sign in|apple|store)$/i.test(line)) continue;
    if (/^\$[\d,.]+/.test(line) && options.length) {
      options[options.length - 1] += ` — ${line}`;
      continue;
    }
    options.push(line);
  }
  if (options.length < 2) return null;
  return { question: lines[qIndex], options };
}

async function readPage() {
  const meta = await tabMeta();
  const js = await ensureJsAllowed();
  if (js.allowed) {
    const r = await doJavaScript(wrapEval(PAGE_SCAN));
    if (r.ok) {
      const data = typeof r.result === 'string' ? parseJsonish(r.result) : r.result;
      const page = data && !data.error ? data : null;
      if (page && (page.text || page.url || page.title || (page.decisions && page.decisions.length))) {
        const decisions = Array.isArray(page.decisions) && page.decisions.length
          ? page.decisions
          : [detectDecision(page.text)].filter(Boolean);
        return {
          ok: true,
          url: page.url || meta.url,
          title: page.title || meta.title,
          text: page.text || '',
          decisions,
          actions: page.actions || [],
          hint: decisions.length
            ? 'These are ALL the choices on the page. If the user has not already answered them, call ask_user ONCE with type=form and one select field per question. Do not poll one by one. Then continue the original request.'
            : undefined,
        };
      }
    }
  }
  const src = await osa(`
    tell application "Safari"
      if (count of windows) is 0 then return "KYTE_NO_WINDOW"
      set t to current tab of front window
      return (name of t) & linefeed & (URL of t) & linefeed & (source of t)
    end tell
  `);
  if (!src.ok || src.out === 'KYTE_NO_WINDOW') {
    return { ok: false, error: src.err || 'Could not read Safari tab.', hint: js.allowed === false ? JS_HINT : undefined };
  }
  const nl = src.out.indexOf('\n');
  const nl2 = src.out.indexOf('\n', nl + 1);
  const title = nl >= 0 ? src.out.slice(0, nl) : meta.title;
  const url = nl2 >= 0 ? src.out.slice(nl + 1, nl2) : meta.url;
  const html = nl2 >= 0 ? src.out.slice(nl2 + 1) : src.out;
  const text = htmlToText(html).slice(0, 3500);
  const one = detectDecision(text);
  const decisions = one ? [one] : [];
  return {
    ok: true,
    url,
    title,
    text,
    decisions,
    via: js.allowed === false ? 'safari_source' : 'safari_source_fallback',
    hint: decisions.length
      ? 'These are ALL the choices on the page. If the user has not already answered them, call ask_user ONCE with type=form and one select field per question. Do not poll one by one. Then continue the original request.'
      : js.allowed === false
        ? JS_HINT
        : undefined,
  };
}

async function listTabs() {
  const r = await osa(`
    tell application "Safari"
      set out to ""
      if (count of windows) is 0 then return out
      set wi to 1
      repeat with w in windows
        set curIdx to index of current tab of w
        set ti to 1
        repeat with t in tabs of w
          set cur to (ti is curIdx) and (wi is 1)
          set out to out & wi & tab & ti & tab & (name of t) & tab & (URL of t) & tab & cur & linefeed
          set ti to ti + 1
        end repeat
        set wi to wi + 1
      end repeat
      return out
    end tell
  `);
  if (!r.ok) return { ok: false, error: r.err };
  const tabs = String(r.out || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [window, index, title, url, current] = line.split('\t');
      return {
        window: Number(window),
        index: Number(index),
        title: title || '',
        url: url || '',
        current: current === 'true' || current === 'true\r',
      };
    });
  return { ok: true, tabs, app: 'Safari' };
}

function parseFields(fields) {
  if (!fields) return {};
  if (typeof fields === 'object' && !Array.isArray(fields)) return fields;
  if (typeof fields === 'string') {
    const s = fields.trim();
    if (!s) return {};
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* name=value; other=value */
    }
    const map = {};
    s.split(/[;\n]/).forEach((part) => {
      const m = part.match(/^\s*([^:=]+)\s*[:=]\s*([\s\S]+)\s*$/);
      if (m) map[m[1].trim()] = m[2].trim();
    });
    return map;
  }
  return {};
}

function factsFromText(text) {
  const t = String(text || '');
  const facts = {};
  const email = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) facts.email = email[0];
  const phone = t.match(/\+?\d[\d\s().-]{8,}\d/);
  if (phone) facts.phone = phone[0].trim();
  const name = t.match(/\b(?:name|i am|i'm)\s*[:\-]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
  if (name) facts.name = name[1];
  return facts;
}

async function webTask({ goal, url, query, fields, submit } = {}) {
  const want = String(goal || query || url || '').trim();
  if (!want) return { error: 'Need a goal, url, or query for the Safari web task.' };

  const memory = loadMemory();
  const merged = {
    ...vault.profileFacts(),
    ...factsFromText(memory),
    ...factsFromText(goal),
    ...parseFields(fields),
  };
  const targetUrl = httpUrl(url) ? url : urlFromText(goal) || (query ? googleUrl(query) : googleUrl(want));
  const opened = await openUrl(targetUrl);
  if (opened.error) return opened;

  const js = await ensureJsAllowed();
  const shouldSiteSearch = Boolean(query && httpUrl(url));
  if (shouldSiteSearch) merged.search = merged.search || query;
  if (query && !httpUrl(url) && Object.keys(parseFields(fields)).length === 0) {
    /* already on Google results — do not refill the search box unless asked */
  }

  let filled = null;
  if (js.allowed && Object.keys(merged).length) {
    filled = await fillFields(merged);
  }

  const openedSite = Boolean(httpUrl(url) || urlFromText(goal));
  const filledSomething = Boolean(filled && filled.filled && filled.filled.length);
  const mustClick = Boolean(submit || openedSite || filledSomething || shouldSiteSearch);
  const cta = submit || (shouldSiteSearch || query ? 'Search' : DEFAULT_CTA);
  let finished = { ok: true, via: 'safari_read', skipped_click: !mustClick };
  if (mustClick) {
    finished = await clickAndFinish(cta);
  }

  await sleep(140);
  const page = await readPage();
  return {
    ok: Boolean(finished?.ok !== false),
    via: js.allowed ? 'Safari.app' : 'Safari.app + mouse/vision',
    goal: want,
    opened,
    filled,
    finished,
    page,
    hint: js.allowed ? undefined : JS_HINT,
  };
}

async function openFromArgs({ url, query } = {}) {
  if (httpUrl(url)) return openUrl(url);
  if (query) return openUrl(googleUrl(query));
  if (urlFromText(url)) return openUrl(urlFromText(url));
  return { error: 'Pass a http(s) url, or query to search in Safari.' };
}

module.exports = {
  JS_HINT,
  activateSafari,
  openUrl,
  openFromArgs,
  evalJs,
  fillFields,
  clickTarget,
  clickAndFinish,
  revealAndClick,
  scrollPage,
  readPage,
  listTabs,
  webTask,
  parseFields,
  ensureJsAllowed,
  DEFAULT_CTA,
};
