async function fetchDuckDuckGo(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) return [];

    const data = await resp.json();
    const snippets = [];

    if (data.AbstractText) {
      snippets.push({ title: data.Heading || 'DuckDuckGo 摘要', snippet: data.AbstractText, source: data.AbstractURL || 'https://duckduckgo.com' });
    }

    const topics = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    for (const item of topics.slice(0, 6)) {
      if (item.Text) {
        snippets.push({ title: item.FirstURL || 'DuckDuckGo', snippet: item.Text, source: item.FirstURL || 'https://duckduckgo.com' });
      }
      if (Array.isArray(item.Topics)) {
        for (const sub of item.Topics.slice(0, 2)) {
          if (sub.Text) {
            snippets.push({ title: sub.FirstURL || 'DuckDuckGo', snippet: sub.Text, source: sub.FirstURL || 'https://duckduckgo.com' });
          }
        }
      }
    }

    return snippets.slice(0, 6);
  } catch {
    return [];
  }
}

function buildPrompt({ message, history, localContext, webContext }) {
  const safeHistory = Array.isArray(history) ? history.slice(-8) : [];
  const safeLocal = Array.isArray(localContext) ? localContext.slice(0, 3) : [];
  const safeWeb = Array.isArray(webContext) ? webContext.slice(0, 6) : [];

  return {
    system: `你是「AI葡萄酒社交教練」。
請全程使用繁體中文（台灣），像真人顧問一樣自然對話。

回答規則：
1) 必須先直接回答使用者當下問題，不能離題。
2) 內容務必具體，優先給「下一句可以直接說的話」與「3 步驟做法」。
3) 若有網路資料，只能作為輔助，不能硬塞無關資訊。
4) 請提供 2~3 個可行方案（清楚列點），並說明各自適用情境與風險。
5) 回答不要太短，至少要有完整分析與執行步驟，避免套版口吻。
6) 結尾一定要有 1 句關鍵反問，幫助使用者補充資訊。
7) 風格要像 ChatGPT：有邏輯、有同理、不重複模板句。`,
    user: `【使用者問題】
${message}

【近幾輪對話】
${JSON.stringify(safeHistory, null, 2)}

【內建知識檢索（可能相關）】
${JSON.stringify(safeLocal, null, 2)}

【網路搜尋片段（可能相關）】
${JSON.stringify(safeWeb, null, 2)}

請輸出自然長文回答，不要輸出 JSON。`
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const message = String(body.message || '').trim();
    const history = Array.isArray(body.history) ? body.history : [];
    const localContext = Array.isArray(body.local_context) ? body.local_context : [];

    if (!message) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing message' })
      };
    }

    // 中文註解：先查使用者原問題，若太少再補強查詢，避免牛頭不對馬嘴
    let webContext = await fetchDuckDuckGo(message);
    if (!webContext.length) {
      webContext = await fetchDuckDuckGo(`${message} 解法 教學`);
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // 中文註解：未設定金鑰時，回傳可用的本地整合答案，而不是空錯誤
      const localTop = localContext[0]?.answer || '我先幫你拆成：場景、目標、對方風格，補這三個資訊我就能給你精準下一句。';
      const webLine = webContext[0]?.snippet ? `

我另外抓到一則網路參考：${webContext[0].snippet}` : '';
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reply: `我先給你完整可用版本：

方案 A（最穩）：先同理再引導
${localTop}

方案 B（效率）：直接給兩個可選方向，降低對方決策壓力
- 先講你可提供的價值，再給「保守版 / 積極版」兩個選項
- 優點：節奏快，適合時間少的場景
- 風險：若對方重情緒，可能覺得你太快切結論

方案 C（關係優先）：先用一個低壓問題打開對話，再進主題
- 先問對方最在意的點（預算、風險、體驗）
- 接住回答後再進入建議
- 優點：更像真人互動，不容易被拒絕

${webLine}

你現在這題最希望達成的是「成交、關係升溫、還是先止血降溫」？我可以立刻幫你改成可直接貼上的版本。`,
          web_used: webContext.length > 0,
          mode: 'local_fallback'
        })
      };
    }

    const prompt = buildPrompt({ message, history, localContext, webContext });
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.9,
        max_tokens: 1400,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ]
      })
    });

    if (!openaiResp.ok) {
      const detail = await openaiResp.text();
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Upstream API error', detail: detail.slice(0, 2000) })
      };
    }

    const data = await openaiResp.json();
    const reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Empty model reply' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reply,
        web_used: webContext.length > 0,
        web_refs: webContext.slice(0, 3)
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Function failed', detail: err.message })
    };
  }
};
