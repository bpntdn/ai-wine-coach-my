const { runCoachChat } = require('./coach-chat-shared');

/** 中文註解：Netlify 進入點，邏輯在 coach-chat-shared（與 Vercel 共用） */
exports.handler = async (event) => runCoachChat(event);
