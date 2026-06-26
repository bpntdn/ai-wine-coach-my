/**
 * 中文註解：主題閘門——僅允許葡萄酒／社交教練相關問題，離題則不呼叫 LLM（省算力）。
 */
'use strict';

/** 中文註解：明確離題（學科、日常採買、無關生活問題等） */
const OFF_TOPIC_PATTERNS = [
  /微積分|calculus|導數|積分|極限|微分|線性代數|矩陣|機率論|統計學作業|大學.*作業/iu,
  /物理作業|化學方程式|牛頓定律|相對論|量子力學/iu,
  /程式碼|寫程式|python|javascript|java|debug|leetcode|演算法題/iu,
  /股票技術分析|加密貨幣|比特幣|炒幣|期貨操作/iu,
  /寫論文|文獻回顧|apa格式|mla格式/iu,
  /翻譯整篇文章|幫我寫作業|解這題|證明題|幾何證明|考試|期中考|期末考/iu,
  /醫療診斷|開藥|處方|是不是癌症|手術建議/iu,
  /法律訴訟|起草合約|律師意見/iu,
  /菜市場|傳統市場|超市.*買|買水果|水果推薦|蔬菜推薦|青菜|採買清單/iu,
  /今天天氣|穿搭|化妝|美髮|健身食譜|減肥菜單/iu,
];

/** 中文註解：允許範圍——葡萄酒、餐桌、社交、商務、感情互動等 */
const IN_SCOPE_PATTERNS = [
  /葡萄酒|紅酒|白酒|氣泡|香檳|侍酒|品酒|醒酒|單寧|酒體|酸度|風土|terroir/iu,
  /餐酒|搭餐|配酒|選酒|送酒|送禮.*酒|酒款|產區|葡萄品種|merlot|cabernet|chardonnay|pinot/iu,
  /梅洛|卡本內|夏多內|黑皮諾|里奧哈|波爾多|勃艮第|納帕|costco|好市多|大潤發|全聯/iu,
  /商務|客戶|飯局|聚餐|破冰|敬酒|乾杯|碰杯|名片|禮儀|國際禮儀|商務餐敘/iu,
  /社交|聚會|人際|尷尬|冷場|聊天|話題|i人|內向|慢熱|社恐/iu,
  /約會|曖昧|感情|伴侶|男女關係|復合|冷戰|修復|好感|續攤|邀約/iu,
  /日本|韓國|中東|穆斯林|清真|跨文化|職場聚餐/iu,
  /牛排|麻辣|火鍋|烤鴨|omakase|日料|海鮮/iu,
];

const SHORT_ACK = /^(好|好的|ok|OK|嗯|嗯嗯|對|是|收到|了解|謝謝|感謝|繼續|可以)$/u;

function joinHistoryText(priorHistory, message) {
  const parts = [];
  if (Array.isArray(priorHistory)) {
    for (const m of priorHistory) {
      const t = String((m && m.content) || '').trim();
      if (t) parts.push(t);
    }
  }
  const latest = String(message || '').trim();
  if (latest) parts.push(latest);
  return parts.join('\n');
}

function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

function isTopicGuardEnabled() {
  const raw = String(process.env.COACH_TOPIC_GUARD ?? '1').trim();
  return !/^(0|false|no|off)$/i.test(raw);
}

/**
 * @returns {{ allowed: boolean, reason: string }}
 */
function evaluateCoachTopic(message, priorHistory) {
  const q = String(message || '').trim();
  if (!q) return { allowed: false, reason: 'empty' };

  const historyText = joinHistoryText(priorHistory, '');
  const fullText = joinHistoryText(priorHistory, q);

  // 中文註解：短回覆延續上一輪教練主題時放行
  if (SHORT_ACK.test(q) && historyText && matchesAny(historyText, IN_SCOPE_PATTERNS)) {
    return { allowed: true, reason: 'short_ack_in_scope_thread' };
  }

  if (matchesAny(q, OFF_TOPIC_PATTERNS)) {
    return { allowed: false, reason: 'explicit_off_topic' };
  }

  if (matchesAny(q, IN_SCOPE_PATTERNS) || matchesAny(fullText, IN_SCOPE_PATTERNS)) {
    return { allowed: true, reason: 'in_scope' };
  }

  // 中文註解：含「酒」或明顯場合詞但未命中細項時，仍偏向放行
  if (/酒|餐桌|場合|飯局|聚餐|客戶|約會|社交/u.test(q)) {
    return { allowed: true, reason: 'loose_scope' };
  }

  return { allowed: false, reason: 'out_of_scope' };
}

function isCoachTopicAllowed(message, priorHistory) {
  if (!isTopicGuardEnabled()) return true;
  return evaluateCoachTopic(message, priorHistory).allowed;
}

function buildOffTopicReply(message) {
  const q = String(message || '').trim();
  const preview = q
    ? q.length > 36
      ? `「${q.slice(0, 36)}…」`
      : `「${q}」`
    : '這個問題';

  return (
    '謝謝你願意來找我聊。\n\n' +
    `關於${preview}，這題不在我的服務範圍裡——` +
    '我是梅娜斯葡萄酒社交教練，專門陪你處理下面這些：\n' +
    '• 葡萄酒知識與選酒、餐酒搭配\n' +
    '• 社交禮儀、商務禮儀、國際禮儀\n' +
    '• 約會、感情與人際互動（餐桌與場合相關）\n\n' +
    '像一般生活採買、學科作業、程式、投資、醫療法律等問題，我會禮貌婉拒，也不會動用你的 API 額度去硬答。\n\n' +
    '你可以改問我例如：\n' +
    '• 商務飯局怎麼破冰、敬酒順序怎麼安排\n' +
    '• 約會聚餐怎麼選酒、怎麼聊才不尷尬\n' +
    '• 牛排、麻辣鍋這類菜，配什麼酒比較安全\n\n' +
    '換一個葡萄酒或社交情境的問題，我馬上陪你一起拆解。'
  );
}

module.exports = {
  isTopicGuardEnabled,
  evaluateCoachTopic,
  isCoachTopicAllowed,
  buildOffTopicReply,
};
