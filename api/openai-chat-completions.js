/**
 * 中文註解：OpenAI Chat Completions（備援／或 OPENAI_FIRST 時主力）；無第三方套件，Vercel fetch。
 */
'use strict';

/** 中文註解：限制輸出長度，避免異常大值 */
function clampOpenAiMaxTokens(raw, fallback, cap) {
  const n = parseInt(String(raw ?? fallback), 10);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.min(cap, Math.max(128, v));
}

/**
 * @param {string} apiKey
 * @param {{ system: string, messages: Array<{role:string,content:string}>, model?: string, temperature?: number, maxTokens?: number }} opts
 * @returns {Promise<{ ok: true, reply: string, model: string, finishReason?: string } | { ok: false, detail: string, httpStatus?: number }>}
 */
async function generateOpenAiChatCompletion(apiKey, opts) {
  const system = String(opts.system || '').trim();
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const model = (opts.model || 'gpt-4o-mini').trim();
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.8;
  const maxTokens = clampOpenAiMaxTokens(opts.maxTokens, 2048, 4096);

  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: system || '你是助手。' }, ...messages],
  };

  let resp;
  try {
    const fetchOpts = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    };
    // 中文註解：Node 18+／Vercel 支援 AbortSignal.timeout
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      fetchOpts.signal = AbortSignal.timeout(55000);
    }
    resp = await fetch('https://api.openai.com/v1/chat/completions', fetchOpts);
  } catch (err) {
    return { ok: false, detail: String(err && err.message ? err.message : err) };
  }

  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, detail: text.slice(0, 2000), httpStatus: resp.status };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, detail: text.slice(0, 1200) };
  }

  const reply = String(data.choices?.[0]?.message?.content || '').trim();
  if (!reply) {
    return { ok: false, detail: `EMPTY_REPLY:${text.slice(0, 800)}` };
  }

  return {
    ok: true,
    reply,
    model: typeof data.model === 'string' ? data.model : model,
    finishReason: data.choices?.[0]?.finish_reason || '',
  };
}

module.exports = { generateOpenAiChatCompletion, clampOpenAiMaxTokens };
