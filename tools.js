// Kyte's hands: the actions it can perform on this Mac.
// Each tool has a declaration (shown to the model) and an implementation.
// Tools marked risky require user approval from the phone before running.

const { exec, execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const MAX_OUTPUT = 8000; // chars of tool output sent back to the model
const SHELL_TIMEOUT_MS = 30_000;

const RISKY_TOOLS = new Set(['run_shell', 'run_applescript', 'write_file']);

const TOOL_DECLARATIONS = [
  {
    name: 'run_shell',
    description:
      'Run a shell command on the Mac (zsh). Use for anything: launching processes, moving files, checking system state, screenshots (screencapture), volume (osascript), etc. Returns stdout and stderr. Requires user approval.',
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
      'Run an AppleScript on the Mac. Best for controlling apps (Safari tabs, Music, Messages, Finder windows, clicking menus). Requires user approval.',
    parameters: {
      type: 'OBJECT',
      properties: {
        script: { type: 'STRING', description: 'The AppleScript source to execute.' },
      },
      required: ['script'],
    },
  },
  {
    name: 'open_app',
    description: 'Open (or bring to front) a macOS application by name, e.g. "Safari", "Notes", "Spotify".',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Application name as it appears in /Applications.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'open_url',
    description: 'Open a URL in the default browser.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'The http(s) URL to open.' },
      },
      required: ['url'],
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
    description: 'Write/overwrite a text file on the Mac. Requires user approval.',
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
    name: 'list_dir',
    description: 'List the contents of a directory on the Mac.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Absolute path, or path starting with ~/. Defaults to home.' },
      },
    },
  },
];

function expandHome(p) {
  if (!p) return os.homedir();
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function truncate(s) {
  if (typeof s !== 'string') return s;
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…[truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

function runShell(command) {
  return new Promise((resolve) => {
    exec(command, { shell: '/bin/zsh', timeout: SHELL_TIMEOUT_MS, cwd: os.homedir(), maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = { stdout: truncate(stdout || ''), stderr: truncate(stderr || '') };
        if (err) out.error = err.killed ? 'Command timed out after 30s' : `Exit code ${err.code ?? 'unknown'}`;
        resolve(out);
      });
  });
}

function runExecFile(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: SHELL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = { stdout: truncate(stdout || ''), stderr: truncate(stderr || '') };
      if (err) out.error = err.killed ? 'Timed out after 30s' : String(err.message).slice(0, 500);
      resolve(out);
    });
  });
}

const IMPLEMENTATIONS = {
  run_shell: ({ command }) => runShell(command),

  run_applescript: ({ script }) => runExecFile('osascript', ['-e', script]),

  open_app: ({ name }) => runExecFile('open', ['-a', name]),

  open_url: async ({ url }) => {
    if (!/^https?:\/\//i.test(url)) return { error: 'Only http(s) URLs are allowed.' };
    return runExecFile('open', [url]);
  },

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
};

function isRisky(name) {
  return RISKY_TOOLS.has(name);
}

async function executeTool(name, args) {
  const impl = IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  try {
    return await impl(args || {});
  } catch (e) {
    return { error: String(e.message) };
  }
}

module.exports = { TOOL_DECLARATIONS, executeTool, isRisky };
