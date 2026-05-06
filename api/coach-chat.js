// api/coach-chat.js — 梅娜斯葡萄酒社交教練 後端 API（Vercel Serverless，CommonJS）
// 中文註解：System prompt 以 maenads_system_prompt.md 為唯一權威來源，與 vercel.json includeFiles 一致。

'use strict';

const fs = require('fs');
const path = require('path');
const { generateGeminiContent } = require('./gemini-generate-content.js');
const { retrieveCoachContext } = require('./coach-kb.js');
const {
  parseJsonBody,
  normalizeHistoryExcludingLatestUser,
  clampHistoryMaxTurns,
  buildGeminiContents,
} = require('./coach-history.js');

/** 中文註解：快取 system prompt，避免每次請求讀檔 */
let cachedMaenadsSystemPrompt = null;

/** 中文註解：上游模型暫時失效時，先給可執行建議，避免前端只收到錯誤碼。 */
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

  function linesToText(title, lines, closing) {
    return (
      `我先用離線教練模式接住你，避免你卡在空白頁。\n\n${title}\n` +
      lines.map((x, i) => `${i + 1}) ${x}`).join('\n') +
      `\n\n${closing}`
    );
  }

  // 中文註解：語言／發音型問題（例如 merlot 怎麼說）要對題，不可回泛用社交模板
  if (/(merlot|梅洛)/iu.test(anchor) && /(怎麼說|發音|念|讀|英文|法文)/u.test(anchor)) {
    return (
      '我先用離線教練模式接住你，避免你卡在空白頁。\n\n' +
      '你這題先直接可用：\n' +
      '「Merlot 常見念法像『梅-洛』（英語近似 /mer-loh/）。在餐桌上你可以自然說：我想點梅洛。」\n\n' +
      '三句可直接說出口：\n' +
      '1)「我想點一支梅洛，走柔順果香路線。」\n' +
      '2)「如果有梅洛，想選單寧不要太重的版本。」\n' +
      '3)「我平常喝梅洛比較順口，今天也想試這個方向。」\n\n' +
      '若你要，我下一則可以直接幫你配成「牛排／燉肉／麻辣鍋」三種場合版本。'
    );
  }

  // 中文註解：選酒搭餐類型，先給安全選項 + 詢問必要條件
  if (/(麻辣鍋|火鍋|燒烤|牛排|海鮮|搭餐|配餐|帶什麼酒|選酒)/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你一個安全、不踩雷的離線版：`,
      [
        '先選「中酸度、果香乾淨、單寧不過重」的酒款，避免壓過食物味道。',
        '若是重口味（麻辣/燒烤）：先選果香型紅酒（如梅洛）或微冰白酒。',
        '帶去聚餐時先說「我帶這支是想讓大家都好入口」，比講專業名詞更自然。',
      ],
      '你回我「今天吃什麼＋預算區間」，我可直接給你 3 支可買清單。'
    );
  }

  // 中文註解：商務談判／客戶飯局
  if (/(客戶|合作|商務|談判|壓價|專案|飯局|生意)/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你一個可立即上桌的離線版：`,
      [
        '開場先降壓：「今天先輕鬆交流，不急著定結論。」',
        '中段再收斂：「如果方向一致，我們再排一個正式討論時段。」',
        '收尾給下一步：「我明天整理 1 頁重點給你，你看哪個版本最接近你需求。」',
      ],
      '若你要，我下一則可改成「你本人語氣」版本（強勢／溫和／高情商）。'
    );
  }

  // 中文註解：感情／破冰／續攤邀約
  if (/(約會|好感|破冰|續攤|邀請|尷尬|冷場|聊天)/u.test(anchor)) {
    return linesToText(
      `先針對「${topic}」給你三句可直接複誦的離線版：`,
      [
        '「跟你聊天很舒服，我想再多認識你一點。」',
        '「我們先從輕鬆的聊，你最近最開心的一件事是什麼？」',
        '「如果你願意，下次我想約你去一間安靜一點的店慢慢聊。」',
      ],
      '你也可以回我對方個性（慢熱/外向），我幫你改成更像你會說的口吻。'
    );
  }

  if (shortAck) {
    return (
      '收到，我延續你剛剛那個情境繼續。\n\n' +
      `我們延續你上一個主題：「${topic}」。\n\n` +
      '我先給你三句自然、不尷尬、可直接說出口的版本：\n' +
      '1)「好久不見，今天見到你我其實很開心。」\n' +
      '2)「這些年我變很多，也想聽聽你最近過得怎麼樣。」\n' +
      '3)「我們先慢慢聊近況，舒服就好，不急著把話題聊重。」'
    );
  }

  return linesToText(
    `先針對「${topic}」給你可用三步：`,
    [
      '先說當下感受，不急著證明自己（先放慢語速、先問對方近況）。',
      '丟一個可回答的小問題，讓對話自然延伸。',
      '收尾留下一個「下一步」選項，讓關係有後續空間。',
    ],
    '如果你要，我可以直接幫你改成「下一句就能說出口」的版本。'
  );
}

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
  const frontendLocal = Array.isArray(local_context) ? local_context : [];
  const serverRag = retrieveCoachContext(message, 3);
  const mergedContextRows = [
    ...frontendLocal
      .map((c) => (c && typeof c.answer === 'string' ? c.answer.trim() : ''))
      .filter(Boolean),
    ...serverRag.map((r) => r.text),
  ];
  if (mergedContextRows.length > 0) {
    contextNote = '\n\n【知識補充】\n' + mergedContextRows.join('\n---\n');
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
      return res.status(200).json({
        reply: buildEmergencyReply(message, priorHistory),
        model: 'emergency-fallback',
        mode: 'fallback',
        finishReason: 'UPSTREAM_UNAVAILABLE',
        sources: serverRag.map((r) => ({ id: r.id, tags: r.tags })),
        detail: String(result.detail || '').slice(0, 600),
      });
    }

    const finalReply =
      result.reply ||
      '我需要你多說一點：這次是什麼場合、對象是誰、你希望達成什麼？';

    return res.status(200).json({
      reply: finalReply,
      model: result.model,
      mode: 'llm_live',
      sources: serverRag.map((r) => ({ id: r.id, tags: r.tags })),
      finishReason: result.finishReason || undefined,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
