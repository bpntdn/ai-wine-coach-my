/**
 * 中文註解：共用 Gemini generateContent；依序嘗試多個模型 ID，避免舊版無後綴名稱遭 API 淘汰後整站 502。
 */
'use strict';

/** 中文註解：環境變數 GEMINI_MODEL 優先，否則嘗試官方仍常見可用的 ID（順序可隨 Google 改版調整） */
function getGeminiModelCandidates() {
  const env = (process.env.GEMINI_MODEL || '').trim();
  const fallback = [
    'gemini-2.0-flash',
    'gemini-2.5-flash-preview-05-20',
    'gemini-2.5-flash',
    'gemini-2.0-flash-001',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-002',
    'gemini-1.5-flash-8b',
    'gemini-1.5-pro',
  ];
  const out = [];
  const seen = new Set();
  if (env) {
    seen.add(env);
    out.push(env);
  }
  for (const m of fallback) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

function extractReplyText(data) {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
}

/**
 * @param {string} apiKey
 * @param {object} payload — systemInstruction、contents、generationConfig（Gemini REST JSON 頂層欄位）
 * @returns {Promise<{ ok: true, model: string, reply: string } | { ok: false, detail: string }>}
 */
async function generateGeminiContent(apiKey, payload) {
  const models = getGeminiModelCandidates();
  let lastDetail = '';

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let geminiRes;
    try {
      geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      lastDetail = String(err && err.message ? err.message : err);
      continue;
    }

    const text = await geminiRes.text();
    if (!geminiRes.ok) {
      lastDetail = text;
      continue;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      lastDetail = text.slice(0, 1200);
      continue;
    }

    const reply = extractReplyText(data);
    if (reply) {
      return { ok: true, model, reply };
    }

    lastDetail = `EMPTY_REPLY:${text.slice(0, 1200)}`;
  }

  return { ok: false, detail: lastDetail.slice(0, 2000) };
}

module.exports = {
  getGeminiModelCandidates,
  generateGeminiContent,
  extractReplyText,
};
