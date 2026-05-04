/**
 * 中文註解：Vercel Serverless — 中繼呼叫 Google Gemini（模型見 gemini-generate-content.js 退回鏈），金鑰僅從環境變數讀取。
 * POST JSON：{ "message": "本則使用者文字", "history": [ { "role":"user"|"assistant", "content":"..." } ] }
 * 若前端已把本則 message 一併放在 history 尾端 user，後端會自動去重。
 */

const fs = require('fs');
const path = require('path');
const { generateGeminiContent } = require('./gemini-generate-content.js');

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

/** 中文註解：前端若已把最新 user 訊息 append 進 history，去掉尾端重複 */
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

/** 中文註解：Gemini 需 user/model 交替；合併連續同角色 */
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

/** 中文註解：歷史轉成 Gemini contents，最後一則為本輪 user */
function buildGeminiContents(priorHistory, currentUserText) {
  const slice = priorHistory.slice(-32);
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
    const contents = buildGeminiContents(priorHistory, message);

    const result = await generateGeminiContent(apiKey, {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        temperature: 0.85,
        maxOutputTokens: 8192,
      },
    });

    if (!result.ok) {
      return res.status(502).json({
        error: 'Gemini API error',
        detail: result.detail.slice(0, 2000),
      });
    }

    return res.status(200).json({
      reply: result.reply,
      model: result.model,
    });
  } catch (err) {
    return res.status(500).json({ error: 'chat_route_failed', detail: err.message });
  }
};
