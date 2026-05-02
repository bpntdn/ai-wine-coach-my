async function fetchDuckDuckGo(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
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

function buildPrompt({ message, history, localContext, webContext }) {
  const safeHistory = Array.isArray(history) ? history.slice(-8) : [];
  const safeLocal = Array.isArray(localContext) ? localContext.slice(0, 3) : [];
  const safeWeb = Array.isArray(webContext) ? webContext.slice(0, 6) : [];

  return {
    system: `你是「AI葡萄酒社交教練」，同時也是一位像 ChatGPT 一樣的通用助理。

請全程使用繁體中文（台灣），語氣自然、有邏輯、像真人對話。

【題型判斷】
1) 若使用者問的是文化、禮儀、歷史、地理、用餐習慣、語言、一般知識、定義解釋等：請直接回答該主題，條理清楚（可用小標與列點），先給準確內容，不要硬套商務話術模板。
2) 若使用者問的是社交、談判、約會、飯局、破冰、選酒、話術等：再使用「下一句可說的話 + 多方案策略 + 一句反問」的教練格式。
3) 若題目同時涉及文化與社交（例如法國約會餐桌禮儀）：先講文化與禮儀重點，再自然補一段「若你要用在實際約會／商務餐桌」的應用建議即可。

【網路片段】
若有提供網路搜尋片段，可斟酌引用；若與問題無關就不要硬塞。可在結尾用一句話說明「以上綜合常見公開資料整理」。

【禁止】
- 不要對已經完整的問題（例如文化關鍵字問句）回覆「請先補場景與目標」這類離題套版，除非使用者句子明顯只打一半。`,
    user: `【使用者問題】
${message}

【近幾輪對話】
${JSON.stringify(safeHistory, null, 2)}

【內建知識檢索（可能相關，可忽略）】
${JSON.stringify(safeLocal, null, 2)}

【網路搜尋片段（可能相關）】
${JSON.stringify(safeWeb, null, 2)}

請輸出自然長文回答，不要輸出 JSON。`,
  };
}

async function callOpenAI({ system, user, model, maxTokens, temperature }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'NO_OPENAI_KEY' };

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
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
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

async function callAnthropic({ system, user, model, maxTokens, temperature }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: 'NO_ANTHROPIC_KEY' };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model || 'claude-3-5-sonnet-20241022',
      max_tokens: maxTokens ?? 1800,
      temperature: temperature ?? 0.85,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    return { ok: false, error: detail.slice(0, 2000) };
  }

  const data = await resp.json();
  const textBlock = Array.isArray(data.content)
    ? data.content.find((b) => b.type === 'text')
    : null;
  const reply = textBlock?.text?.trim();
  if (!reply) return { ok: false, error: 'EMPTY_REPLY' };
  return { ok: true, reply, provider: 'anthropic' };
}

exports.handler = async (event) => {
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

    // 中文註解：文化／知識題加強查詢詞，其餘維持原問句
    let webContext = await fetchDuckDuckGo(message);
    if (!webContext.length && /文化|禮儀|習慣|用餐|餐桌|國家|法國|日本|歐美|歷史|定義/u.test(message)) {
      webContext = await fetchDuckDuckGo(`${message} 說明 重點`);
    }
    if (!webContext.length) {
      webContext = await fetchDuckDuckGo(`${message} wiki`);
    }

    const prompt = buildPrompt({ message, history, localContext, webContext });

    const provider = String(process.env.LLM_PROVIDER || 'openai').toLowerCase();
    const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';

    let llmResult;
    if (provider === 'anthropic') {
      llmResult = await callAnthropic({
        system: prompt.system,
        user: prompt.user,
        model: anthropicModel,
        maxTokens: 1800,
        temperature: 0.85,
      });
      if (!llmResult.ok) {
        llmResult = await callOpenAI({
          system: prompt.system,
          user: prompt.user,
          model: openaiModel,
          maxTokens: 1800,
          temperature: 0.85,
        });
      }
    } else {
      llmResult = await callOpenAI({
        system: prompt.system,
        user: prompt.user,
        model: openaiModel,
        maxTokens: 1800,
        temperature: 0.85,
      });
      if (!llmResult.ok && process.env.ANTHROPIC_API_KEY) {
        llmResult = await callAnthropic({
          system: prompt.system,
          user: prompt.user,
          model: anthropicModel,
          maxTokens: 1800,
          temperature: 0.85,
        });
      }
    }

    const apiKeyOpenAI = process.env.OPENAI_API_KEY;
    if (!llmResult.ok && !apiKeyOpenAI) {
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
        llm: llmResult.provider || 'openai',
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Function failed', detail: err.message }),
    };
  }
};
