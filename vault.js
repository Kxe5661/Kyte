// Autofill vault: profile + site credentials.
// Secrets stay on disk. Never echo them into chat, SSE, or Gemini history.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, appendMemory } = require('./memory');

const VAULT_PATH = path.join(DATA_DIR, 'vault.json');

const PROFILE_KEYS = ['name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'country'];

const AUTOCOMPLETE = {
  name: 'name',
  'full-name': 'name',
  full_name: 'name',
  fullname: 'name',
  'given-name': 'name',
  'family-name': 'name',
  email: 'email',
  'email-address': 'email',
  tel: 'phone',
  phone: 'phone',
  mobile: 'phone',
  'tel-national': 'phone',
  'tel-local': 'phone',
  'street-address': 'address',
  address: 'address',
  'address-line1': 'address',
  'address-line2': 'address',
  city: 'city',
  'address-level2': 'city',
  state: 'state',
  region: 'state',
  'address-level1': 'state',
  zip: 'zip',
  zipcode: 'zip',
  'postal-code': 'zip',
  postcode: 'zip',
  country: 'country',
  'country-name': 'country',
};

const SECRET_KEY = /pass|secret|pwd|passwd|cvv|ssn|pin\b|token|api[_-]?key/i;

function emptyVault() {
  return {
    profile: Object.fromEntries(PROFILE_KEYS.map((k) => [k, ''])),
    accounts: [],
  };
}

function loadVault() {
  try {
    const raw = JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8'));
    const base = emptyVault();
    const profile = { ...base.profile, ...(raw.profile && typeof raw.profile === 'object' ? raw.profile : {}) };
    for (const k of PROFILE_KEYS) profile[k] = profile[k] == null ? '' : String(profile[k]);
    const accounts = Array.isArray(raw.accounts)
      ? raw.accounts
          .filter((a) => a && (a.site || a.username || a.secret))
          .map((a) => ({
            id: String(a.id || crypto.randomUUID()),
            site: String(a.site || '').trim(),
            username: String(a.username || '').trim(),
            secret: String(a.secret || ''),
          }))
      : [];
    return { profile, accounts };
  } catch {
    return emptyVault();
  }
}

function saveVault(vault) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2), { mode: 0o600 });
  return vault;
}

function publicView() {
  const v = loadVault();
  return {
    profile: { ...v.profile },
    accounts: v.accounts.map((a) => ({
      id: a.id,
      site: a.site,
      username: a.username,
      has_secret: Boolean(a.secret),
    })),
  };
}

function profileFacts() {
  const { profile } = loadVault();
  const out = {};
  for (const k of PROFILE_KEYS) {
    if (profile[k]) out[k] = profile[k];
  }
  return out;
}

function setProfile(fields = {}) {
  const v = loadVault();
  const changed = [];
  for (const [rawKey, rawVal] of Object.entries(fields || {})) {
    const key = AUTOCOMPLETE[String(rawKey).toLowerCase()] || (PROFILE_KEYS.includes(rawKey) ? rawKey : '');
    if (!key || SECRET_KEY.test(rawKey)) continue;
    const val = String(rawVal == null ? '' : rawVal).trim();
    if (v.profile[key] === val) continue;
    v.profile[key] = val;
    changed.push(key);
  }
  if (changed.length) saveVault(v);
  return { ok: true, updated: changed, profile: { ...v.profile } };
}

function findAccount(siteOrId) {
  const v = loadVault();
  const q = String(siteOrId || '').trim().toLowerCase();
  if (!q) return null;
  return (
    v.accounts.find((a) => a.id === siteOrId) ||
    v.accounts.find((a) => String(a.site).toLowerCase() === q) ||
    v.accounts.find((a) => String(a.site).toLowerCase().includes(q) || q.includes(String(a.site).toLowerCase()))
  );
}

function setAccount({ id, site, username, secret, password } = {}) {
  const v = loadVault();
  const nextSecret = secret != null ? secret : password;
  let acct = id ? v.accounts.find((a) => a.id === id) : null;
  if (!acct && site) {
    acct = v.accounts.find((a) => String(a.site).toLowerCase() === String(site).trim().toLowerCase());
  }
  if (!acct) {
    acct = { id: crypto.randomUUID(), site: '', username: '', secret: '' };
    v.accounts.unshift(acct);
  }
  if (site != null) acct.site = String(site).trim();
  if (username != null) acct.username = String(username).trim();
  if (nextSecret != null && String(nextSecret) !== '') acct.secret = String(nextSecret);
  if (!acct.site && !acct.username) {
    v.accounts = v.accounts.filter((a) => a.id !== acct.id);
    saveVault(v);
    return { error: 'Account needs a site or username.' };
  }
  saveVault(v);
  return { ok: true, account: { id: acct.id, site: acct.site, username: acct.username, has_secret: Boolean(acct.secret) } };
}

function deleteAccount(id) {
  const v = loadVault();
  const before = v.accounts.length;
  v.accounts = v.accounts.filter((a) => a.id !== id);
  if (v.accounts.length === before) return { error: 'No such account.' };
  saveVault(v);
  return { ok: true };
}

function loginFields(siteOrId, { usernameField, passwordField } = {}) {
  const acct = findAccount(siteOrId);
  if (!acct) {
    return { error: `No saved account matching "${siteOrId}". Add it in Autofill → Accounts on the phone.` };
  }
  const map = {};
  if (acct.username) {
    if (usernameField) map[usernameField] = acct.username;
    else {
      map.email = acct.username;
      map.username = acct.username;
    }
  }
  if (acct.secret) {
    map[passwordField || 'password'] = acct.secret;
  }
  return { ok: true, site: acct.site, username: acct.username, has_secret: Boolean(acct.secret), map };
}

function profileKeyFor(field) {
  const hint = String(field.autocomplete || field.id || field.label || '').toLowerCase().trim();
  if (AUTOCOMPLETE[hint]) return AUTOCOMPLETE[hint];
  for (const [k, v] of Object.entries(AUTOCOMPLETE)) {
    if (hint.includes(k)) return v;
  }
  return '';
}

function prefillFields(fields) {
  const facts = profileFacts();
  return (fields || []).map((f) => {
    const key = profileKeyFor(f);
    if (key && facts[key] && (f.value == null || f.value === '')) {
      return { ...f, value: facts[key] };
    }
    return { ...f };
  });
}

function isSecretKey(key) {
  return SECRET_KEY.test(String(key || ''));
}

function redactValue(key, value) {
  if (value == null || value === '') return value;
  return isSecretKey(key) ? '••••' : value;
}

function redactMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return map;
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = redactValue(k, v);
  return out;
}

function publicAnswers(answers) {
  if (!answers || typeof answers !== 'object') return answers;
  if (Array.isArray(answers.selected) || answers.choice != null) {
    return {
      selected: answers.selected,
      choice: answers.choice,
      labels: answers.labels,
    };
  }
  const out = {};
  for (const [k, v] of Object.entries(answers)) {
    if (k === 'selected' || k === 'choice' || k === 'labels') out[k] = v;
    else out[k] = redactValue(k, v);
  }
  return out;
}

function learnAnswers(answers) {
  if (!answers || typeof answers !== 'object') return { ok: true, updated: [] };
  const fields = {};
  for (const [k, v] of Object.entries(answers)) {
    if (k === 'selected' || k === 'choice' || k === 'labels' || isSecretKey(k)) continue;
    if (v == null || v === '' || typeof v === 'boolean') continue;
    const key = AUTOCOMPLETE[String(k).toLowerCase()] || profileKeyFor({ id: k, label: k });
    if (key) fields[key] = v;
  }
  const result = setProfile(fields);
  if (result.updated && result.updated.length) {
    const bits = result.updated
      .filter((k) => result.profile[k])
      .map((k) => `${k}: ${result.profile[k]}`)
      .join(', ');
    if (bits) appendMemory(`Autofill profile — ${bits}`).catch(() => {});
  }
  return result;
}

function publicToolArgs(name, args) {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  if (name === 'safari_fill' || name === 'web_task') {
    if (out.from_vault || isSecretKey(out.selector) || isSecretKey(out.field)) {
      if (out.value) out.value = '••••';
    }
    if (out.fields) {
      if (typeof out.fields === 'string') {
        try {
          out.fields = JSON.stringify(redactMap(JSON.parse(out.fields)));
        } catch {
          if (SECRET_KEY.test(out.fields)) out.fields = '[redacted]';
        }
      } else {
        out.fields = redactMap(out.fields);
      }
    }
  }
  if (name === 'vault_set') {
    if (out.secret) out.secret = '••••';
    if (out.password) out.password = '••••';
    if (out.value && isSecretKey(out.field)) out.value = '••••';
  }
  return out;
}

function publicToolResult(name, result) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  delete out.map;
  delete out.secret;
  delete out.password;
  if (out.fields) out.fields = redactMap(out.fields);
  if (out.answers) out.answers = publicAnswers(out.answers);
  if (name === 'safari_fill' || name === 'web_task') {
    if (out.filled && Array.isArray(out.filled)) {
      out.filled = out.filled.map((f) => (typeof f === 'object' ? { key: f.key, name: f.name } : f));
    }
  }
  return out;
}

module.exports = {
  VAULT_PATH,
  PROFILE_KEYS,
  loadVault,
  saveVault,
  publicView,
  profileFacts,
  setProfile,
  setAccount,
  deleteAccount,
  findAccount,
  loginFields,
  prefillFields,
  profileKeyFor,
  learnAnswers,
  isSecretKey,
  redactMap,
  publicAnswers,
  publicToolArgs,
  publicToolResult,
};
