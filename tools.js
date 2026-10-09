// Kyte's hands: actions it can take on this Mac and on the web.
// Most actions run immediately. Only destructive work asks for a tap.

const { exec, execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { appendMemory } = require('./memory');
const { findLocalContact, saveContact, findInMessages } = require('./contacts');
const { clickAllowDialogs } = require('./permissions');
const { captureScreen } = require('./screen');
const { addJob, cancelJob, loadJobs } = require('./scheduler');
const { callViaContacts, activateApp, typeSearch, clickFaceTimeCallButton } = require('./ui_drive');
const { useComputer, clickPrimaryAction } = require('./computer_use');
const safari = require('./safari');
const vault = require('./vault');

const MAX_OUTPUT = 12000;
const SHELL_TIMEOUT_MS = 45_000;

const TOOL_DECLARATIONS = [
  {
    name: 'fetch_url',
    description:
      'Fetch a web page and return its readable text. This is the only tool for reading a URL. Use it for research — retailers, reviews, specs, prices, news. If it fails, try another URL. Never curl or run_shell to download a page. Do NOT use this before ask_user on a purchase/config/form job. For filling or submitting a form, use web_task / safari_open instead.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'http(s) URL to fetch.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'open_url',
    description:
      'Open a URL in Safari.app so the user can see it. Does not return page content — use fetch_url to read, safari_open / web_task to fill or submit.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'The http(s) URL to open.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'open_app',
    description: 'Open or bring to front a macOS app, e.g. Safari, Messages, FaceTime, Notes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Application name as it appears in /Applications.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_contact',
    description:
      "Find someone by name in Kyte's address book and in Messages. Returns name plus phone/email. Use this, then immediately facetime_call or send_imessage. Only ask the user for a number if nothing comes back.",
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Full or partial name, e.g. "Sam" or "Sam Patel".' },
      },
      required: ['name'],
    },
  },
  {
    name: 'save_contact',
    description:
      "Save a person to Kyte's private address book so you never have to ask again. Use after the user gives you someone's number or email.",
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Person\'s name.' },
        phone: { type: 'STRING', description: 'Phone number, ideally with country code.' },
        email: { type: 'STRING', description: 'iMessage email / Apple ID if they use that.' },
        note: { type: 'STRING', description: 'Optional note, e.g. relationship.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'send_imessage',
    description:
      'Send an iMessage (or SMS) from the Mac via the Messages app. Use when the user asked to text someone. `to` must be a phone number or iMessage email — look it up with find_contact first if they gave a name.',
    parameters: {
      type: 'OBJECT',
      properties: {
        to: { type: 'STRING', description: 'Phone number (ideally E.164 like +15551212) or iMessage email.' },
        body: { type: 'STRING', description: 'The message text to send.' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'facetime_call',
    description:
      'Call someone the way a person would: open Contacts, search their name, click FaceTime, then find and click the green Call button. Never stop on the preview. Prefer a name. A phone number still works as backup.',
    parameters: {
      type: 'OBJECT',
      properties: {
        to: { type: 'STRING', description: 'Person name, or phone/email if that is all you have.' },
        audio: { type: 'BOOLEAN', description: 'true for audio, false/omit for video FaceTime.' },
      },
      required: ['to'],
    },
  },
  {
    name: 'run_shell',
    description:
      'Run a zsh command on the Mac for system info, files, or `open`. Never fetch a web page — no curl, wget, or HTTP. Use fetch_url to read a URL. Do not use this to send messages or make calls.',
    parameters: {
      type: 'OBJECT',
      properties: {
        command: { type: 'STRING', description: 'The shell command to run.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_applescript',
    description:
      'Run AppleScript to control a Mac app when no dedicated tool exists. Do not use this for Messages or FaceTime — use send_imessage / facetime_call.',
    parameters: {
      type: 'OBJECT',
      properties: {
        script: { type: 'STRING', description: 'The AppleScript source to execute.' },
      },
      required: ['script'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file on the Mac. Returns up to 100KB of content.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Absolute path, or path starting with ~/' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a text file on the Mac.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Absolute path, or path starting with ~/' },
        content: { type: 'STRING', description: 'Full file contents to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'save_memory',
    description:
      'Save a lasting fact about the user — preferences, people, routines, form URLs. Use this whenever they share something worth remembering.',
    parameters: {
      type: 'OBJECT',
      properties: {
        fact: { type: 'STRING', description: 'One concise fact to remember.' },
      },
      required: ['fact'],
    },
  },
  {
    name: 'use_computer',
    description:
      'Look at the live Mac screen and drive the mouse/keyboard to finish a task: fill forms, click Allow/Submit/FaceTime, walk through an app. Use this whenever the job is visual. Do not ask the user to click anything.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal: { type: 'STRING', description: 'What to accomplish on screen, in one or two sentences.' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'see_screen',
    description:
      'Capture the Mac screen and look at it. Use when you need to see what is on screen, confirm a UI state, or fill a form visually.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'schedule_task',
    description:
      'Schedule a repeating job. Each run is a full Kyte task (research, open a form, summarize calendar, etc.). Examples: every "2 weeks", "1 day", "monday 08:00".',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: { type: 'STRING', description: 'Exactly what Kyte should do when the job fires.' },
        every: { type: 'STRING', description: 'How often: "2 weeks", "1 day", "6 hours".' },
        clock: { type: 'STRING', description: 'Optional daily time, 24h, e.g. "08:00".' },
        label: { type: 'STRING', description: 'Short name for the job.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_schedule',
    description: 'List scheduled repeating jobs.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a scheduled job by id from list_schedule.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING', description: 'Job id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'approve_system_dialog',
    description:
      'Scan the Mac for macOS permission popups (Allow / OK) and click them by moving the mouse. Use when a system dialog is blocking you. Do not ask the user to walk to the computer.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'list_dir',
    description: 'List the contents of a directory on the Mac.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Absolute path, or path starting with ~/. Defaults to home.' },
      },
    },
  },
  {
    name: 'safari_open',
    description:
      'Open a URL (or Google search) in the real visible Safari.app — never Chrome. Use for web tasks: forms, site search, checkout. Then safari_fill / safari_click / safari_read, or just web_task.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'http(s) URL to open in Safari.' },
        query: { type: 'STRING', description: 'If no url, search Google for this in Safari.' },
      },
    },
  },
  {
    name: 'safari_eval',
    description:
      'Run JavaScript in Safari’s current tab (needs Develop → Allow JavaScript from Apple Events). Return values are JSON.',
    parameters: {
      type: 'OBJECT',
      properties: {
        javascript: { type: 'STRING', description: 'JavaScript to eval in the page.' },
      },
      required: ['javascript'],
    },
  },
  {
    name: 'safari_fill',
    description:
      'Fill inputs in the current Safari tab by label, placeholder, name, id, or CSS selector. Pass one selector+value or a JSON map of fields.',
    parameters: {
      type: 'OBJECT',
      properties: {
        selector: { type: 'STRING', description: 'Label, placeholder, name, id, or CSS selector.' },
        value: { type: 'STRING', description: 'Value to type into that field.' },
        fields: {
          type: 'STRING',
          description: 'JSON object, e.g. {"Email":"a@b.com","Name":"Sam","q":"airpods"}.',
        },
        from_vault: {
          type: 'BOOLEAN',
          description: 'If true, fill the saved account password/username in the tool — never put the password in chat.',
        },
        field: { type: 'STRING', description: 'With from_vault: saved account site name, e.g. "amazon".' },
        account: { type: 'STRING', description: 'Alias for field — saved account site name.' },
        username_field: { type: 'STRING', description: 'Optional selector for the username/email box.' },
        password_field: { type: 'STRING', description: 'Optional selector for the password box.' },
      },
    },
  },
  {
    name: 'safari_click',
    description:
      'Click a control in the current Safari tab by visible text or CSS selector (Submit, Search, Continue, Next, Add to Bag, Check Out). Scrolls the page until the control is in view, then clicks via the DOM. Mouse only if JS fails; Gemini vision only if both fail.',
    parameters: {
      type: 'OBJECT',
      properties: {
        target: { type: 'STRING', description: 'Button/link text or CSS selector, e.g. "Submit" or "button.search".' },
      },
      required: ['target'],
    },
  },
  {
    name: 'safari_read',
    description:
      'Read the current Safari tab: URL, title, and visible text. Use after navigating or submitting. This is the live page, not fetch_url.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'safari_tabs',
    description: 'List open Safari windows and tabs (title + URL). Safari only.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'web_task',
    description:
      'End-to-end web job in visible Safari.app: open a URL or search, fill from the goal plus memory, scroll to and click Submit/Search/Continue/Next/Add to Bag yourself, then read the result. If the job needs a decision or fields, ask_user first. Not for research reading (that is fetch_url). Never Chrome.',
    parameters: {
      type: 'OBJECT',
      properties: {
        goal: { type: 'STRING', description: 'What to accomplish on the site, in one or two sentences.' },
        url: { type: 'STRING', description: 'Optional http(s) page to open first.' },
        query: { type: 'STRING', description: 'Optional search text. With url, fills that site’s search box; without url, Google in Safari.' },
        fields: { type: 'STRING', description: 'Optional JSON map of field labels to values.' },
        submit: { type: 'STRING', description: 'Optional button text. Defaults to Submit / Search / Continue.' },
        from_vault: { type: 'BOOLEAN', description: 'If true, also fill the saved account for `account` (password never enters chat).' },
        account: { type: 'STRING', description: 'Saved Autofill account site name, e.g. "amazon".' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'ask_user',
    description:
      'Pause and poll the iPhone. For purchase, product config, checkout, or any form that needs a choice or fields: call this FIRST (before fetch_url / research), ONCE, with ALL questions/fields. Do not drip questions or chat the question as markdown. After they submit, fill Safari yourself.',
    parameters: {
      type: 'OBJECT',
      properties: {
        type: {
          type: 'STRING',
          description: '"choice" for tappable options (single or multi), or "form" for a swipeable field-by-field form.',
        },
        title: { type: 'STRING', description: 'Short question shown big on the phone.' },
        context: { type: 'STRING', description: 'One-line why this is needed.' },
        multi: { type: 'BOOLEAN', description: 'For choice: allow more than one option.' },
        options: {
          type: 'STRING',
          description: 'For choice: JSON array of {"id","label"} or plain strings, e.g. ["Monthly plan","Buy unlocked"].',
        },
        fields: {
          type: 'STRING',
          description:
            'For form: JSON array of {id, label, type, required, options, autocomplete}. type: text, email, tel, number, select, toggle. autocomplete: name, email, tel, street-address, etc.',
        },
      },
      required: ['type', 'title'],
    },
  },
  {
    name: 'vault_get',
    description:
      "Read the user's autofill profile (name, email, phone, address) and saved account labels (site + username). Never returns passwords. Use before filling a site.",
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'vault_set',
    description:
      'Save a non-secret autofill profile field (name, email, phone, address, city, state, zip, country). Do not put passwords here — the user adds those in Autofill → Accounts on the phone.',
    parameters: {
      type: 'OBJECT',
      properties: {
        field: { type: 'STRING', description: 'Profile key, e.g. name, email, phone, address.' },
        value: { type: 'STRING', description: 'Value to save.' },
        fields: { type: 'STRING', description: 'Optional JSON map of several profile fields.' },
      },
    },
  },
];

function expandHome(p) {
  if (!p) return os.homedir();
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function parseJsonList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw];
  if (typeof raw !== 'string') return [];
  const s = raw.trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    /* lines or commas */
  }
  return s.split(/\n|,/).map((part) => part.trim()).filter(Boolean);
}

function slug(s, fallback) {
  const n = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return n || fallback;
}

function normalizeOptions(raw) {
  return parseJsonList(raw).map((o, i) => {
    if (typeof o === 'string') return { id: slug(o, `opt-${i}`), label: o };
    return {
      id: String(o.id || o.value || slug(o.label, `opt-${i}`)),
      label: String(o.label || o.id || o.value || `Option ${i + 1}`),
    };
  });
}

const FIELD_TYPES = { text: 'text', email: 'email', tel: 'tel', phone: 'tel', number: 'number', select: 'select', toggle: 'toggle' };

function normalizeFields(raw) {
  return parseJsonList(raw).map((f, i) => {
    if (typeof f === 'string') {
      return { id: slug(f, `field-${i}`), label: f, type: 'text', required: false, autocomplete: '', value: '' };
    }
    const type = FIELD_TYPES[String(f.type || 'text').toLowerCase()] || 'text';
    return {
      id: String(f.id || slug(f.label, `field-${i}`)),
      label: String(f.label || f.id || `Field ${i + 1}`),
      type,
      required: Boolean(f.required),
      options: f.options ? normalizeOptions(f.options) : undefined,
      autocomplete: String(f.autocomplete || f.hint || ''),
      placeholder: String(f.placeholder || ''),
      value: f.value == null ? '' : f.value,
    };
  });
}

function normalizeAskUser(args = {}) {
  const type = String(args.type || '').toLowerCase() === 'form' ? 'form' : 'choice';
  const title = String(args.title || args.question || '').trim();
  const context = String(args.context || args.reason || '').trim();
  const poll = { type, title, context, multi: Boolean(args.multi) };
  if (type === 'choice') {
    poll.options = normalizeOptions(args.options);
  } else {
    poll.fields = vault.prefillFields(normalizeFields(args.fields));
  }
  return poll;
}

async function askUser(args, ctx = {}) {
  const poll = normalizeAskUser(args);
  if (!poll.title) return { error: 'ask_user needs a title / question.' };
  if (poll.type === 'choice' && !poll.options.length) {
    return { error: 'choice polls need options. Pass a JSON array of labels.' };
  }
  if (poll.type === 'form' && !poll.fields.length) {
    return { error: 'form polls need fields. Pass a JSON array of {id, label, type}.' };
  }
  if (!ctx.requestPoll) return { error: 'Phone poll is not available.' };
  const result = await ctx.requestPoll(poll);
  if (result?.submitted && result.answers && poll.type === 'form') {
    vault.learnAnswers(result.answers);
  }
  return {
    submitted: Boolean(result?.submitted),
    reason: result?.reason || undefined,
    answers: vault.publicAnswers(result?.answers),
    hint: result?.submitted
      ? 'Use these answers now: open Safari, fill the site yourself, and click Submit. Do not ask them to walk to the Mac.'
      : 'The user did not answer. Do not invent their choice — report that you are waiting or stop.',
  };
}

function mergeVaultLogin(map, args) {
  const accountKey = args.account || args.site || (args.from_vault ? args.field : '');
  if (!args.from_vault && !accountKey) return { map, vault: null };
  if (!accountKey) return { map, vault: { error: 'from_vault needs an account / field site name, e.g. "amazon".' } };
  const creds = vault.loginFields(accountKey, {
    usernameField: args.username_field || args.username_selector,
    passwordField: args.password_field || args.password_selector,
  });
  if (creds.error) return { map, vault: creds };
  return {
    map: { ...creds.map, ...map },
    vault: { site: creds.site, username: creds.username, has_secret: creds.has_secret },
  };
}

async function fillFromArgs(args = {}) {
  const map = safari.parseFields(args.fields);
  if (args.selector && args.value != null && args.selector !== args.account && args.selector !== args.field) {
    map[args.selector] = args.value;
  }
  const merged = mergeVaultLogin(map, args);
  if (merged.vault?.error) return merged.vault;
  const result = await safari.fillFields(merged.map);
  return vault.publicToolResult('safari_fill', {
    ...result,
    from_vault: Boolean(merged.vault),
    account: merged.vault?.site,
  });
}

async function runWebTask(args = {}) {
  const map = safari.parseFields(args.fields);
  const merged = mergeVaultLogin(map, args);
  if (merged.vault?.error) return merged.vault;
  const result = await safari.webTask({ ...args, fields: merged.map });
  return vault.publicToolResult('web_task', {
    ...result,
    from_vault: Boolean(merged.vault),
    account: merged.vault?.site,
  });
}

function setVaultFromTool(args = {}) {
  if (args.secret || args.password || vault.isSecretKey(args.field)) {
    return {
      error:
        'Do not store passwords through this tool. Ask the user to add the account under Autofill → Accounts on their phone, then safari_fill with from_vault:true.',
    };
  }
  const fields = { ...safari.parseFields(args.fields) };
  if (args.field) fields[args.field] = args.value == null ? '' : args.value;
  if (!Object.keys(fields).length) return { error: 'Pass field+value or a fields JSON map.' };
  return vault.setProfile(fields);
}

function truncate(s) {
  if (typeof s !== 'string') return s;
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…[truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

function appleQuote(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runShell(command) {
  return new Promise((resolve) => {
    exec(command, { shell: '/bin/zsh', timeout: SHELL_TIMEOUT_MS, cwd: os.homedir(), maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => {
        const out = { stdout: truncate(stdout || ''), stderr: truncate(stderr || '') };
        if (err) out.error = err.killed ? 'Command timed out after 45s' : `Exit code ${err.code ?? 'unknown'}`;
        resolve(out);
      });
  });
}

function runExecFile(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: SHELL_TIMEOUT_MS, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      const out = { stdout: truncate(stdout || ''), stderr: truncate(stderr || '') };
      if (err) out.error = err.killed ? 'Timed out after 45s' : String(err.message).slice(0, 500);
      resolve(out);
    });
  });
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(script|style)[\s\S]*$/gi, ' ')
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

async function readTextCap(res, maxBytes) {
  const reader = res && res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const raw = res ? await res.text() : '';
    return raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
  }
  const chunks = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      const take = Math.min(value.byteLength, maxBytes - received);
      chunks.push(Buffer.from(value.buffer, value.byteOffset, take));
      received += take;
      if (take < value.byteLength) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

const IMPLEMENTATIONS = {
  fetch_url: async ({ url }) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return { error: 'Only http(s) URLs are allowed.' };
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const ctype = String(res.headers.get('content-type') || '');
      if (ctype && !/text|json|xml|javascript|svg/i.test(ctype)) {
        try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* ignore */ }
        return {
          status: res.status,
          url: res.url || url,
          error: `Not a readable page (${ctype.slice(0, 60)}). Try another URL.`,
        };
      }
      const raw = await readTextCap(res, 400_000);
      const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
      return {
        status: res.status,
        url: res.url || url,
        title: title ? htmlToText(title).slice(0, 200) : '',
        text: truncate(htmlToText(raw)),
      };
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { error: timedOut ? 'Fetch timed out. Try another URL.' : String(e && e.message || e) };
    }
  },

  open_url: async ({ url }) => {
    if (!/^https?:\/\//i.test(url)) return { error: 'Only http(s) URLs are allowed.' };
    return safari.openUrl(url);
  },

  open_app: ({ name }) => runExecFile('open', ['-a', name]),

  find_contact: async ({ name }) => {
    let matches = findLocalContact(name);
    if (!matches.length) matches = await findInMessages(name);
    if (matches.length) {
      const best = matches[0];
      await saveContact({ name: best.name || name, phone: best.phone, email: best.email });
      return { matches, hint: 'Call or text using the phone/email above. Do not ask the user for a number.' };
    }
    return {
      matches: [],
      hint: `No number found for "${name}". Ask for the phone number or Apple ID only — no extra explanation.`,
    };
  },

  save_contact: (args) => saveContact(args),

  send_imessage: async ({ to, body }) => {
    const target = appleQuote(to);
    const msg = appleQuote(body);
    const script = `
      tell application "Messages"
        activate
        try
          set svc to 1st service whose service type = iMessage
          send "${msg}" to buddy "${target}" of svc
          return "sent via iMessage"
        on error err1
          try
            send "${msg}" to participant "${target}" of 1st account
            return "sent via account"
          on error err2
            return "Messages error: " & err1 & " / " & err2
          end try
        end try
      end tell
    `;
    const result = await runExecFile('osascript', ['-e', script]);
    if (result.error || /error/i.test(result.stdout || '')) {
      const fallback = await runExecFile('open', [`imessage:${to}?body=${encodeURIComponent(body)}`]);
      return {
        ...result,
        fallback: 'Opened Messages compose window — tap Send if it did not auto-send.',
        open: fallback,
      };
    }
    return result;
  },

  facetime_call: async ({ to, audio }) => {
    const ui = await callViaContacts(to, Boolean(audio));
    let handle = String(to || '');
    if (!/@|\d{6,}/.test(handle)) {
      const found = [...findLocalContact(to), ...(await findInMessages(to))];
      handle = found[0]?.phone || found[0]?.email || '';
    }
    if (handle && /@|\d{6,}/.test(handle)) {
      const scheme = audio ? 'facetime-audio' : 'facetime';
      await runExecFile('open', [`${scheme}://${handle.replace(/\s+/g, '')}`]);
      await saveContact({
        name: String(to),
        phone: /\d/.test(handle) && !handle.includes('@') ? handle : '',
        email: handle.includes('@') ? handle : '',
      });
    } else {
      await activateApp('FaceTime');
      await typeSearch('FaceTime', to);
    }
    await new Promise((r) => setTimeout(r, 900));
    const tapped = await clickFaceTimeCallButton();
    let vision = null;
    if (!tapped.ok) {
      vision = await clickPrimaryAction({
        apiKey: (process.env.GEMINI_API_KEY || '').trim(),
        model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      });
    }
    return {
      ok: Boolean(tapped.ok || vision?.ok),
      via: 'Contacts then FaceTime then click the green Call button',
      name: to,
      handle,
      ui,
      tapped,
      vision,
    };
  },

  run_shell: ({ command }) => {
    const cmd = String(command || '');
    if (/\b(curl|wget|lynx|w3m)\b/i.test(cmd) || (/https?:\/\//i.test(cmd) && /\b(curl|wget|python|node|ruby|perl)\b/i.test(cmd))) {
      return { error: 'Do not fetch pages from the shell. Call fetch_url with the http(s) URL.' };
    }
    return runShell(cmd);
  },

  run_applescript: ({ script }) => runExecFile('osascript', ['-e', script]),

  read_file: async ({ path: p }) => {
    try {
      const full = expandHome(p);
      const stat = await fs.stat(full);
      if (stat.size > 100 * 1024) {
        const fh = await fs.open(full, 'r');
        const buf = Buffer.alloc(100 * 1024);
        await fh.read(buf, 0, buf.length, 0);
        await fh.close();
        return { content: buf.toString('utf8') + '\n…[file truncated at 100KB]' };
      }
      return { content: await fs.readFile(full, 'utf8') };
    } catch (e) {
      return { error: String(e.message) };
    }
  },

  write_file: async ({ path: p, content }) => {
    try {
      const full = expandHome(p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, 'utf8');
      return { ok: true, path: full, bytes: Buffer.byteLength(content) };
    } catch (e) {
      return { error: String(e.message) };
    }
  },

  use_computer: async ({ goal }) =>
    useComputer(goal, {
      apiKey: (process.env.GEMINI_API_KEY || '').trim(),
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    }),

  see_screen: async () => {
    try {
      const buf = await captureScreen();
      return {
        ok: true,
        note: 'Screen captured. An image of the current display follows.',
        image: buf.toString('base64'),
        mime: 'image/jpeg',
      };
    } catch (e) {
      return {
        error:
          'Screen capture failed. Grant Screen Recording to the app that launched Kyte, then retry.',
        detail: String(e.message),
      };
    }
  },

  schedule_task: (args) => addJob(args),
  list_schedule: () => ({ jobs: loadJobs() }),
  cancel_task: ({ id }) => cancelJob(id),

  approve_system_dialog: () => clickAllowDialogs(),

  save_memory: ({ fact }) => appendMemory(fact),

  list_dir: async ({ path: p } = {}) => {
    try {
      const full = expandHome(p);
      const entries = await fs.readdir(full, { withFileTypes: true });
      return {
        path: full,
        entries: entries.slice(0, 200).map((e) => (e.isDirectory() ? e.name + '/' : e.name)),
      };
    } catch (e) {
      return { error: String(e.message) };
    }
  },

  safari_open: (args) => safari.openFromArgs(args),
  browse_safari: (args) => safari.openFromArgs(args),
  safari_eval: ({ javascript }) => safari.evalJs(javascript),
  safari_fill: (args) => fillFromArgs(args),
  safari_click: ({ target }) => safari.clickAndFinish(target),
  safari_read: () => safari.readPage(),
  safari_tabs: () => safari.listTabs(),
  web_task: (args) => runWebTask(args),
  ask_user: (args, ctx) => askUser(args, ctx),
  vault_get: () => vault.publicView(),
  vault_set: (args) => setVaultFromTool(args),
};

const DESTRUCTIVE_SHELL = /\b(rm\s|rmdir\s|unlink\s|dd\s|mkfs|diskutil\s+erase|sudo\s|shutdown\b|reboot\b|halt\b|>:?\s*\/|chmod\s+777|chown\s)/i;

function isRisky(name, args = {}) {
  if (name === 'run_shell') return DESTRUCTIVE_SHELL.test(args.command || '');
  if (name === 'write_file') {
    const p = String(args.path || '');
    return /(^|\/)\.(ssh|gnupg|aws|config)\b|\/etc\/|\/Library\/Keychains/i.test(p);
  }
  return false;
}

async function executeTool(name, args, ctx = {}) {
  const impl = IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  try {
    if (name !== 'approve_system_dialog' && name !== 'ask_user' && name !== 'vault_get' && name !== 'vault_set') {
      await clickAllowDialogs();
    }
    const result = await impl(args || {}, ctx);
    if (name !== 'ask_user' && name !== 'vault_get' && name !== 'vault_set') await clickAllowDialogs();
    return result;
  } catch (e) {
    try {
      if (name !== 'ask_user') await clickAllowDialogs();
    } catch { /* a dialog sweep must not mask the tool error */ }
    return { error: String(e && e.message || e) };
  }
}

module.exports = { TOOL_DECLARATIONS, executeTool, isRisky, normalizeAskUser, readTextCap };
