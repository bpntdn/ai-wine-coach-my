/**
 * 中文註解：Vercel Serverless — 中繼呼叫 Google Gemini（模型見 gemini-generate-content.js 退回鏈），金鑰僅從環境變數讀取。
 * POST JSON：{ "message": "本則使用者文字", "history": [ { "role":"user"|"assistant", "content":"..." } ] }
 * 若前端已把本則 message 一併放在 history 尾端 user，後端會自動去重。
 */

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
let cachedSystemPrompt = null;

/** 中文註解：chat 路由在上游失效時也要維持可用，避免整體體驗中斷。 */
function buildEmergencyReply(message, priorHistory) {
  const q = String(message || '').trim();
  const shortAck = /^(好|好的|ok|OK|嗯|嗯嗯|對|是|收到|了解|謝謝|感謝)$/u.test(q);
  const lastRichUser = Array.isArray(priorHistory)
    ? [...priorHistory]
        .reverse()
        .find((m) => m && m.role === 'user' && String(m.content || '').trim().length >= 6)
    : null;
  const anchor = shortAck
    ? String((lastRichUser && lastRichUser.content) || '').trim()
    : q;
  const topic = anchor ? anchor.slice(0, 48) + (anchor.length > 48 ? '…' : '') : '你的情境';

  if (shortAck) {
    return (
      '收到，我延續上一個主題，不另外亂猜新題目。\n\n' +
      `目前焦點是：「${topic}」。\n\n` +
      '我先給你三句可直接說：\n' +
      '1)「好久不見，今天先輕鬆聊聊近況就好。」\n' +
      '2)「其實見到你我有點緊張，但也很開心。」\n' +
      '3)「我們慢慢聊，不急著把話題聊得太重。」'
    );
  }

  return (
    '目前先用離線回覆模式協助你，避免你被錯誤訊息中斷。\n\n' +
    `你剛提到的是：「${topic}」。\n` +
    '你可以先這樣說：\n' +
    '「我想先聽聽你的想法，再分享我的觀察。」\n\n' +
    '若你願意，我可以再給你 3 種不同語氣版本（自然／專業／溫柔）。'
  );
}

/** 中文註解：與 coach-chat 相同策略，多路徑找 maenads_system_prompt.md（Vercel 打包後 __dirname 在 api/） */
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
    } catch {
      // 略
    }
  }
  cachedSystemPrompt = `你是「AI葡萄酒社交教練」。請用繁體中文（台灣）自然回答。`;
  return cachedSystemPrompt;
}

module.exports = async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  const applyCors = () => {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
  };

  applyCors();

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = parseJsonBody(req);
    const message = String(body.message || '').trim();
    const history = Array.isArray(body.history) ? body.history : [];

    if (!message) {
      return res.status(400).json({ error: 'Missing message' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured' });
    }

    const system = loadMaenadsSystemPrompt();
    const priorHistory = normalizeHistoryExcludingLatestUser(history, message);
    const maxTurns = clampHistoryMaxTurns(process.env.GEMINI_HISTORY_MAX_TURNS);
    const contents = buildGeminiContents(priorHistory, message, maxTurns);

    const maxOut = Math.min(
      8192,
      Math.max(512, parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '2048', 10) || 2048),
    );

    const result = await generateGeminiContent(apiKey, {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        temperature: 0.85,
        maxOutputTokens: maxOut,
        topP: 0.95,
      },
    });

    if (!result.ok) {
      return res.status(200).json({
        reply: buildEmergencyReply(message, priorHistory),
        model: 'emergency-fallback',
        finishReason: 'UPSTREAM_UNAVAILABLE',
        detail: String(result.detail || '').slice(0, 2000),
      });
    }

    return res.status(200).json({
      reply: result.reply,
      model: result.model,
      finishReason: result.finishReason || undefined,
    });
  } catch (err) {
    return res.status(500).json({ error: 'chat_route_failed', detail: err.message });
  }
};
