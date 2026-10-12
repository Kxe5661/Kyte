// Splits work between the model on this Mac (Ollama) and Gemini.
// Everyday jobs stay local. Checkout, forms, and a stuck local step go to Google.

const { TOOL_DECLARATIONS } = require('./tools');

const TOOL_NAMES = new Set(TOOL_DECLARATIONS.map((t) => t.name));

function envRoute() {
  const raw = String(process.env.LLM_ROUTE || 'balance').trim().toLowerCase();
  if (raw === 'local' || raw === 'google' || raw === 'balance') return raw;
  return 'balance';
}

function ollamaBase() {
  return String(process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

function lmBase() {
  return String(process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234').replace(/\/$/, '');
}

function ollamaModel() {
  return String(process.env.OLLAMA_MODEL || 'qwen3.5:27b').trim();
}

function contextWindow() {
  const name = ollamaModel();
  if (/27b|32b|35b|70b|122b/.test(name)) return 16384;
  return 32768;
}

let probe = { at: 0, ok: false, kind: '', model: '', ctx: 8192 };

function pickLmModel(models) {
  const chat = (models || []).filter((m) => m && m.type !== 'embeddings' && m.id);
  const want = String(process.env.LMSTUDIO_MODEL || 'google/gemma-4-e4b').trim();
  return chat.find((m) => m.id === want)
    || chat.find((m) => m.state === 'loaded')
    || chat[0]
    || null;
}

async function refreshProbe() {
  if (Date.now() - probe.at < 20_000) return probe.ok;
  probe.at = Date.now();
  try {
    const res = await fetch(lmBase() + '/api/v0/models', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json();
      const hit = pickLmModel(data.data);
      if (hit) {
        probe = {
          at: Date.now(),
          ok: true,
          kind: 'lmstudio',
          model: hit.id,
          ctx: Number(hit.loaded_context_length || hit.max_context_length || 8192),
        };
        return true;
      }
    }
  } catch {
    /* LM Studio is not the local brain right now */
  }
  try {
    const res = await fetch(ollamaBase() + '/api/tags', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) {
      probe.ok = false;
      probe.kind = '';
      return false;
    }
    const data = await res.json();
    const want = ollamaModel();
    const names = (data.models || []).map((m) => String(m.name || ''));
    const ok = names.some((n) => n === want || n.split(':')[0] === want.split(':')[0]);
    probe = { at: Date.now(), ok, kind: ok ? 'ollama' : '', model: want, ctx: contextWindow() };
    return ok;
  } catch {
    probe.ok = false;
    probe.kind = '';
    return false;
  }
}

async function localAvailable() {
  if (envRoute() === 'google') return false;
  return refreshProbe();
}

function localModelName() {
  return probe.model || process.env.LMSTUDIO_MODEL || 'google/gemma-4-e4b';
}

const HARD_JOB = /\b(buy|buying|order|checkout|check out|purchase|configur|add to (bag|cart)|reserve|fill(?:ing)? (?:out |in )?(?:the |a |this )?form|sign in|log in|submit|applecare)\b/i;

function preferGoogle(userText) {
  if (envRoute() === 'local') return false;
  if (envRoute() === 'google') return true;
  return HARD_JOB.test(String(userText || ''));
}

function lowerSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = Array.isArray(schema) ? [] : {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') out.type = value.toLowerCase();
    else if (value && typeof value === 'object') out[key] = lowerSchema(value);
    else out[key] = value;
  }
  return out;
}

function ollamaTools() {
  return TOOL_DECLARATIONS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: lowerSchema(tool.parameters),
    },
  }));
}

function partsText(parts) {
  return (parts || [])
    .filter((p) => p && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

function historyToMessages(history, style) {
  const openai = style === 'openai';
  const messages = [];
  const recent = Array.isArray(history) ? history.slice(-10) : [];
  recent.forEach((turn, turnIndex) => {
    if (!turn || !Array.isArray(turn.parts)) return;
    if (turn.role === 'user') {
      const responses = turn.parts.filter((p) => p && p.functionResponse);
      const images = turn.parts
        .filter((p) => p && p.inlineData && p.inlineData.data)
        .map((p) => String(p.inlineData.data))
        .slice(0, 1);
      const text = partsText(turn.parts).slice(0, 6000);
      if (text || images.length) {
        if (openai && images.length) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: text || 'Look at the attached image.' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + images[0] } },
            ],
          });
        } else {
          const msg = { role: 'user', content: text || 'Look at the attached image.' };
          if (images.length) msg.images = images;
          messages.push(msg);
        }
      }
      const assistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls);
      responses.forEach((p, i) => {
        let body = '{}';
        try { body = JSON.stringify(p.functionResponse.response || {}).slice(0, 4000); } catch { body = '{}'; }
        const id = assistant && assistant.tool_calls[i] ? assistant.tool_calls[i].id : `call_${turnIndex}_${i}`;
        messages.push(openai
          ? { role: 'tool', tool_call_id: id, content: body }
          : { role: 'tool', tool_name: String(p.functionResponse.name || ''), content: body });
      });
      return;
    }
    const text = partsText(turn.parts).slice(0, 4000);
    const calls = turn.parts.filter((p) => p && p.functionCall && p.functionCall.name);
    const msg = { role: 'assistant', content: text || null };
    if (calls.length) {
      msg.tool_calls = calls.map((p, i) => {
        const args = p.functionCall.args && typeof p.functionCall.args === 'object' ? p.functionCall.args : {};
        const fn = { name: String(p.functionCall.name), arguments: openai ? JSON.stringify(args) : args };
        return openai
          ? { id: `call_${turnIndex}_${i}`, type: 'function', function: fn }
          : { id: `call_${turnIndex}_${i}`, function: { index: i, ...fn } };
      });
    }
    if (msg.content || msg.tool_calls) messages.push(msg);
  });
  return messages;
}

function contentFromMessage(message) {
  const parts = [];
  const text = String(message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (text) parts.push({ text });
  for (const call of message?.tool_calls || []) {
    const fn = call && call.function ? call.function : {};
    let args = fn.arguments && typeof fn.arguments === 'object' ? fn.arguments : {};
    if (typeof fn.arguments === 'string') {
      try { args = JSON.parse(fn.arguments); } catch { args = {}; }
    }
    const name = String(fn.name || '').trim();
    if (!name) continue;
    parts.push({ functionCall: { name, args } });
  }
  return { role: 'model', parts };
}

function localUsable(content) {
  const parts = content && content.parts ? content.parts : [];
  if (!parts.length) return false;
  const calls = parts.filter((p) => p && p.functionCall);
  if (calls.some((p) => !TOOL_NAMES.has(p.functionCall.name))) return false;
  return true;
}

async function postLocal(messages, tools, timeoutMs) {
  await localAvailable();
  const controller = AbortSignal.timeout(timeoutMs);
  if (probe.kind === 'lmstudio') {
    const systemCap = probe.ctx && probe.ctx <= 8192 ? 6000 : 12000;
    if (messages[0] && messages[0].role === 'system') {
      messages[0] = { role: 'system', content: String(messages[0].content || '').slice(0, systemCap) };
    }
    return fetch(lmBase() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: probe.model,
        messages,
        tools: tools || undefined,
        tool_choice: tools ? 'auto' : undefined,
        temperature: 0.2,
        max_tokens: 700,
        stream: false,
      }),
      signal: controller,
    });
  }
  return fetch(ollamaBase() + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: probe.model || ollamaModel(),
      stream: false,
      think: false,
      messages,
      tools: tools || undefined,
      options: { temperature: 0.2, num_predict: 700, num_ctx: contextWindow() },
    }),
    signal: controller,
  });
}

function messageFromResponse(data) {
  if (data && data.choices && data.choices[0] && data.choices[0].message) return data.choices[0].message;
  return data && data.message ? data.message : null;
}

async function callLocal(history, systemText) {
  await localAvailable();
  if (!probe.ok) throw new Error('The model on this Mac is not running');
  const style = probe.kind === 'lmstudio' ? 'openai' : 'ollama';
  const messages = [
    { role: 'system', content: String(systemText || '').slice(0, 14_000) },
    ...historyToMessages(history, style),
  ];
  let res;
  try {
    res = await postLocal(messages, ollamaTools(), 90_000);
  } catch (err) {
    probe = { at: Date.now(), ok: false, kind: '', model: '', ctx: 8192 };
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('The model on this Mac took too long');
    }
    throw new Error('The model on this Mac is not running');
  }
  const raw = await res.text();
  if (!res.ok) {
    probe = { at: Date.now(), ok: false, kind: '', model: '', ctx: 8192 };
    throw new Error(`Local model error ${res.status}: ${raw.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('Local model returned a response that could not be read'); }
  const content = contentFromMessage(messageFromResponse(data));
  if (!localUsable(content)) throw new Error('Local model did not return a usable step');
  return content;
}

function xaiKey() {
  return String(process.env.XAI_API_KEY || '').trim();
}

function xaiModel() {
  return String(process.env.XAI_MODEL || 'grok-4.7').trim();
}

function scrubSecret(text) {
  const key = xaiKey();
  const raw = String(text || '');
  return key ? raw.split(key).join('••••') : raw;
}

async function postGrok(messages, tools, timeoutMs) {
  const key = xaiKey();
  if (!key) throw new Error('No xAI key is set');
  const body = {
    model: xaiModel(),
    messages,
    temperature: 0.2,
    reasoning_effort: 'low',
    stream: false,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const send = async (payload) => fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let res = await send(body);
  if (!res.ok) {
    const preview = await res.text();
    if (/reasoning_effort/i.test(preview)) {
      delete body.reasoning_effort;
      res = await send(body);
    } else {
      const err = new Error(`Grok error ${res.status}: ${scrubSecret(preview).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
  }
  if (!res.ok) {
    const preview = await res.text();
    const err = new Error(`Grok error ${res.status}: ${scrubSecret(preview).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function callGrok(history, systemText) {
  const messages = [
    { role: 'system', content: String(systemText || '').slice(0, 24_000) },
    ...historyToMessages(history, 'openai'),
  ];
  let res;
  try {
    res = await postGrok(messages, ollamaTools(), 120_000);
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('Grok took too long');
    }
    throw err;
  }
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('Grok returned a response that could not be read'); }
  const content = contentFromMessage(messageFromResponse(data));
  if (!localUsable(content)) throw new Error('Grok did not return a usable step');
  return content;
}

async function completeGrok(prompt) {
  const res = await postGrok(
    [{ role: 'user', content: String(prompt || '').slice(0, 6000) }],
    null,
    30_000,
  );
  const data = await res.json();
  const message = messageFromResponse(data);
  return String(message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function completeLocal(prompt) {
  await localAvailable();
  if (!probe.ok) throw new Error('local complete failed');
  const res = await postLocal(
    [{ role: 'user', content: String(prompt || '').slice(0, 6000) }],
    null,
    20_000,
  );
  if (!res.ok) throw new Error('local complete failed');
  const data = await res.json();
  const message = messageFromResponse(data);
  return String(message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

module.exports = {
  localAvailable,
  preferGoogle,
  callLocal,
  completeLocal,
  localUsable,
  ollamaModel,
  localModelName,
  callGrok,
  completeGrok,
  xaiModel,
  envRoute,
};
