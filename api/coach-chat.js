const { runCoachChat } = require('../netlify/functions/coach-chat-shared');

/** 中文註解：Vercel Serverless 進入點；與 Netlify 共用 runCoachChat */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const out = await runCoachChat({ httpMethod: 'POST', body: rawBody });
    res.status(out.statusCode);
    const headers = out.headers || {};
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }
    if (typeof out.body === 'string') {
      return res.send(out.body);
    }
    return res.json(out.body);
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: 'Function failed', detail: err.message });
  }
};
