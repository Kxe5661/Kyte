// Watch for macOS permission dialogs and click Allow so you don't have to
// be at the Mac. Needs Accessibility granted ONCE to the app that launched
// Kyte (Terminal or Cursor). After that, Kyte moves the mouse itself.

const { execFile } = require('child_process');

const TITLE_HINTS = [
  'would like',
  'wants to',
  'access your',
  'control',
  'automation',
  'accessibility',
  'contacts',
  'screen rec',
  'keychain',
  'system events',
  'use your',
  'permission',
];

const ALLOW_NAMES = ['allow', 'allow once', 'ok', 'open'];

function runApple(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: err ? String(err.message || stderr || '') : '',
      });
    });
  });
}

async function hasAccessibility() {
  const r = await runApple('tell application "System Events" to get name of first process');
  return r.ok && !!r.out;
}

async function openAccessibilitySettings() {
  await runApple(`
    try
      open location "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility"
    on error
      open location "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    end try
  `);
}

function looksLikePermissionWindow(title) {
  const t = String(title || '').toLowerCase();
  return TITLE_HINTS.some((h) => t.includes(h));
}

// Lists matching Allow buttons as: process|title|button|x|y|w|h
const SCAN_SCRIPT = `
tell application "System Events"
  set rows to {}
  repeat with proc in application processes
    try
      if (count of windows of proc) is 0 then
      else
        repeat with w in windows of proc
          set wtitle to ""
          try
            set wtitle to name of w as text
          end try
          repeat with b in buttons of w
            try
              set bn to name of b as text
              set p to position of b
              set s to size of b
              set end of rows to (name of proc as text) & tab & wtitle & tab & bn & tab & (item 1 of p as text) & tab & (item 2 of p as text) & tab & (item 1 of s as text) & tab & (item 2 of s as text)
            end try
          end repeat
        end repeat
      end if
    end try
  end repeat
  set AppleScript's text item delimiters to linefeed
  return rows as text
end tell
`;

function parseScan(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((p) => p.length >= 7)
    .map((p) => ({
      process: p[0],
      title: p[1],
      button: p[2],
      x: Number(p[3]),
      y: Number(p[4]),
      w: Number(p[5]),
      h: Number(p[6]),
    }));
}

function moveAndClickScript(x, y) {
  return `
    ObjC.import("Cocoa");
    function clickAt(x, y) {
      var pt = $.CGPointMake(x, y);
      var evs = [
        $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, pt, 0),
        $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, 0),
        $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, 0)
      ];
      for (var i = 0; i < evs.length; i++) {
        $.CGEventPost($.kCGHIDEventTap, evs[i]);
        delay(0.04);
      }
    }
    clickAt(${Math.round(x)}, ${Math.round(y)});
  `;
}

function clickJxa(x, y) {
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', moveAndClickScript(x, y)], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

async function clickAllowDialogs() {
  const access = await hasAccessibility();
  if (!access) {
    return {
      clicked: 0,
      needAccessibility: true,
      detail: 'Grant Accessibility once to the app that launched Kyte (Cursor or Terminal). After that Kyte can click Allow by itself.',
    };
  }

  const scan = await runApple(SCAN_SCRIPT);
  if (!scan.ok) {
    return { clicked: 0, needAccessibility: true, detail: scan.err.slice(0, 240) };
  }

  const SYSTEM_PROCS = /usernotificationcenter|securityagent|coreservicesuiagent|tcc|notificationcenter/i;
  const targets = parseScan(scan.out).filter((row) => {
    const btn = row.button.toLowerCase();
    if (!ALLOW_NAMES.includes(btn)) return false;
    return (
      looksLikePermissionWindow(row.title) ||
      SYSTEM_PROCS.test(row.process) ||
      (btn.startsWith('allow') && looksLikePermissionWindow(row.title + ' ' + row.process))
    );
  });

  const clicked = [];
  for (const row of targets) {
    const cx = row.x + row.w / 2;
    const cy = row.y + row.h / 2;
    const moved = await clickJxa(cx, cy);
    if (!moved) {
      await runApple(`
        tell application "System Events"
          try
            click button "${row.button.replace(/"/g, '\\"')}" of window 1 of process "${row.process.replace(/"/g, '\\"')}"
          end try
        end tell
      `);
    }
    clicked.push(`${row.button} on “${row.title || row.process}”`);
    await new Promise((r) => setTimeout(r, 250));
  }

  return { clicked: clicked.length, dialogs: clicked };
}

let watching = false;
function startPermissionWatch(emit) {
  if (watching) return;
  watching = true;
  let warned = false;
  setInterval(async () => {
    try {
      const result = await clickAllowDialogs();
      if (result.needAccessibility && !warned) {
        warned = true;
        await openAccessibilitySettings();
        emit?.({
          type: 'status',
          state: 'idle',
          note: 'One-time setup: in the System Settings window I just opened, add Cursor (or Terminal) under Accessibility. After that I can click Allow for you.',
        });
      } else if (result.clicked) {
        emit?.({ type: 'status', state: 'thinking', note: `Approved system dialog: ${result.dialogs.join(', ')}` });
      }
    } catch {
      /* keep watching */
    }
  }, 2000);
}

module.exports = { clickAllowDialogs, hasAccessibility, openAccessibilitySettings, startPermissionWatch };
