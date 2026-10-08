// Kyte's long-term memory: a plain markdown file the agent reads on every
// request and appends to via the save_memory tool. Transparent and editable —
// open data/memory.md to see or change what Kyte knows about you.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const MEMORY_PATH = path.join(DATA_DIR, 'memory.md');
const MAX_PROMPT_CHARS = 6000; // how much memory is injected into the prompt

function loadMemory() {
  try {
    const text = fs.readFileSync(MEMORY_PATH, 'utf8').trim();
    if (!text) return '';
    return text.length > MAX_PROMPT_CHARS
      ? '…[older memories trimmed]\n' + text.slice(-MAX_PROMPT_CHARS)
      : text;
  } catch {
    return '';
  }
}

async function appendMemory(fact) {
  const clean = String(fact || '').trim();
  if (!clean) return { error: 'Empty fact.' };
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  await fsp.appendFile(MEMORY_PATH, `- [${date}] ${clean}\n`, 'utf8');
  return { ok: true, saved: clean };
}

module.exports = { loadMemory, appendMemory, MEMORY_PATH, DATA_DIR };
