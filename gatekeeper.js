// Sentinel-style action gatekeeper.
// Every tool call is classified, then allowed / denied / asked.
// Approvals can be remembered so the same class of action stops interrupting you.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./memory');

const POLICY_PATH = path.join(DATA_DIR, 'policies.json');

const DEFAULT_CLASSES = {
  research: 'allow',
  browser: 'allow',
  launch: 'allow',
  read: 'allow',
  memory: 'allow',
  poll: 'allow',
  system: 'allow',
  schedule: 'allow',
  vision: 'allow',
  message: 'allow',
  call: 'allow',
  write: 'allow',
  shell_safe: 'allow',
  applescript: 'allow',
  destructive: 'ask',
  secrets: 'ask',
};

const DESTRUCTIVE_SHELL = /\b(rm\s|rmdir\s|unlink\s|dd\s|mkfs|diskutil\s+erase|sudo\s|shutdown\b|reboot\b|halt\b|chmod\s+777|chown\s)/i;
const SECRET_PATH = /(^|\/)\.(ssh|gnupg|aws)\b|\/etc\/|\/Library\/Keychains|\.env\b|credentials|id_rsa|id_ed25519/i;

function loadPolicy() {
  try {
    const raw = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    return {
      classes: { ...DEFAULT_CLASSES, ...(raw.classes || {}) },
      learned: Array.isArray(raw.learned) ? raw.learned : [],
    };
  } catch {
    return { classes: { ...DEFAULT_CLASSES }, learned: [] };
  }
}

function savePolicy(policy) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2));
}

function fingerprint(name, args = {}) {
  const gist = args.command || args.path || args.url || args.to || args.script || args.prompt || args.goal || args.target || '';
  return `${name}|${String(gist).slice(0, 80)}`.toLowerCase();
}

function classify(name, args = {}) {
  if (name === 'fetch_url') return 'research';
  if (
    name === 'open_url' ||
    name === 'safari_open' ||
    name === 'browse_safari' ||
    name === 'safari_eval' ||
    name === 'safari_fill' ||
    name === 'safari_click' ||
    name === 'safari_read' ||
    name === 'safari_tabs' ||
    name === 'web_task'
  ) {
    return 'browser';
  }
  if (name === 'open_app') return 'launch';
  if (name === 'read_file' || name === 'list_dir' || name === 'find_contact') return 'read';
  if (name === 'ask_user') return 'poll';
  if (name === 'vault_get') return 'memory';
  if (name === 'vault_set') {
    const blob = `${args.field || ''} ${args.secret || ''} ${args.password || ''} ${args.value || ''} ${args.fields || ''}`;
    if (/secret|password|passwd|api[_-]?key/i.test(blob) || args.secret || args.password) return 'secrets';
    return 'memory';
  }
  if (name === 'save_memory' || name === 'save_contact') return 'memory';
  if (name === 'approve_system_dialog') return 'system';
  if (name === 'schedule_task' || name === 'list_schedule' || name === 'cancel_task') return 'schedule';
  if (name === 'see_screen' || name === 'use_computer') return 'vision';
  if (name === 'send_imessage') return 'message';
  if (name === 'facetime_call') return 'call';
  if (name === 'write_file') return SECRET_PATH.test(args.path || '') ? 'secrets' : 'write';
  if (name === 'run_shell') return DESTRUCTIVE_SHELL.test(args.command || '') ? 'destructive' : 'shell_safe';
  if (name === 'run_applescript') {
    const s = String(args.script || '');
    if (/delete|empty trash|rm\s/i.test(s)) return 'destructive';
    return 'applescript';
  }
  return 'shell_safe';
}

function decide(name, args = {}) {
  const policy = loadPolicy();
  const cls = classify(name, args);
  const fp = fingerprint(name, args);
  const learned = policy.learned.find((l) => {
    const remembered = String(l?.fingerprint || '');
    if (!remembered) return false;
    return fp.startsWith(remembered) || remembered.startsWith(fp.slice(0, 40));
  });
  if (learned) {
    return { verdict: learned.verdict, class: cls, reason: `Remembered: you ${learned.verdict}ed this before.`, fingerprint: fp };
  }
  const classLearn = policy.learned.find((l) => l.class === cls && l.scope === 'class');
  if (classLearn) {
    return { verdict: classLearn.verdict, class: cls, reason: `Class “${cls}” is ${classLearn.verdict}.`, fingerprint: fp };
  }
  const verdict = policy.classes[cls] || 'ask';
  const reason =
    verdict === 'allow'
      ? `Auto-allowed (${cls})`
      : verdict === 'deny'
        ? `Blocked by policy (${cls})`
        : `Needs a tap (${cls})`;
  return { verdict, class: cls, reason, fingerprint: fp };
}

function remember(name, args, verdict, scope = 'fingerprint') {
  const policy = loadPolicy();
  const cls = classify(name, args);
  const fp = fingerprint(name, args);
  const entry = scope === 'class' ? { class: cls, scope: 'class', verdict } : { fingerprint: fp, class: cls, verdict };
  policy.learned = policy.learned.filter((l) => {
    if (scope === 'class') return !(l.class === cls && l.scope === 'class');
    return (l.fingerprint || '') !== fp;
  });
  policy.learned.unshift(entry);
  policy.learned = policy.learned.slice(0, 200);
  savePolicy(policy);
  return entry;
}

function summarizePolicy() {
  const policy = loadPolicy();
  return { classes: policy.classes, learned: policy.learned.slice(0, 30) };
}

module.exports = { decide, remember, classify, summarizePolicy, loadPolicy, savePolicy };
