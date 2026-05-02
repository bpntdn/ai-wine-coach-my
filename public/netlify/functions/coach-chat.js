exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const { message } = JSON.parse(event.body || "{}");
    if (!message || !String(message).trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing message" }),
      };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          reply:
            "目前雲端即時教練尚未啟用，請先在 Netlify 環境變數設定 OPENAI_API_KEY。現在先用本地教練模式回覆你。",
          followup: "有沒有解決你的問題？你還想知道什麼？",
        }),
      };
    }

    // 中文註解：以教練口吻回答，保持可執行與引導式對話
    const prompt = `
你是「AI葡萄酒社交教練」。
請用繁體中文（台灣）回答，語氣專業、自然、有同理心。
規則：
1) 先回答用戶問題，不要離題。
2) 若情境是商務/關係/餐酒，給可執行建議（步驟化）。
3) 盡量引導到葡萄酒社交策略。
4) 回答結尾加一句追問：「有沒有解決你的問題？你還想知道什麼？」
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: `${prompt}\n\n使用者問題：${String(message).trim()}`,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Upstream API error",
          detail: errorText,
        }),
      };
    }

    const data = await response.json();
    const reply =
      data.output_text ||
      data.output?.[0]?.content?.[0]?.text ||
      "我先幫你整理重點策略。";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply,
        followup: "有沒有解決你的問題？你還想知道什麼？",
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Function failed",
        detail: err.message,
      }),
    };
  }
};
