// Human-like mouse: glide with easing, hover, then press — not a teleport.

const { execFile } = require('child_process');

const CLICK = '/opt/homebrew/bin/cliclick';
const EASE = '4';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sh(cmd, args, timeout = 12000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(err ? err.message || stderr : '') });
    });
  });
}

async function displayPoints() {
  const r = await sh('osascript', [
    '-l',
    'JavaScript',
    '-e',
    'ObjC.import("AppKit"); var f=$.NSScreen.mainScreen.frame.size; JSON.stringify({w:f.width,h:f.height})',
  ]);
  try {
    return JSON.parse(r.out);
  } catch {
    return { w: 1728, h: 1117 };
  }
}

async function screenshotForVision() {
  const { captureScreen, imageSize } = require('./screen');
  const buf = await captureScreen();
  const px = await imageSize(buf);
  const pts = await displayPoints();
  return { buf, px, pts, scaleX: pts.w / (px.w || pts.w), scaleY: pts.h / (px.h || pts.h) };
}

function fromGrid(n, max) {
  return Math.round((Number(n) / 999) * max);
}

function clamp(n) {
  return Math.round(Number(n) || 0);
}

async function location() {
  const r = await sh(CLICK, ['p']);
  const m = /(\-?\d+)\s*,\s*(\-?\d+)/.exec(r.out || '');
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

async function cliclick(args) {
  return sh(CLICK, args);
}

async function cgMove(x, y) {
  return sh('osascript', [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import("Cocoa");
     var pt=$.CGPointMake(${x},${y});
     $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,0));`,
  ]);
}

async function cgClick(x, y, times) {
  return sh('osascript', [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import("Cocoa");
     var pt=$.CGPointMake(${x},${y});
     $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null,$.kCGEventMouseMoved,pt,0));
     delay(0.08);
     for (var i = 0; i < ${times >= 2 ? 2 : 1}; i++) {
       $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,pt,0));
       delay(0.05);
       $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,pt,0));
       delay(0.06);
     }`,
  ]);
}

async function move(x, y) {
  x = clamp(x);
  y = clamp(y);
  const r = await cliclick(['-e', EASE, `m:${x},${y}`]);
  if (r.ok) return { ...r, x, y };
  const fb = await cgMove(x, y);
  return { ...fb, x, y };
}

async function click(x, y, times = 1) {
  x = clamp(x);
  y = clamp(y);
  const jx = x + (Math.random() < 0.5 ? 0 : Math.random() < 0.5 ? 1 : -1);
  const jy = y + (Math.random() < 0.5 ? 0 : Math.random() < 0.5 ? 1 : -1);
  const cmds =
    times >= 2
      ? ['-e', EASE, `m:${jx},${jy}`, 'w:100', `dc:${jx},${jy}`]
      : ['-e', EASE, `m:${jx},${jy}`, 'w:90', `dd:${jx},${jy}`, 'w:55', `du:${jx},${jy}`];
  const r = await cliclick(cmds);
  if (r.ok) return { ...r, x: jx, y: jy };
  const fb = await cgClick(jx, jy, times);
  return { ...fb, x: jx, y: jy };
}

async function rightClick(x, y) {
  x = clamp(x);
  y = clamp(y);
  const r = await cliclick(['-e', EASE, `m:${x},${y}`, 'w:80', `rc:${x},${y}`]);
  if (r.ok) return { ...r, x, y };
  return click(x, y);
}

async function drag(x1, y1, x2, y2) {
  x1 = clamp(x1);
  y1 = clamp(y1);
  x2 = clamp(x2);
  y2 = clamp(y2);
  const r = await cliclick(['-e', EASE, `dd:${x1},${y1}`, 'w:40', `dm:${x2},${y2}`, 'w:40', `du:${x2},${y2}`]);
  return { ...r, x: x2, y: y2 };
}

async function typeText(text) {
  const raw = String(text || '');
  if (!raw) return { ok: true };
  const r = await cliclick([`t:${raw.replace(/"/g, '\\"')}`]);
  if (r.ok) return r;
  const q = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return sh('osascript', ['-e', `tell application "System Events" to keystroke "${q}"`]);
}

async function key(name) {
  const map = {
    enter: 'kp:return',
    return: 'kp:return',
    escape: 'kp:esc',
    tab: 'kp:tab',
    delete: 'kp:delete',
    space: 'kp:space',
    up: 'kp:arrow-up',
    down: 'kp:arrow-down',
    left: 'kp:arrow-left',
    right: 'kp:arrow-right',
  };
  const spec = map[String(name || '').toLowerCase()];
  if (spec) return cliclick([spec]);
  return sh('osascript', ['-e', `tell application "System Events" to keystroke "${String(name).replace(/"/g, '')}"`]);
}

async function hotkey(keys) {
  const list = (Array.isArray(keys) ? keys : String(keys).split('+')).map((k) => k.toLowerCase().trim());
  const mods = [];
  if (list.includes('cmd') || list.includes('command') || list.includes('meta')) mods.push('command down');
  if (list.includes('shift')) mods.push('shift down');
  if (list.includes('alt') || list.includes('option')) mods.push('option down');
  if (list.includes('ctrl') || list.includes('control')) mods.push('control down');
  const main = list.find((k) => !['cmd', 'command', 'meta', 'shift', 'alt', 'option', 'ctrl', 'control'].includes(k)) || '';
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  return sh('osascript', ['-e', `tell application "System Events" to keystroke "${main.replace(/"/g, '')}"${using}`]);
}

async function scroll(direction, { flicks = 3, lines = 18 } = {}) {
  const sign = direction === 'up' ? 1 : direction === 'down' ? -1 : 0;
  if (!sign) return { ok: false, err: 'scroll needs up or down' };
  const per = sign * Math.max(8, Number(lines) || 18);
  const n = Math.max(1, Math.min(6, Number(flicks) || 3));
  return sh('osascript', [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import("Cocoa");
     for (var i = 0; i < ${n}; i++) {
       var e = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 1, ${per});
       $.CGEventPost($.kCGHIDEventTap, e);
       if (i < ${n - 1}) delay(0.025);
     }`,
  ]);
}

module.exports = {
  screenshotForVision,
  fromGrid,
  location,
  move,
  click,
  rightClick,
  drag,
  typeText,
  key,
  hotkey,
  scroll,
  displayPoints,
  sleep,
};
