// Kyte's own address book — a local file, not macOS Contacts.
// This avoids the "Cursor wants your Contacts" permission dialog.

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { DATA_DIR, loadMemory } = require('./memory');

const CONTACTS_PATH = path.join(DATA_DIR, 'contacts.json');

function loadContacts() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONTACTS_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function saveContact({ name, phone, email, note }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return { error: 'Name is required.' };
  const phoneClean = String(phone || '').trim();
  const emailClean = String(email || '').trim();
  if (!phoneClean && !emailClean) return { error: 'Need a phone number or email.' };

  await fsp.mkdir(DATA_DIR, { recursive: true });
  const list = loadContacts();
  const key = cleanName.toLowerCase();
  const existing = list.find((c) => c.name.toLowerCase() === key);
  const entry = {
    name: cleanName,
    phone: phoneClean || existing?.phone || '',
    email: emailClean || existing?.email || '',
    note: String(note || existing?.note || '').trim(),
  };
  if (existing) Object.assign(existing, entry);
  else list.push(entry);
  await fsp.writeFile(CONTACTS_PATH, JSON.stringify(list, null, 2));
  return { ok: true, contact: entry };
}

function findInMessages(name) {
  const q = String(name || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
    tell application "Messages"
      set out to ""
      repeat with b in every buddy
        try
          set n to name of b as text
          set h to handle of b as text
          if n contains "${q}" or h contains "${q}" then
            set out to out & n & tab & h & linefeed
          end if
        end try
      end repeat
      return out
    end tell
  `;
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve([]);
      const matches = String(stdout || '')
        .split('\n')
        .map((line) => line.split('\t'))
        .filter((p) => p.length >= 2 && p[1])
        .map(([n, handle]) => ({
          name: n.trim(),
          phone: /@/.test(handle) ? '' : handle.trim(),
          email: /@/.test(handle) ? handle.trim() : '',
          source: 'messages',
        }));
      resolve(matches);
    });
  });
}

function findLocalContact(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return [];
  const fromFile = loadContacts().filter((c) => c.name.toLowerCase().includes(q));

  // Also scrape memory.md for "Name: +1…" style facts the user already taught Kyte.
  const memory = loadMemory();
  const fromMemory = [];
  const lineRe = /([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)[^\n]{0,40}(\+?\d[\d\s().-]{6,}\d|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
  let m;
  while ((m = lineRe.exec(memory))) {
    if (m[1].toLowerCase().includes(q) || q.includes(m[1].toLowerCase())) {
      const value = m[2];
      fromMemory.push({
        name: m[1],
        phone: /\d/.test(value) && !value.includes('@') ? value : '',
        email: value.includes('@') ? value : '',
        source: 'memory',
      });
    }
  }
  return [...fromFile, ...fromMemory];
}

module.exports = { loadContacts, saveContact, findLocalContact, findInMessages, CONTACTS_PATH };
