/**
 * 中文註解：coach-chat / chat 共用的對話正規化與 Gemini contents 組裝，便於單元測試與行為一致。
 */
'use strict';

/** 中文註解：Vercel 可能傳入字串、Buffer 或已解析物件 */
function parseJsonBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body || '{}');
    } catch {
      return {};
    }
  }
  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString('utf8') || '{}');
    } catch {
      return {};
    }
  }
  if (typeof req.body === 'object') return req.body;
  return {};
}

/** 中文註解：前端已把本則使用者訊息放進 messages／history 尾端時，去掉尾端重複避免 Gemini 內重複一輪 */
function normalizeHistoryExcludingLatestUser(history, latestUserMessage) {
  const raw = Array.isArray(history) ? history : [];
  const normalized = raw
    .map((m) => ({
      role: String(m.role || '').toLowerCase(),
      content: String(m.content || '').trim(),
    }))
    .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'));

  const latest = String(latestUserMessage || '').trim();
  if (
    latest &&
    normalized.length > 0 &&
    normalized[normalized.length - 1].role === 'user' &&
    normalized[normalized.length - 1].content === latest
  ) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function compactGeminiContents(contents) {
  const list = Array.isArray(contents) ? contents : [];
  const out = [];
  for (const turn of list) {
    const text = turn?.parts?.[0]?.text;
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) continue;
    const role = turn.role === 'model' ? 'model' : 'user';
    if (!out.length) {
      out.push({ role, parts: [{ text: t }] });
      continue;
    }
    const prev = out[out.length - 1];
    if (prev.role === role) {
      prev.parts[0].text = `${prev.parts[0].text}\n\n${t}`;
    } else {
      out.push({ role, parts: [{ text: t }] });
    }
  }
  return out;
}

/** 中文註解：與 coach-chat 一致，預設 12、範圍 4～48；可由 GEMINI_HISTORY_MAX_TURNS 覆寫 */
function clampHistoryMaxTurns(rawEnv) {
  const n = parseInt(String(rawEnv ?? '12'), 10);
  const v = Number.isFinite(n) ? n : 12;
  return Math.min(48, Math.max(4, v));
}

/** 中文註解：priorHistory 為已排除本輪重複 user 的紀錄；maxTurns 為「歷史」則數上限（不含本輪） */
function buildGeminiContents(priorHistory, currentUserText, maxTurns) {
  const mt = typeof maxTurns === 'number' && maxTurns > 0 ? maxTurns : clampHistoryMaxTurns('12');
  const slice = priorHistory.slice(-mt);
  const contents = [];
  for (const m of slice) {
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: currentUserText }] });
  let merged = compactGeminiContents(contents);
  while (merged.length && merged[0].role === 'model') {
    merged = merged.slice(1);
  }
  if (!merged.length) {
    merged = [{ role: 'user', parts: [{ text: currentUserText }] }];
  }
  return merged;
}

/** 中文註解：組 OpenAI Chat Completions 的 messages（不含 system；system 由呼叫端另加） */
function buildOpenAiMessages(priorHistory, currentUserText, maxTurns, systemPrompt) {
  const mt =
    typeof maxTurns === 'number' && maxTurns > 0 ? maxTurns : clampHistoryMaxTurns('12');
  const slice = priorHistory.slice(-mt);
  const out = slice.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  const messages = out;
  messages.push({ role: 'user', content: currentUserText });
  if (systemPrompt) {
    messages.unshift({ role: 'system', content: systemPrompt });
  }
  return messages;
}

module.exports = {
  parseJsonBody,
  normalizeHistoryExcludingLatestUser,
  compactGeminiContents,
  clampHistoryMaxTurns,
  buildGeminiContents,
  buildOpenAiMessages,
};
