/**
 * 中文註解：共用 Gemini generateContent；依序嘗試多個模型 ID，避免舊版無後綴名稱遭 API 淘汰後整站 502。
 */
'use strict';

/** 中文註解：環境變數 GEMINI_MODEL 優先，否則嘗試已驗證較穩定的可用 ID。 */
function getGeminiModelCandidates() {
  const env = (process.env.GEMINI_MODEL || '').trim();
  const maxTriesRaw = parseInt(String(process.env.GEMINI_MAX_MODEL_TRIES || '2'), 10);
  const maxTries = Number.isFinite(maxTriesRaw) ? Math.min(5, Math.max(1, maxTriesRaw)) : 2;
  const fallback = [
    'gemini-1.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-002',
    'gemini-2.0-flash-001',
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
  // 中文註解：成本安全預設只嘗試前 2 個模型，避免 404/429 風暴放大請求數
  return out.slice(0, maxTries);
}

function extractReplyText(data) {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
}

/** 中文註解：供前端判斷是否因 token 上限被截斷 */
function extractFinishReason(data) {
  const r = data.candidates?.[0]?.finishReason;
  return typeof r === 'string' ? r : '';
}

/**
 * @param {string} apiKey
 * @param {object} payload — systemInstruction、contents、generationConfig（Gemini REST JSON 頂層欄位）
 * @returns {Promise<{ ok: true, model: string, reply: string } | { ok: false, detail: string }>}
 */
async function generateGeminiContent(apiKey, payload) {
  const models = getGeminiModelCandidates();
  // 中文註解：保留每個模型的錯誤摘要，幫 debug 哪個模型有 quota 哪個沒（不再只留最後一個）
  const perModelErrors = [];

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
      perModelErrors.push({
        model,
        err: String(err && err.message ? err.message : err).slice(0, 220),
      });
      continue;
    }

    const text = await geminiRes.text();
    if (!geminiRes.ok) {
      // 中文註解：抽出每個模型的關鍵錯誤片段（status + limit + metric），避免 detail 被冗餘訊息塞爆
      let summary = `HTTP ${geminiRes.status}`;
      try {
        const j = JSON.parse(text);
        const msg = String(j?.error?.message || '');
        const status = j?.error?.status || '';
        const limitMatch = msg.match(/limit:\s*\d+/);
        const metricMatch = msg.match(/metric:\s*[^\s,\n]+/);
        const retryMatch = msg.match(/retry in [\d.]+s/i);
        summary =
          `HTTP ${geminiRes.status} ${status}` +
          (metricMatch ? ` ${metricMatch[0]}` : '') +
          (limitMatch ? ` (${limitMatch[0]})` : '') +
          (retryMatch ? ` ${retryMatch[0]}` : '');
      } catch {
        summary += ` :: ${text.slice(0, 180)}`;
      }
      perModelErrors.push({ model, err: summary });
      continue;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      perModelErrors.push({ model, err: `INVALID_JSON: ${text.slice(0, 180)}` });
      continue;
    }

    const reply = extractReplyText(data);
    const finishReason = extractFinishReason(data);

    if (reply) {
      let out = reply;
      // 中文註解：模型輸出達 maxOutputTokens 時常在句中截斷，提示使用者可追問「請繼續」
      if (finishReason === 'MAX_TOKENS') {
        out +=
          '\n\n（此則因單次回覆長度達上限而在這裡結束；若要完整策略或下半段，請直接傳「請繼續」或把問題拆成小題。）';
      }
      return { ok: true, model, reply: out, finishReason };
    }

    perModelErrors.push({ model, err: 'EMPTY_REPLY' });
  }

  // 中文註解：把每個模型的錯誤一行一行列出來，比只留最後一個有用很多
  const detailLines = perModelErrors.map((e) => `  - ${e.model}: ${e.err}`);
  return {
    ok: false,
    detail: `MODELS_TRIED=${models.length}\n${detailLines.join('\n')}`.slice(0, 1800),
  };
}

module.exports = {
  getGeminiModelCandidates,
  generateGeminiContent,
  extractReplyText,
  extractFinishReason,
};
