// api/coach-chat.js — 梅娜斯葡萄酒社交教練 後端 API（Vercel Serverless，CommonJS）
// 中文註解：System prompt 以 maenads_system_prompt.md 為唯一權威來源，與 vercel.json includeFiles 一致。

'use strict';

const fs = require('fs');
const path = require('path');
const { generateGeminiContent } = require('./gemini-generate-content.js');
const {
  parseJsonBody,
  normalizeHistoryExcludingLatestUser,
  clampHistoryMaxTurns,
  buildGeminiContents,
} = require('./coach-history.js');

/** 中文註解：快取 system prompt，避免每次請求讀檔 */
let cachedMaenadsSystemPrompt = null;

function loadMaenadsSystemPrompt() {
  if (cachedMaenadsSystemPrompt !== null) return cachedMaenadsSystemPrompt;
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
          cachedMaenadsSystemPrompt = t;
          return cachedMaenadsSystemPrompt;
        }
      }
    } catch {
      // 略
    }
  }
  cachedMaenadsSystemPrompt =
    '你是「AI葡萄酒社交教練」梅娜斯。請用繁體中文（台灣）自然回答；若提及特定國家請對題，勿把 A 國答成 B 國。';
  return cachedMaenadsSystemPrompt;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const APP_ACCESS_CODE = process.env.APP_ACCESS_CODE || '';
  const APPROVED_EMAILS = (process.env.APPROVED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const body = parseJsonBody(req);
  const {
    message: rawMessage = '',
    messages = [],
    user_email = '',
    access_code = '',
    local_context = [],
  } = body;
  const message = String(rawMessage || '').trim();

  if (APP_ACCESS_CODE) {
    const codeOk = access_code === APP_ACCESS_CODE;
    const emailOk =
      APPROVED_EMAILS.length === 0 ||
      (user_email && APPROVED_EMAILS.includes(user_email.toLowerCase()));

    if (!codeOk) return res.status(403).json({ error: 'ACCESS_CODE_INVALID' });
    if (APPROVED_EMAILS.length > 0 && !emailOk) {
      return res.status(403).json({ error: 'EMAIL_NOT_APPROVED' });
    }
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY 未設定',
      detail: '請在 Vercel → Settings → Environment Variables 加入 GEMINI_API_KEY 並 Redeploy。',
    });
  }

  if (!message) {
    return res.status(400).json({ error: 'Missing message' });
  }

  let contextNote = '';
  if (local_context && local_context.length > 0) {
    contextNote =
      '\n\n【本地知識補充】\n' + local_context.map((c) => c.answer).join('\n---\n');
  }

  const priorHistory = normalizeHistoryExcludingLatestUser(messages, message);
  const currentUserText = message + contextNote;
  // 中文註解：歷史輪數與 api/coach-history.js、api/chat.js 一致（GEMINI_HISTORY_MAX_TURNS）
  const maxTurns = clampHistoryMaxTurns(process.env.GEMINI_HISTORY_MAX_TURNS);
  const contents = buildGeminiContents(priorHistory, currentUserText, maxTurns);
  const SYSTEM_PROMPT = loadMaenadsSystemPrompt();

  // 中文註解：過低的 maxOutputTokens 會讓中文長答在句中硬斷；可用環境變數覆寫
  const maxOut = Math.min(
    8192,
    Math.max(512, parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '2048', 10) || 2048),
  );

  try {
    const result = await generateGeminiContent(GEMINI_API_KEY, {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: maxOut,
        topP: 0.95,
      },
    });

    if (!result.ok) {
      return res.status(502).json({
        error: 'Gemini API 回應錯誤',
        detail: String(result.detail || '').slice(0, 600),
      });
    }

    const finalReply =
      result.reply ||
      '我需要你多說一點：這次是什麼場合、對象是誰、你希望達成什麼？';

    return res.status(200).json({
      reply: finalReply,
      model: result.model,
      finishReason: result.finishReason || undefined,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
