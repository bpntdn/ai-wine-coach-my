const { runCoachChat } = require('../netlify/functions/coach-chat-shared');

/** 中文註解：Vercel 將請求 body 轉成可給 runCoachChat 的 JSON 字串 */
function bodyToJsonString(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body != null && typeof req.body === 'object') return JSON.stringify(req.body);
  return '{}';
}

/** 中文註解：Vercel Serverless 進入點；與 Netlify 共用 runCoachChat */
module.exports = async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawBody = bodyToJsonString(req);
    const out = await runCoachChat({ httpMethod: 'POST', body: rawBody });
    res.status(out.statusCode);
    const headers = { ...cors, ...(out.headers || {}) };
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }
    if (typeof out.body === 'string') {
      return res.send(out.body);
    }
    return res.json(out.body);
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(500).json({ error: 'Function failed', detail: err.message });
  }
};
