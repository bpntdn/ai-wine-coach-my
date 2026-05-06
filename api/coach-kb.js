/**
 * 中文註解：RAG 第一版——在後端做輕量關鍵字檢索，補充可引用的在地知識片段。
 * 先用低風險規則化資料，後續可替換為向量資料庫。
 */
'use strict';

const KB_ROWS = [
  {
    id: 'dating-reunion',
    tags: ['初戀', '久未見面', '尷尬', '破冰', '約會'],
    text:
      '久未見面先「降壓」：先聊近況與共同記憶，不急著談感情結論。前 15 分鐘保持輕話題，觀察對方節奏再決定是否進入深聊。',
  },
  {
    id: 'business-dinner',
    tags: ['商務', '客戶', '飯局', '合作', '談判'],
    text:
      '商務餐敘優先順序：先建立信任，再談需求，最後確認下一步。避免一開始就報價，先對齊目標與成功條件。',
  },
  {
    id: 'wine-safe-choice',
    tags: ['選酒', '白酒', '紅酒', '搭餐', '新手'],
    text:
      '不確定場合時，先選清爽且容錯高的風格。辛辣食物可考慮偏果香或微甜白酒；重口紅肉再考慮酒體較厚的紅酒。',
  },
  {
    id: 'social-boundary',
    tags: ['界線', '拒絕', '灌酒', '壓力', '禮貌'],
    text:
      '遇到壓力場景可用「先肯定＋再界線＋給替代方案」：先表達感謝，再說身體或行程限制，最後提供可接受替代方案。',
  },
];

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function retrieveCoachContext(query, topK) {
  const q = String(query || '');
  const qLower = q.toLowerCase();
  const qTokens = tokenize(q);
  const limit = Math.max(1, Math.min(5, Number(topK || 3)));
  const scored = KB_ROWS.map((row) => {
    let score = 0;
    for (const tag of row.tags) {
      const t = tag.toLowerCase();
      if (qLower.includes(t)) score += 3;
      for (const tok of qTokens) {
        if (t.includes(tok) || tok.includes(t)) score += 1;
      }
    }
    return { ...row, score };
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((r) => ({
    id: r.id,
    text: r.text,
    tags: r.tags,
    score: r.score,
  }));
}

module.exports = {
  retrieveCoachContext,
};

