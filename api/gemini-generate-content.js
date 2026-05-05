/**
 * 中文註解：共用 Gemini generateContent；依序嘗試多個模型 ID，避免舊版無後綴名稱遭 API 淘汰後整站 502。
 */
'use strict';

/** 中文註解：社交／話術 coaching 易遭預設安全門檻誤傷，略放寬至 BLOCK_ONLY_HIGH（仍可遵循 Google 政策） */
const DEFAULT_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
];

/** 中文註解：Gemini 偶爾 200 但無文字（安全／政策／模型異常）；給使用者可繼續對話的 200 回覆，避免整站 502 */
const EMPTY_REPLY_USER_MESSAGE =
  '我是梅娜斯。剛才這裡沒有留下可閱讀的回覆，可能是自動過濾較謹慎。\n\n請你把句子換個說法——例如「請給我三個輕鬆、得體的開場白，想在正式場合用」，我再陪你一句一句練。';

/** 中文註解：環境變數 GEMINI_MODEL 優先；預設先試較穩定的帶版號模型，舊 preview id 易失效 */
function getGeminiModelCandidates() {
  const env = (process.env.GEMINI_MODEL || '').trim();
  const fallback = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.5-flash',
    'gemini-2.5-flash-preview-05-20',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash',
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
  let lastDetail = '';
  /** 中文註解：曾有過 HTTP 200 且 JSON 解析成功，但 candidates 無可用文字（安全／空回覆等） */
  let httpOkButNoText = false;
  let lastEmptyModel = '';
  /** 中文註解：單次呼叫 Gemini 的上限，略低於 Vercel 60s，避免函式被硬殺 */
  const fetchMs = Math.min(55000, Math.max(8000, parseInt(process.env.GEMINI_FETCH_MS || '52000', 10) || 52000));

  const mergedPayload = {
    ...payload,
    safetySettings: payload.safetySettings || DEFAULT_SAFETY_SETTINGS,
  };

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let geminiRes;
    try {
      geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mergedPayload),
        signal: AbortSignal.timeout(fetchMs),
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

    // 中文註解：200 但無文字——換下一個模型試；仍失敗則以軟回覆避免前端顯示「沙龍無法回應」502
    httpOkButNoText = true;
    lastEmptyModel = model;
    lastDetail = `EMPTY_REPLY:${text.slice(0, 1200)}`;
    continue;
  }

  if (httpOkButNoText) {
    return {
      ok: true,
      model: lastEmptyModel || models[0] || 'fallback',
      reply: EMPTY_REPLY_USER_MESSAGE,
      finishReason: 'CLIENT_FALLBACK_EMPTY',
    };
  }

  return { ok: false, detail: lastDetail.slice(0, 2000) };
}

module.exports = {
  getGeminiModelCandidates,
  generateGeminiContent,
  extractReplyText,
  extractFinishReason,
};
