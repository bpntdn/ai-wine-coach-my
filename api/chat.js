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
      console.error('[chat] GEMINI_API_KEY 未設定');
      return res.status(200).json({
        reply: '我是梅娜斯。沙龍尚在準備中，請稍後再試。',
        finishReason: 'NO_API_KEY',
      });
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
      console.error('[chat] Gemini 全線失敗', String(result.detail || '').slice(0, 800));
      return res.status(200).json({
        reply:
          '我是梅娜斯。這一刻線路不穩，我沒能把你的句子完整接進沙龍。\n\n' +
          '請稍待十餘秒再傳一次；若對話已經很長，可先點「新開始」，再用一句話問我。',
        finishReason: 'UPSTREAM_UNAVAILABLE',
      });
    }

    return res.status(200).json({
      reply: result.reply,
      model: result.model,
      finishReason: result.finishReason || undefined,
    });
  } catch (err) {
    console.error('[chat] catch', err && err.stack ? err.stack : err);
    return res.status(200).json({
      reply:
        '我是梅娜斯。這一刻線路不穩，我沒能把你的句子完整接進沙龍。\n\n' +
        '請稍待十餘秒再傳一次；若對話已經很長，可先點「新開始」，再用一句話問我。',
      finishReason: 'HANDLER_EXCEPTION',
    });
  }
};
