// Find the button that actually finishes the job (Call, Submit, Allow)
// by looking at pixels — not guessing window offsets.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mouse = require('./mouse');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sh(cmd, args, timeout = 12000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(err ? err.message || stderr : ''),
      });
    });
  });
}

function parseBmp(buf) {
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error('not a bmp');
  const off = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  const rawH = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const topDown = rawH < 0;
  const h = Math.abs(rawH);
  const stride = Math.floor((bpp * w + 31) / 32) * 4;
  const bytes = Math.max(1, Math.floor(bpp / 8));
  return {
    w,
    h,
    get(x, y) {
      const by = topDown ? y : h - 1 - y;
      const i = off + by * stride + x * bytes;
      return { r: buf[i + 2], g: buf[i + 1], b: buf[i] };
    },
  };
}

function isCallGreen(r, g, b) {
  return g >= 90 && g >= r + 25 && g >= b + 15 && r < 160 && b < 150;
}

function isHangupRed(r, g, b) {
  return r >= 160 && r >= g + 40 && r >= b + 40 && g < 120 && b < 120;
}

function isPrimaryBlue(r, g, b) {
  return b >= 140 && b >= r + 30 && b >= g + 10 && r < 140;
}

function clusters(img, pred, step = 2, cell = 16) {
  const buckets = new Map();
  for (let y = 0; y < img.h; y += step) {
    for (let x = 0; x < img.w; x += step) {
      const p = img.get(x, y);
      if (!pred(p.r, p.g, p.b)) continue;
      const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push({ x, y });
    }
  }
  const keys = [...buckets.keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k) => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)));
      k = parent.get(k);
    }
    return k;
  };
  for (const k of keys) {
    const [cx, cy] = k.split(',').map(Number);
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [1, 1],
      [-1, 1],
    ]) {
      const n = `${cx + dx},${cy + dy}`;
      if (buckets.has(n)) {
        const a = find(k);
        const b = find(n);
        if (a !== b) parent.set(b, a);
      }
    }
  }
  const groups = new Map();
  for (const k of keys) {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(...buckets.get(k));
  }
  return [...groups.values()].map((pts) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = 0;
    let maxY = 0;
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      sx += p.x;
      sy += p.y;
    }
    return {
      x: sx / pts.length,
      y: sy / pts.length,
      minX,
      minY,
      maxX,
      maxY,
      w: maxX - minX,
      h: maxY - minY,
      count: pts.length,
    };
  });
}

function buttonLike(c, img) {
  const min = Math.max(14, Math.round(Math.min(img.w, img.h) * 0.015));
  const max = Math.max(90, Math.round(Math.min(img.w, img.h) * 0.12));
  if (c.w < min || c.h < min || c.w > max || c.h > max) return false;
  const ratio = c.w / Math.max(1, c.h);
  return ratio > 0.55 && ratio < 1.8;
}

function pickCall(img) {
  const greens = clusters(img, isCallGreen).filter((c) => buttonLike(c, img));
  if (!greens.length) return null;
  // FaceTime Call sits bottom-left of the preview, often next to gray Cancel.
  greens.sort((a, b) => b.y - a.y || a.x - b.x);
  const lower = greens.filter((c) => c.y > img.h * 0.35 && c.x < img.w * 0.55);
  return lower[0] || greens[0];
}

function pickRed(img) {
  const reds = clusters(img, isHangupRed).filter((c) => buttonLike(c, img));
  return reds.sort((a, b) => b.count - a.count)[0] || null;
}

function pickBlue(img) {
  const blues = clusters(img, isPrimaryBlue).filter((c) => buttonLike(c, img));
  blues.sort((a, b) => b.y - a.y || b.x - a.x);
  return blues[0] || null;
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

async function windowRect(appName) {
  const r = await sh('osascript', [
    '-l',
    'JavaScript',
    '-e',
    `
      ObjC.import("CoreGraphics");
      var list = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1, 0)) || [];
      var name = ${JSON.stringify(appName)};
      var best = null, bestA = 0;
      for (var i = 0; i < list.length; i++) {
        var w = list[i];
        if (String(w.kCGWindowOwnerName || "") !== name) continue;
        var b = w.kCGWindowBounds;
        if (!b) continue;
        var area = (b.Width || 0) * (b.Height || 0);
        if (area > bestA && b.Width > 120 && b.Height > 80) {
          bestA = area;
          best = { x: b.X, y: b.Y, w: b.Width, h: b.Height };
        }
      }
      JSON.stringify(best);
    `,
  ]);
  try {
    const v = JSON.parse(r.out);
    if (v && v.w) return v;
  } catch {
    /* fall through */
  }
  const apple = await sh('osascript', [
    '-e',
    `
      tell application "System Events"
        if not (exists process ${JSON.stringify(appName)}) then return ""
        tell process ${JSON.stringify(appName)}
          set bestArea to 0
          set out to ""
          repeat with w in windows
            set s to size of w
            set area to (item 1 of s) * (item 2 of s)
            if area > bestArea then
              set bestArea to area
              set p to position of w
              set out to (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
            end if
          end repeat
          return out
        end tell
      end tell
    `,
  ]);
  const m = /^(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(apple.out || '');
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
}

async function captureBmp(rect) {
  const dir = os.tmpdir();
  const png = path.join(dir, 'kyte-primary.png');
  const bmp = path.join(dir, 'kyte-primary.bmp');
  const args = ['-x', '-t', 'png'];
  if (rect) args.push('-R', `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`);
  else args.push('-m');
  args.push(png);
  const cap = await sh('screencapture', args);
  if (!cap.ok) throw new Error(cap.err || 'screencapture failed');
  const conv = await sh('sips', ['-s', 'format', 'bmp', png, '--out', bmp]);
  if (!conv.ok) throw new Error(conv.err || 'sips failed');
  return parseBmp(fs.readFileSync(bmp));
}

function toScreen(hit, img, origin, screen) {
  if (!hit) return null;
  if (origin) {
    return {
      x: Math.round(origin.x + (hit.x / img.w) * origin.w),
      y: Math.round(origin.y + (hit.y / img.h) * origin.h),
      px: hit,
    };
  }
  return {
    x: Math.round((hit.x / img.w) * screen.w),
    y: Math.round((hit.y / img.h) * screen.h),
    px: hit,
  };
}

async function axButtons(appName) {
  const r = await sh('osascript', [
    '-l',
    'JavaScript',
    '-e',
    `
      var se = Application("System Events");
      if (!se.processes.byName(${JSON.stringify(appName)}).exists()) {
        JSON.stringify([]);
      } else {
        var proc = se.processes.byName(${JSON.stringify(appName)});
        var out = [];
        function walk(el, depth) {
          if (depth > 7 || out.length > 40) return;
          try {
            var role = "";
            try { role = el.role(); } catch (e) {}
            var nm = "";
            try { nm = String(el.name() || ""); } catch (e) {}
            var desc = "";
            try { desc = String(el.description() || ""); } catch (e) {}
            if (role === "AXButton" || /call|submit|send|allow|continue|ok|facetime/i.test(nm + " " + desc)) {
              var p = el.position();
              var s = el.size();
              out.push({ name: nm, desc: desc, role: role, x: p[0], y: p[1], w: s[0], h: s[1] });
            }
            var kids = [];
            try { kids = el.uiElements(); } catch (e) {}
            for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
          } catch (e) {}
        }
        var wins = proc.windows();
        for (var i = 0; i < wins.length; i++) walk(wins[i], 0);
        JSON.stringify(out);
      }
    `,
  ]);
  try {
    return JSON.parse(r.out || '[]');
  } catch {
    return [];
  }
}

const PRIMARY_LABEL = /^(call|facetime|submit|send|allow|allow once|continue|ok|next|save|done)$/i;

function axPrimary(buttons, want) {
  const wantRe = want === 'call' ? /^(call|facetime)$/i : PRIMARY_LABEL;
  const hits = buttons.filter((b) => wantRe.test(String(b.name || '').trim()) || wantRe.test(String(b.desc || '').trim()));
  if (!hits.length) return null;
  const b = hits[0];
  return { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2), via: 'ax', label: b.name || b.desc };
}

async function lookForCall() {
  const screen = await displayPoints();
  let origin = await windowRect('FaceTime');
  let img;
  try {
    img = await captureBmp(origin);
  } catch {
    origin = null;
    img = await captureBmp(null);
  }
  let green = pickCall(img);
  if (!green && origin) {
    origin = null;
    img = await captureBmp(null);
    green = pickCall(img);
  }
  const red = pickRed(img);
  let ax = null;
  if (!green) ax = axPrimary(await axButtons('FaceTime'), 'call');
  return {
    screen,
    origin,
    img: { w: img.w, h: img.h },
    call: green ? { ...toScreen(green, img, origin, screen), via: 'pixels', label: 'Call' } : ax,
    ax,
    ringing: !!red,
  };
}

async function visibleClick(x, y) {
  return mouse.click(x, y);
}

async function clickCallButton() {
  await sh('osascript', ['-e', 'tell application "FaceTime" to activate']);
  await sleep(250);
  const found = await lookForCall();
  if (found.ringing) return { ok: true, already: 'ringing', ...found };
  const target = found.call || found.ax;
  if (!target) return { ok: false, error: 'Call button not on screen yet', ...found };
  const clicked = await visibleClick(target.x, target.y);
  return { ok: clicked.ok !== false, clicked: target, mouse: clicked, ...found };
}

async function finishCall(timeoutMs = 7000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await clickCallButton();
    if (last.already === 'ringing') return { ok: true, summary: 'Already ringing.', last };
    if (last.ok && last.clicked) {
      await sleep(700);
      const check = await lookForCall();
      if (check.ringing || !check.call) {
        return { ok: true, summary: 'Clicked the green Call button.', last, check };
      }
      await visibleClick(last.clicked.x, last.clicked.y);
      await sleep(400);
      const again = await lookForCall();
      if (again.ringing || !again.call) {
        return { ok: true, summary: 'Clicked Call on the second try.', last, check: again };
      }
    }
    await sleep(450);
  }
  return { ok: false, error: 'Saw the FaceTime preview but could not land on Call.', last };
}

function findInImageFile(filePath) {
  const bmp = path.join(os.tmpdir(), 'kyte-primary-file.bmp');
  return new Promise((resolve, reject) => {
    execFile('sips', ['-s', 'format', 'bmp', filePath, '--out', bmp], (err) => {
      if (err) return reject(err);
      const img = parseBmp(fs.readFileSync(bmp));
      const call = pickCall(img);
      resolve({
        image: { w: img.w, h: img.h },
        call: call ? { x: Math.round(call.x), y: Math.round(call.y), w: call.w, h: call.h } : null,
      });
    });
  });
}

async function clickVisiblePrimary(goal) {
  const g = String(goal || '').toLowerCase();
  const wantsCall = /call|facetime|phone|ring/.test(g);
  const wantsSubmit = /submit|send|form|continue|next|save|sign in|login/.test(g);
  const wantsAllow = /allow|permission|ok dialog/.test(g);
  if (wantsCall || (!wantsSubmit && !wantsAllow && /call|facetime/.test(g))) {
    return clickCallButton();
  }
  if (wantsAllow) {
    const { clickAllowDialogs } = require('./permissions');
    return clickAllowDialogs();
  }
  if (wantsSubmit) {
    try {
      const safari = require('./safari');
      const js = await safari.clickAndFinish('', { vision: false });
      if (js.ok && js.via !== 'use_computer') {
        return { ok: true, clicked: { label: js.clicked || 'Submit', via: js.via, x: js.point?.x, y: js.point?.y } };
      }
    } catch {
      /* DOM click unavailable */
    }
    const screen = await displayPoints();
    const img = await captureBmp(null);
    const blue = pickBlue(img);
    if (!blue) return { ok: false, error: 'no primary submit button' };
    const pt = toScreen(blue, img, null, screen);
    const clicked = await visibleClick(pt.x, pt.y);
    return { ok: clicked.ok !== false, clicked: { ...pt, label: 'Submit' } };
  }
  const call = await lookForCall();
  if (call.call) {
    const clicked = await visibleClick(call.call.x, call.call.y);
    return { ok: clicked.ok !== false, clicked: call.call };
  }
  return { ok: false, skipped: true };
}

module.exports = {
  lookForCall,
  clickCallButton,
  finishCall,
  findInImageFile,
  clickVisiblePrimary,
};
