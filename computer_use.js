// See the screen, then move the mouse to what is actually there.
// Uses Gemini vision + cliclick. Completes forms and clicks Allow itself.

const mouse = require('./mouse');
const { clickVisiblePrimary, lookForCall } = require('./find_primary');

const MAX_STEPS = 12;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function askVision(apiKey, model, goal, shot, historyText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = [
    `You are driving a Mac desktop. The user is not at the computer.`,
    `Goal: ${goal}`,
    `Coordinates are a 0-999 grid over THIS screenshot (x from left, y from top). Click the visual CENTER of the control, not the label beside it.`,
    `Finish the task. If you see Call, FaceTime, Submit, Send, Allow, Continue, OK, Next, Add to Bag, Check Out, or Save — click that primary button. Never stop on a preview.`,
    `If the next control is not in the screenshot, scroll down (fast flick) and look again. Do not wait or stare.`,
    `Especially: FaceTime "Click to call" / green camera = CLICK IT. Do not click Cancel or the X.`,
    `The mouse glides like a person. One click per control. If the last click missed, aim again at the center of the same button.`,
    `Fill forms from the goal / remembered details. Do not ask the user to click anything.`,
    `Do not click destructive things (Erase, Delete All) unless the goal says so.`,
    `You are NOT done if a Call/Submit/Allow/Send button is still visible.`,
    historyText ? `Recent steps:\n${historyText}` : '',
    `Return ONLY JSON, no markdown:`,
    `{"done":false,"summary":"","actions":[{"type":"click","x":120,"y":400,"intent":"why"}]}`,
    `Action types: click, double_click, right_click, drag, type, hotkey, press_key, wait, scroll`,
    `type needs "text". hotkey needs "keys":["cmd","f"]. press_key needs "key". scroll needs "direction":"down". wait needs "seconds". drag needs x,y plus "x2","y2".`,
    `When the goal is finished: {"done":true,"summary":"what you did","actions":[]}`,
  ].filter(Boolean).join('\n');

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'image/jpeg', data: shot.buf.toString('base64') } },
        ],
      },
    ],
    generationConfig: { temperature: 0.2 },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data).slice(0, 400));
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n');
  const json = text.replace(/^```json\s*|```$/g, '').trim();
  const start = json.indexOf('{');
  const end = json.lastIndexOf('}');
  return JSON.parse(json.slice(start, end + 1));
}

async function runAction(action, shot) {
  const type = String(action.type || '').toLowerCase();
  const x = action.x != null ? Math.round(mouse.fromGrid(action.x, shot.pts.w)) : null;
  const y = action.y != null ? Math.round(mouse.fromGrid(action.y, shot.pts.h)) : null;
  if (type === 'click' && x != null) return mouse.click(x, y);
  if (type === 'double_click' && x != null) return mouse.click(x, y, 2);
  if (type === 'right_click' && x != null) return mouse.rightClick(x, y);
  if (type === 'drag' && x != null && action.x2 != null) {
    return mouse.drag(x, y, Math.round(mouse.fromGrid(action.x2, shot.pts.w)), Math.round(mouse.fromGrid(action.y2, shot.pts.h)));
  }
  if (type === 'move' && x != null) return mouse.move(x, y);
  if (type === 'type') return mouse.typeText(action.text || '');
  if (type === 'press_key') return mouse.key(action.key || 'enter');
  if (type === 'hotkey') return mouse.hotkey(action.keys || action.key || []);
  if (type === 'scroll') return scrollOnScreen(action.direction || 'down');
  if (type === 'wait') return sleep(Math.min((action.seconds || 0.2) * 1000, 400));
  return { ok: false, err: `unknown action ${type}` };
}

async function scrollOnScreen(direction) {
  try {
    const safari = require('./safari');
    const js = await safari.scrollPage(direction || 'down');
    if (js.ok && js.via === 'safari_js') return js;
  } catch {
    /* Safari JS scroll unavailable */
  }
  return mouse.scroll(direction || 'down', { flicks: 3, lines: 18 });
}

async function useComputer(goal, config, emit) {
  const model = config.model || 'gemini-3.8-flash';
  const log = [];
  const g = String(goal || '').toLowerCase();
  const wantsPrimary = /call|facetime|submit|send|form|allow|continue|ok|save|next|add to bag|check out|checkout/.test(g);
  const wantsWebCta = /safari|submit|continue|next|add to bag|check out|checkout|check availability|sign in/.test(g);
  if (wantsWebCta && !/call|facetime/.test(g)) {
    try {
      const safari = require('./safari');
      const quick = await safari.clickAndFinish('', { vision: false });
      if (quick.ok && quick.via !== 'use_computer') {
        const note = `clicked ${quick.clicked || 'primary'} via ${quick.via}`;
        emit?.({ type: 'computer', step: 1, done: true, summary: note, actions: [{ type: 'click', intent: note }] });
        return { ok: true, summary: note, steps: 1, log: [note] };
      }
    } catch {
      /* DOM click unavailable — fall through to pixels / vision */
    }
  }
  for (let i = 0; i < MAX_STEPS; i++) {
    if (wantsPrimary) {
      const auto = await clickVisiblePrimary(goal);
      if (auto.already === 'ringing') {
        return { ok: true, summary: 'Call is already ringing.', steps: i + 1, log };
      }
      if (auto.ok && auto.clicked) {
        const note = `clicked ${auto.clicked.label || 'primary'} at ${auto.clicked.x},${auto.clicked.y}`;
        log.push(note);
        emit?.({ type: 'computer', step: i + 1, done: false, summary: note, actions: [{ type: 'click', ...auto.clicked }] });
        await sleep(600);
        if (/call|facetime/.test(String(goal || '').toLowerCase())) {
          const check = await lookForCall();
          if (check.ringing || !check.call) {
            return { ok: true, summary: 'Clicked the green Call button.', steps: i + 1, log };
          }
        } else {
          return { ok: true, summary: note, steps: i + 1, log };
        }
        continue;
      }
    }
    const shot = await mouse.screenshotForVision();
    let plan;
    try {
      plan = await askVision(config.apiKey, model, goal, shot, log.slice(-8).join('\n'));
    } catch (e) {
      return { ok: false, error: String(e.message), log };
    }
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    emit?.({ type: 'computer', step: i + 1, done: !!plan.done, summary: plan.summary, actions });
    if (plan.done && !actions.length) {
      return { ok: true, summary: plan.summary || 'Done.', steps: i + 1, log };
    }
    for (const action of actions.slice(0, 4)) {
      await runAction(action, shot);
      log.push(`${action.type} ${action.intent || action.text || ''}`.trim());
      await sleep(action.type === 'scroll' ? 80 : 160);
    }
    if (plan.done) return { ok: true, summary: plan.summary || 'Done.', steps: i + 1, log };
    await sleep(180);
  }
  return { ok: false, error: `Stopped after ${MAX_STEPS} screen steps.`, log };
}

async function clickPrimaryAction(config, emit) {
  return useComputer(
    'Click the primary action on screen now: Call, FaceTime (green camera), Submit, Send, Allow, Continue, or OK. Do not click Cancel. If already ringing or submitted, stop.',
    config,
    emit
  );
}

module.exports = { useComputer, clickPrimaryAction };
