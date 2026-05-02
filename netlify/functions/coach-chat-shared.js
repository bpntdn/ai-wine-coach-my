const fs = require('fs');
const path = require('path');

/** 中文註解：快取 maenads_system_prompt.md，避免每次請求都讀檔 */
let cachedMaenadsSystemPrompt = null;

/** 中文註解：Netlify／Vercel 打包路徑不同，多路徑找 maenads_system_prompt.md */
function getMaenadsSystemPrompt() {
  if (cachedMaenadsSystemPrompt !== null) return cachedMaenadsSystemPrompt;
  const candidates = [
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
  cachedMaenadsSystemPrompt = `你是「AI葡萄酒社交教練」。請用繁體中文（台灣）自然回答；若提及特定國家請對題，勿把 A 國答成 B 國。`;
  return cachedMaenadsSystemPrompt;
}

/** 中文註解：前端會先把本則使用者訊息 push 進 history，這裡去掉尾端重複避免 API 內重複一輪 */
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

/** 中文註解：僅在本輪使用者訊息附帶檢索／網路片段（不寫進歷史 JSON，避免污染多輪） */
function buildContextualUserMessage(message, localContext, webContext) {
  const safeLocal = Array.isArray(localContext) ? localContext.slice(0, 3) : [];
  const safeWeb = Array.isArray(webContext) ? webContext.slice(0, 6) : [];
  if (!safeLocal.length && !safeWeb.length) return String(message || '').trim();

  return `${String(message || '').trim()}

【內建知識檢索（可能相關，可忽略）】
${JSON.stringify(safeLocal, null, 2)}

【網路搜尋片段（可能相關）】
${JSON.stringify(safeWeb, null, 2)}

請依完整對話脈絡與上列片段回答；若片段無關可忽略。請輸出自然長文，不要輸出 JSON。`.trim();
}

/** 中文註解：Gemini 需 user/model 交替；合併連續同角色的文字成單一則 */
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

/** 中文註解：prior 為已發生的 user/assistant 對話，最後再接本輪含檢索的 user 文字 */
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
  // 中文註解：開頭不能是 model，否則 API 可能拒絕
  while (merged.length && merged[0].role === 'model') {
    merged = merged.slice(1);
  }
  if (!merged.length) {
    merged = [{ role: 'user', parts: [{ text: currentUserText }] }];
  }
  return merged;
}

/** 中文註解：OpenAI Chat Completions 用的多輪訊息（不含 system） */
function buildOpenAiMessages(priorHistory, currentUserText) {
  const slice = priorHistory.slice(-32);
  const out = slice.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  out.push({ role: 'user', content: currentUserText });
  return out;
}

async function fetchDuckDuckGo(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 4000);
  try {
    // 中文註解：避免 Vercel Hobby 10 秒上限被慢速外網拖滿
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    const snippets = [];

    if (data.AbstractText) {
      snippets.push({
        title: data.Heading || 'DuckDuckGo 摘要',
        snippet: data.AbstractText,
        source: data.AbstractURL || 'https://duckduckgo.com',
      });
    }

    const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    for (const item of topics.slice(0, 6)) {
      if (item.Text) {
        snippets.push({
          title: item.FirstURL || 'DuckDuckGo',
          snippet: item.Text,
          source: item.FirstURL || 'https://duckduckgo.com',
        });
      }
      if (Array.isArray(item.Topics)) {
        for (const sub of item.Topics.slice(0, 2)) {
          if (sub.Text) {
            snippets.push({
              title: sub.FirstURL || 'DuckDuckGo',
              snippet: sub.Text,
              source: sub.FirstURL || 'https://duckduckgo.com',
            });
          }
        }
      }
    }

    return snippets.slice(0, 6);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/** 中文註解：判斷是否像「打到一半」的句子，避免把完整短問句（例如九個字的文化題）誤判 */
function isProbablyFragment(message) {
  const t = String(message || '').trim();
  if (t.length <= 2) return true;
  if (/^(我和|我們在|然後|怎麼辦|在嗎)$/u.test(t)) return true;
  // 例如「我和客戶在」這種明顯未完句
  if (/^我和[^，。！？、；\n]{0,12}$/u.test(t) && t.length < 14) return true;
  return false;
}

async function callOpenAI({ system, messages, user, model, maxTokens, temperature }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'NO_OPENAI_KEY' };

  const chatMessages =
    Array.isArray(messages) && messages.length > 0
      ? [{ role: 'system', content: system }, ...messages]
      : [
          { role: 'system', content: system },
          { role: 'user', content: user || '' },
        ];

  const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      temperature: temperature ?? 0.85,
      max_tokens: maxTokens ?? 1800,
      messages: chatMessages,
    }),
  });

  if (!openaiResp.ok) {
    const detail = await openaiResp.text();
    return { ok: false, error: detail.slice(0, 2000) };
  }

  const data = await openaiResp.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) return { ok: false, error: 'EMPTY_REPLY' };
  return { ok: true, reply, provider: 'openai' };
}

/** 中文註解：Google Gemini（Generative Language API）；contents 為多輪 user/model */
async function callGemini({ system, contents, model, maxTokens, temperature }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: 'NO_GEMINI_KEY' };

  const modelId = model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  if (!Array.isArray(contents) || !contents.length) {
    return { ok: false, error: 'EMPTY_GEMINI_CONTENTS' };
  }
  const bodyContents = contents;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: bodyContents,
      generationConfig: {
        temperature: temperature ?? 0.85,
        maxOutputTokens: maxTokens ?? 1800,
      },
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    return { ok: false, error: detail.slice(0, 2000) };
  }

  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts;
  const reply = Array.isArray(parts)
    ? parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim()
    : '';
  if (!reply) return { ok: false, error: 'EMPTY_REPLY' };
  return { ok: true, reply, provider: 'gemini' };
}

async function runCoachChat(event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const message = String(body.message || '').trim();
    const userEmail = String(body.user_email || '').trim().toLowerCase();
    const accessCode = String(body.access_code || '').trim();
    const history = Array.isArray(body.history) ? body.history : [];
    const localContext = Array.isArray(body.local_context) ? body.local_context : [];

    if (!message) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing message' }),
      };
    }

    // 中文註解：通行碼優先，未設才用 email 白名單
    const envAccessCode = String(process.env.APP_ACCESS_CODE || '').trim();
    if (envAccessCode) {
      if (!accessCode || accessCode !== envAccessCode) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'ACCESS_CODE_INVALID' }),
        };
      }
    } else {
      const approvedRaw = process.env.APPROVED_EMAILS || '';
      const approvedList = approvedRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!userEmail || !approvedList.includes(userEmail)) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'EMAIL_NOT_APPROVED' }),
        };
      }
    }

    // 中文註解：僅在「明顯打到一半」時才用補問模板（勿再用字元長度誤傷中文完整問句）
    if (isProbablyFragment(message)) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reply: `我先接住你目前的情境。\n\n你這句看起來還沒講完，為了給你精準可用的下一句，請補兩件事：\n1) 場景（商務／約會／朋友／家庭）\n2) 你想達成的結果（成交／破冰／修復／避免尷尬）\n\n你也可以直接貼完整情境，我就照你的題目回答。`,
          web_used: false,
        }),
      };
    }

    // 中文註解：最多兩次外網查詢，降低逾時風險（Vercel Hobby 約 10 秒）
    let webContext = await fetchDuckDuckGo(message);
    if (!webContext.length) {
      const q2 = /文化|禮儀|習慣|用餐|餐桌|國家|法國|日本|歐美|歷史|定義/u.test(message)
        ? `${message} 說明 重點`
        : `${message} wiki`;
      webContext = await fetchDuckDuckGo(q2);
    }

    const system = getMaenadsSystemPrompt();
    const priorHistory = normalizeHistoryExcludingLatestUser(history, message);
    const currentUserText = buildContextualUserMessage(message, localContext, webContext);
    const geminiContents = buildGeminiContents(priorHistory, currentUserText);
    const openAiMessages = buildOpenAiMessages(priorHistory, currentUserText);

    // 中文註解：預設走 Gemini；可設 LLM_PROVIDER=openai 改為先 OpenAI
    let provider = String(process.env.LLM_PROVIDER || 'gemini').toLowerCase();
    if (provider === 'anthropic') provider = 'gemini';

    const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    // 中文註解：預設 gemini-2.0-flash（多數 AI Studio 金鑰可用）；付費可設 GEMINI_MODEL=gemini-1.5-pro 等
    let geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

    let llmResult;
    if (provider === 'gemini') {
      llmResult = await callGemini({
        system,
        contents: geminiContents,
        model: geminiModel,
        maxTokens: 8192,
        temperature: 0.85,
      });
      // 中文註解：若指定模型不可用（404 等），自動改試 2.0 flash
      const errTxt = String(llmResult.error || '');
      if (
        !llmResult.ok &&
        process.env.GEMINI_API_KEY &&
        geminiModel !== 'gemini-2.0-flash' &&
        /404|NOT_FOUND|not found|invalid|Unsupported|does not exist|PERMISSION/i.test(errTxt)
      ) {
        llmResult = await callGemini({
          system,
          contents: geminiContents,
          model: 'gemini-2.0-flash',
          maxTokens: 8192,
          temperature: 0.85,
        });
      }
      // 中文註解：429／quota／limit:0 時依序改試其他模型（各模型配額分開計，仍可能全失敗）
      const errQuota = String(llmResult.error || '');
      if (
        !llmResult.ok &&
        process.env.GEMINI_API_KEY &&
        /429|RESOURCE_EXHAUSTED|quota|Quota exceeded|limit:\s*0|free_tier/i.test(errQuota)
      ) {
        const tried = new Set([geminiModel]);
        const fallbacks = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-8b', 'gemini-1.5-pro'];
        for (const m of fallbacks) {
          if (tried.has(m)) continue;
          tried.add(m);
          llmResult = await callGemini({
            system,
            contents: geminiContents,
            model: m,
            maxTokens: 8192,
            temperature: 0.85,
          });
          if (llmResult.ok) break;
        }
      }
      if (!llmResult.ok && process.env.OPENAI_API_KEY) {
        llmResult = await callOpenAI({
          system,
          messages: openAiMessages,
          model: openaiModel,
          maxTokens: 1800,
          temperature: 0.85,
        });
      }
    } else {
      llmResult = await callOpenAI({
        system,
        messages: openAiMessages,
        model: openaiModel,
        maxTokens: 1800,
        temperature: 0.85,
      });
      if (!llmResult.ok && process.env.GEMINI_API_KEY) {
        llmResult = await callGemini({
          system,
          contents: geminiContents,
          model: geminiModel,
          maxTokens: 8192,
          temperature: 0.85,
        });
        const errO = String(llmResult.error || '');
        if (
          !llmResult.ok &&
          geminiModel !== 'gemini-2.0-flash' &&
          /404|NOT_FOUND|not found|invalid|Unsupported|does not exist|PERMISSION/i.test(errO)
        ) {
          llmResult = await callGemini({
            system,
            contents: geminiContents,
            model: 'gemini-2.0-flash',
            maxTokens: 8192,
            temperature: 0.85,
          });
        }
      }
    }

    const hasAnyLlmKey = !!(process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
    if (!llmResult.ok && !hasAnyLlmKey) {
      const localTop =
        localContext[0]?.answer ||
        '我先依你的問題做重點整理；若你能再補「場景」與「目標」，我可以給更貼身的話術版本。';
      const webLine = webContext[0]?.snippet
        ? `\n\n參考公開資料摘要：${webContext[0].snippet}`
        : '';
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reply: `${localTop}${webLine}\n\n你也可以把問題說得更具體（例如：法國正式晚餐的座位與敬酒順序），我會直接給條列說明與實用提醒。`,
          web_used: webContext.length > 0,
          mode: 'local_fallback',
        }),
      };
    }

    if (!llmResult.ok) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Upstream API error', detail: String(llmResult.error || '').slice(0, 2000) }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reply: llmResult.reply,
        web_used: webContext.length > 0,
        web_refs: webContext.slice(0, 3),
        llm: llmResult.provider || provider,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Function failed', detail: err.message }),
    };
  }
}

module.exports = { runCoachChat };
