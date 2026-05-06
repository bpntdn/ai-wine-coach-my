// api/coach-chat.js — 梅娜斯葡萄酒社交教練 後端 API（Vercel Serverless，CommonJS）
// 中文註解：System prompt 以 maenads_system_prompt.md 為唯一權威來源，與 vercel.json includeFiles 一致。
// 中文註解：LLM 預設「Gemini → OpenAI」自動備援；可設 OPENAI_FIRST=1 改為先 OpenAI。環境變數：GEMINI_API_KEY、OPENAI_API_KEY、OPENAI_MODEL。

'use strict';

const fs = require('fs');
const path = require('path');
const { generateGeminiContent } = require('./gemini-generate-content.js');
const { generateOpenAiChatCompletion } = require('./openai-chat-completions.js');
const { retrieveCoachContext } = require('./coach-kb.js');
const {
  parseJsonBody,
  normalizeHistoryExcludingLatestUser,
  clampHistoryMaxTurns,
  buildGeminiContents,
  buildOpenAiMessages,
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

  // 中文註解：把整個對話歷史合併成一個搜尋字串，用來偵測國家／場合等上下文線索
  const historyJoined = Array.isArray(priorHistory)
    ? priorHistory
        .map((m) => String((m && m.content) || ''))
        .join('\n') + '\n' + q
    : q;
  // 中文註解：依使用者實際對話脈絡，選出最相關的國家／文化錨點
  function detectCountry(text) {
    const list = [
      { name: '韓國', re: /(韓國|首爾|韓商|Seoul|Korea)/iu },
      { name: '日本', re: /(日本|東京|日商|Tokyo|Japan)/iu },
      { name: '法國', re: /(法國|巴黎|Paris|France|法商)/iu },
      { name: '中國', re: /(中國|大陸|北京|上海|中商|China|Beijing|Shanghai)/iu },
      { name: '中東', re: /(中東|沙烏地|杜拜|穆斯林|清真|Halal|Saudi|Dubai|UAE)/iu },
      { name: '捷克', re: /(捷克|布拉格|Czech|Prague)/iu },
      { name: '德國', re: /(德國|柏林|慕尼黑|Germany|Berlin)/iu },
      { name: '義大利', re: /(義大利|羅馬|米蘭|Italy|Rome|Milan)/iu },
    ];
    return list.find((c) => c.re.test(text));
  }
  const country = detectCountry(historyJoined);

  function linesToText(title, lines, closing) {
    return (
      `我先用離線教練模式接住你，避免你卡在空白頁。\n\n${title}\n` +
      lines.map((x, i) => `${i + 1}) ${x}`).join('\n') +
      `\n\n${closing}`
    );
  }

  // 中文註解：敬酒題型 — 結合歷史中偵測到的國家給對應禮儀，避免泛泛而談
  if (/(敬酒|乾杯|toast|cheers|碰杯|斟酒|倒酒)/iu.test(anchor) || /(敬酒|乾杯|斟酒|倒酒)/u.test(historyJoined)) {
    if (country && country.name === '韓國') {
      return linesToText(
        '先針對你問的「韓國敬酒」給你離線版重點：',
        [
          '對長輩／前輩敬酒時：身體稍微側身或轉身飲，不要正面對著，是表示尊重。',
          '雙手扶杯：晚輩遞酒、接酒一律雙手；對方斟酒時，杯子可以略低於對方杯緣。',
          '順序很重要：先敬職位最高、最年長的，再依序往下，不要跳過資深前輩。',
          '酒杯不要見底太快：對方還在說話時別急著把酒喝完；節奏跟著職位高的人走。',
        ],
        '你下次回我「對方是甲方還是乙方／你方有幾人」，我可以幫你規劃整桌敬酒順序。'
      );
    }
    if (country && country.name === '日本') {
      return linesToText(
        '先針對你問的「日本敬酒」給你離線版重點：',
        [
          '雙手持杯接酒，遞杯時略低於對方，對前輩／上司尤其重要。',
          '主管幫你倒酒：先說「お願いします」或「謝謝」，再雙手回敬，先喝一口示意。',
          '不要自己倒自己的酒：等對方倒，或主動幫旁邊的人倒，是日式餐桌的禮節。',
          '乾杯（kanpai）時眼神交流，但不必硬碰杯到底；場合越正式越輕碰。',
        ],
        '你回我「人數／是不是初次見面」，我可幫你寫第一句敬酒台詞。'
      );
    }
    if (country) {
      return linesToText(
        `先針對你問的「${country.name}敬酒」給你離線版重點：`,
        [
          `${country.name}敬酒時要先看主人／長輩節奏，不要搶著開第一杯。`,
          '開場用一句感謝主人邀請的話，比直接講合作誠意更得體。',
          '對方斟酒時雙手扶杯或稍欠身，是常見表示尊重的方式。',
          '若你不太能喝，可以先說明「我量不大，但今天很開心能在場」，比硬撐好。',
        ],
        '你回我對方人數與正式程度，我可以幫你準備第一句敬酒台詞。'
      );
    }
    // 中文註解：沒抓到國家就給通則，但仍含關鍵詞（長輩／杯／順序）讓題目對得上
    return linesToText(
      `先針對「${topic}」給你敬酒禮儀的離線版重點：`,
      [
        '先看主人／長輩的節奏，不要搶著開第一杯，順序由高到低。',
        '對前輩／上司敬酒：雙手扶杯、杯口略低；對方斟酒時也是雙手接。',
        '說一句具體理由比空泛「敬您」更有重量，例如「感謝您今天特地撥時間」。',
        '不勝酒力可以先說明，比硬撐到失態好；對方通常會欣賞坦率。',
      ],
      '你回我場合（商務／家宴／婚禮）與對方身分，我幫你寫第一句台詞。'
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
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
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

  // 中文註解：Gemini 配額不足時改走 OpenAI；兩者至少擇一，否則無法雲端作答
  if (!GEMINI_API_KEY && !OPENAI_API_KEY) {
    return res.status(500).json({
      error: '未設定 LLM 金鑰',
      detail:
        '請在 Vercel → Environment Variables 設定 GEMINI_API_KEY 或 OPENAI_API_KEY（建議兩者皆設以自動備援），並 Redeploy。',
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

  // 中文註解：OPENAI_FIRST=1 時先走 ChatGPT 相容 API，失敗再回 Gemini
  const openaiFirst = /^(1|true|yes)$/i.test(String(process.env.OPENAI_FIRST || '').trim());
  const openaiModel = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const openAiMessages = buildOpenAiMessages(priorHistory, currentUserText, maxTurns);

  /** 中文註解：統一成功回傳形狀，前端可看 provider 判斷是否雲端模型 */
  function respondLive(provider, payload) {
    return res.status(200).json({
      ...payload,
      mode: 'llm_live',
      provider,
      sources: serverRag.map((r) => ({ id: r.id, tags: r.tags })),
    });
  }

  async function callGemini() {
    if (!GEMINI_API_KEY) return { ok: false, detail: 'NO_GEMINI_KEY' };
    return generateGeminiContent(GEMINI_API_KEY, {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: maxOut,
        topP: 0.95,
      },
    });
  }

  async function callOpenAI() {
    if (!OPENAI_API_KEY) return { ok: false, detail: 'NO_OPENAI_KEY' };
    return generateOpenAiChatCompletion(OPENAI_API_KEY, {
      system: SYSTEM_PROMPT,
      messages: openAiMessages,
      model: openaiModel,
      temperature: 0.8,
      maxTokens: Math.min(4096, maxOut),
    });
  }

  try {
    let geminiDetail = '';
    let openaiDetail = '';

    if (openaiFirst && OPENAI_API_KEY) {
      const oFirst = await callOpenAI();
      if (oFirst.ok) {
        return respondLive('openai', {
          reply: oFirst.reply,
          model: oFirst.model,
          finishReason: oFirst.finishReason || undefined,
        });
      }
      openaiDetail = String(oFirst.detail || '');

      const gSecond = await callGemini();
      if (gSecond.ok) {
        const finalReply =
          gSecond.reply ||
          '我需要你多說一點：這次是什麼場合、對象是誰、你希望達成什麼？';
        return respondLive('gemini', {
          reply: finalReply,
          model: gSecond.model,
          finishReason: gSecond.finishReason || undefined,
        });
      }
      geminiDetail = String(gSecond.detail || '');
    } else {
      const gFirst = await callGemini();
      if (gFirst.ok) {
        const finalReply =
          gFirst.reply ||
          '我需要你多說一點：這次是什麼場合、對象是誰、你希望達成什麼？';
        return respondLive('gemini', {
          reply: finalReply,
          model: gFirst.model,
          finishReason: gFirst.finishReason || undefined,
        });
      }
      geminiDetail = String(gFirst.detail || '');

      const oSecond = await callOpenAI();
      if (oSecond.ok) {
        return respondLive('openai', {
          reply: oSecond.reply,
          model: oSecond.model,
          finishReason: oSecond.finishReason || undefined,
        });
      }
      openaiDetail = String(oSecond.detail || '');
    }

    // 中文註解：OPENAI 放前面，避免 detail 截斷時只剩 Gemini 長文而看不到「未設金鑰」
    const combinedDetail = [openaiDetail && `OPENAI:${openaiDetail}`, geminiDetail && `GEMINI:${geminiDetail}`]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1600);

    return res.status(200).json({
      reply: buildEmergencyReply(message, priorHistory),
      model: 'emergency-fallback',
      mode: 'fallback',
      provider: 'fallback',
      finishReason: 'UPSTREAM_UNAVAILABLE',
      sources: serverRag.map((r) => ({ id: r.id, tags: r.tags })),
      detail: combinedDetail,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
