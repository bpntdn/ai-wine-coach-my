
/**
 * api/coach-chat.js — 梅娜斯葡萄酒社交教練 後端 API（Vercel Serverless，CommonJS）
 * 中文註解：System prompt 以 maenads_system_prompt.md 為唯一權威來源。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { generateGeminiContent } = require('./gemini-generate-content.js');
const { generateOpenAiChatCompletion } = require('./openai-chat-completions.js');
const { retrieveCoachContext } = require('./coach-kb.js');
const {
  normalizeHistoryExcludingLatestUser,
  clampHistoryMaxTurns,
  buildGeminiContents,
  buildOpenAiMessages,
} = require('./coach-history.js');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const APPROVED_EMAILS = (process.env.APPROVED_EMAILS || "").split(",").filter(Boolean);
const PASSPHRASE = process.env.PASSPHRASE;

let cachedSystemPrompt = null;

/** 中文註解：載入 System Prompt 檔案 */
function loadMaenadsSystemPrompt() {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt;
  const candidates = [
    path.join(__dirname, '..', 'maenads_system_prompt.md'),
    path.join(__dirname, 'maenads_system_prompt.md'),
    path.join(process.cwd(), 'maenads_system_prompt.md'),
  ];
  for (const promptPath of candidates) {
    try {
      if (fs.existsSync(promptPath)) {
        const t = fs.readFileSync(promptPath, 'utf8').trim();
        if (t) {
          cachedSystemPrompt = t;
          return cachedSystemPrompt;
        }
      }
    } catch (e) {}
  }
  cachedSystemPrompt = `你是「AI葡萄酒社交教練」。請用繁體中文（台灣）自然回答。`;
  return cachedSystemPrompt;
}

/** 中文註解：離線回退回答邏輯 */
function buildEmergencyReply(message) {
  const topic = String(message || '').slice(0, 50);
  return `目前連線較擁擠，我先以離線教練模式接住你。\n\n針對「${topic}」，建議您可以先從觀察場合氛圍開始，保持自信且親切的態度。若需要更具體的酒款建議，請稍後再試，我會為您提供更深度的分析。`;
}

module.exports = async (req, res) => {
  const { message, messages, local_context, email, passphrase } = req.body;

  // 身份驗證
  if (PASSPHRASE) {
    if (passphrase !== PASSPHRASE) {
      return res.status(403).json({ error: 'INVALID_PASSPHRASE' });
    }
    if (APPROVED_EMAILS.length > 0 && !APPROVED_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'EMAIL_NOT_APPROVED' });
    }
  }

  if (!GEMINI_API_KEY && !OPENAI_API_KEY) {
    return res.status(500).json({ error: '未設定 LLM 金鑰' });
  }

  if (!message) {
    return res.status(400).json({ error: 'Missing message' });
  }

  const serverRag = retrieveCoachContext(message, 5);
  const mergedContextRows = [
    ...(Array.isArray(local_context) ? local_context : [])
      .map((c) => (c && typeof c.answer === 'string' ? c.answer.trim() : ''))
      .filter(Boolean),
    ...serverRag.map((r) => r.text),
  ];

  let currentUserText = message;
  if (mergedContextRows.length > 0) {
    currentUserText += '\n\n【參考知識】\n' + mergedContextRows.join('\n---\n');
  }

  const priorHistory = normalizeHistoryExcludingLatestUser(messages, message);
  const SYSTEM_PROMPT = loadMaenadsSystemPrompt();
  const maxTurns = clampHistoryMaxTurns(process.env.GEMINI_HISTORY_MAX_TURNS);
  const maxOut = Math.min(8192, Math.max(512, parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '2048', 10) || 2048));

  const openaiFirst = /^(1|true|yes)$/i.test(String(process.env.OPENAI_FIRST || '').trim());
  const openaiModel = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

  function respondLive(provider, payload) {
    return res.status(200).json({
      ...payload,
      mode: 'llm_live',
      provider,
      sources: serverRag.map((r) => ({ id: r.id, tags: r.tags })),
    });
  }

  async function callGemini() {
    if (!GEMINI_API_KEY) return { ok: false };
    const contents = buildGeminiContents(priorHistory, currentUserText, maxTurns);
    return generateGeminiContent(GEMINI_API_KEY, {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { temperature: 0.8, maxOutputTokens: maxOut, topP: 0.95 },
    });
  }

  async function callOpenAI() {
    if (!OPENAI_API_KEY) return { ok: false };
    const openAiMessages = buildOpenAiMessages(priorHistory, currentUserText, maxTurns, SYSTEM_PROMPT);
    return generateOpenAiChatCompletion(OPENAI_API_KEY, {
      messages: openAiMessages,
      model: openaiModel,
      temperature: 0.8,
      maxTokens: Math.min(4096, maxOut),
    });
  }

  try {
    if (openaiFirst && OPENAI_API_KEY) {
      const o = await callOpenAI();
      if (o.ok) return respondLive('openai', { reply: o.reply, model: o.model });
      const g = await callGemini();
      if (g.ok) return respondLive('gemini', { reply: g.reply, model: g.model });
    } else {
      const g = await callGemini();
      if (g.ok) return respondLive('gemini', { reply: g.reply, model: g.model });
      const o = await callOpenAI();
      if (o.ok) return respondLive('openai', { reply: o.reply, model: o.model });
    }

    return res.status(200).json({
      reply: buildEmergencyReply(message),
      mode: 'fallback',
      provider: 'fallback',
      sources: serverRag.map((r) => ({ id: r.id, tags: r.tags })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
