// Kyte's brain: the agent loop that talks to the Gemini API,
// decides on tool calls, and executes them (with approval for risky ones).

const os = require('os');
const { TOOL_DECLARATIONS, executeTool, isRisky } = require('./tools');

const MAX_STEPS = 15;

function systemPrompt() {
  return [
    `You are Kyte, a personal AI assistant that runs on the user's Mac (${os.hostname()}, macOS).`,
    `The user usually messages you from their iPhone, so keep replies short and skimmable.`,
    `Current date/time: ${new Date().toString()}.`,
    ``,
    `You control the Mac through your tools. Guidelines:`,
    `- Prefer doing the task over describing how to do it.`,
    `- Use run_shell for system info, file operations, and launching things; run_applescript for controlling apps.`,
    `- Risky tools require the user to tap Approve on their phone. Keep risky commands minimal and targeted so approval is easy to judge.`,
    `- Never run destructive commands (rm -rf, overwriting data) unless the user explicitly asked for exactly that.`,
    `- If a tool result is denied by the user, don't retry it; ask what they'd prefer.`,
    `- When a request is ambiguous or dangerous, ask before acting.`,
    `- After finishing, reply with a one or two sentence confirmation of what you did.`,
  ].join('\n');
}

async function callGemini(history, config) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt() }] },
    contents: history,
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 800)}`);
  }
  const data = await res.json();
  const content = data.candidates?.[0]?.content;
  if (!content) {
    throw new Error(`Gemini returned no candidates: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return content;
}

/**
 * Run one user turn through the agent loop.
 * @param {string} userText
 * @param {Array} history - Gemini "contents" array, mutated in place
 * @param {object} config - { apiKey, model }
 * @param {function} emit - emit(event) pushes an event to the UI
 * @param {function} requestApproval - async (toolName, args) => boolean
 */
async function runAgent(userText, history, config, emit, requestApproval) {
  if (!config.apiKey) {
    emit({
      type: 'error',
      text: 'No GEMINI_API_KEY set. Get a free key at https://aistudio.google.com/apikey and put it in .env, then restart Kyte.',
    });
    return;
  }

  history.push({ role: 'user', parts: [{ text: userText }] });

  for (let step = 0; step < MAX_STEPS; step++) {
    const content = await callGemini(history, config);
    history.push(content);

    const parts = content.parts || [];
    const text = parts.filter((p) => p.text).map((p) => p.text).join('\n').trim();
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (text) emit({ type: 'assistant', text });
    if (calls.length === 0) return; // model is done

    const responseParts = [];
    for (const call of calls) {
      const { name, args } = call;
      emit({ type: 'tool_start', name, args });

      let result;
      if (isRisky(name)) {
        const approved = await requestApproval(name, args);
        result = approved
          ? await executeTool(name, args)
          : { error: 'User denied this action. Do not retry it.' };
      } else {
        result = await executeTool(name, args);
      }

      emit({ type: 'tool_result', name, result });
      responseParts.push({ functionResponse: { name, response: result } });
    }
    history.push({ role: 'user', parts: responseParts });
  }

  emit({ type: 'error', text: `Stopped after ${MAX_STEPS} steps without finishing. Try breaking the task into smaller pieces.` });
}

module.exports = { runAgent };
