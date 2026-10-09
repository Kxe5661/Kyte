// Drive Mac apps the way a person would: open, search, click.

const { execFile } = require('child_process');

function runApple(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(err ? err.message || stderr : '') });
    });
  });
}

function runJxa(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(err ? err.message || stderr : '') });
    });
  });
}

function appleQuote(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function activateApp(name) {
  return runApple(`
    tell application "${appleQuote(name)}" to activate
    delay 0.6
    tell application "System Events"
      tell process "${appleQuote(name)}"
        set frontmost to true
        try
          set w to missing value
          set best to 0
          repeat with cand in windows
            set s to size of cand
            set area to (item 1 of s) * (item 2 of s)
            if area > best then
              set best to area
              set w to cand
            end if
          end repeat
          if w is not missing value then
            set position of w to {70, 70}
            if best < 400000 then set size of w to {1100, 720}
          end if
        end try
      end tell
    end tell
  `);
}

async function typeSearch(app, query) {
  const q = appleQuote(query);
  return runApple(`
    tell application "System Events"
      tell process "${appleQuote(app)}"
        set frontmost to true
      end tell
      delay 0.2
      keystroke "f" using command down
      delay 0.25
      keystroke "a" using command down
      delay 0.1
      keystroke "${q}"
      delay 0.9
      key code 36
      delay 0.5
    end tell
  `);
}

async function clickLargestWindow(app, relX, relY) {
  const script = `
    var se = Application("System Events");
    var proc = se.processes.byName(${JSON.stringify(app)});
    proc.frontmost = true;
    var wins = proc.windows();
    var best = null, bestArea = 0;
    for (var i = 0; i < wins.length; i++) {
      var s = wins[i].size();
      var area = s[0] * s[1];
      if (area > bestArea) { bestArea = area; best = wins[i]; }
    }
    if (!best) throw new Error("no window");
    var p = best.position();
    var s = best.size();
    var x = p[0] + s[0] * ${Number(relX)};
    var y = p[1] + s[1] * ${Number(relY)};
    JSON.stringify({ x: x, y: y, pos: p, size: s });
  `;
  const loc = await runJxa(script);
  if (!loc.ok) return loc;
  let pt;
  try {
    pt = JSON.parse(loc.out);
  } catch {
    return loc;
  }
  const mouse = require('./mouse');
  await mouse.move(pt.x, pt.y);
  await new Promise((r) => setTimeout(r, 120));
  const clicked = await mouse.click(pt.x, pt.y);
  return { ok: clicked.ok !== false, out: loc.out, err: clicked.err || '', click: clicked };
}

async function callViaContacts(name, audio = false) {
  const steps = [];
  steps.push({ open: await activateApp('Contacts') });
  steps.push({ search: await typeSearch('Contacts', name) });
  // Header action pills, then the FaceTime row camera on the right of the card.
  const targets = audio
    ? [[0.7, 0.28], [0.66, 0.28]]
    : [[0.76, 0.28], [0.91, 0.52], [0.91, 0.58]];
  for (const [x, y] of targets) {
    const click = await clickLargestWindow('Contacts', x, y);
    steps.push({ click: { x, y, ...click } });
    await new Promise((r) => setTimeout(r, 350));
  }
  return { ok: true, via: 'Contacts UI', name, mode: audio ? 'audio' : 'video', steps };
}

async function clickFaceTimeCallButton() {
  const { finishCall } = require('./find_primary');
  return finishCall();
}

module.exports = { activateApp, typeSearch, clickLargestWindow, callViaContacts, clickFaceTimeCallButton };
