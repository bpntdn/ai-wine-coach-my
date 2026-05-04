#!/usr/bin/env node
/**
 * 中文註解：批次呼叫 /api/coach-chat，粗評回答是否符合梅娜斯規則（關鍵字／禁則）。
 *
 * 用法（專案根目錄）：
 *   ACCESS_CODE=xxx COACH_URL=https://…/api/coach-chat node scripts/coach-prompt-eval.js
 *
 * 若未設 COACH_URL，預設為 test-coach.js 同款預設網址。
 */

// 中文註解：需 Node.js 18+（內建 fetch）
if (typeof globalThis.fetch !== 'function') {
  console.error('請使用 Node.js 18 以上執行本腳本。');
  process.exit(1);
}

const COACH_URL =
  process.env.COACH_URL || 'https://ai-wine-coach-my.vercel.app/api/coach-chat';
const ACCESS_CODE = process.env.ACCESS_CODE || process.env.APP_ACCESS_CODE || '';

/** 中文註解：測項：題目 + 簡易通過條件（僅供迴歸參考，非嚴格評分） */
const CASES = [
  {
    id: 'general-no-wine-spam',
    message: '請用一句話解釋什麼是「認知偏誤」，不要舉酒類例子。',
    hints: {
      failIfIncludes: [/^\s*[-*#]/m, /Pinot|波爾多|勃根地|Riesling/i],
      preferIncludes: [/認知/i],
    },
  },
  {
    id: 'wine-pairing-on-topic',
    message: '友人約麻辣鍋聚餐，我不確定要帶什麼酒當伴手禮比較安全？',
    hints: {
      preferIncludes: [/甜|Riesling|白酒|微甜|避免.*單寧|不適合.*紅/i],
    },
  },
  {
    id: 'social-coaching-shape',
    message:
      '客戶飯局上對方一直聊八卦閒聊，我想談專案但不想撕破臉，怎麼開口比較自然？',
    hints: {
      preferIncludes: [/我可以|要不要|先說|比如說|下一步/i],
      failIfIncludes: [/請先補場景與目標/],
    },
  },
  {
    id: 'culture-precision',
    message: '捷克一般社交場合初次見面，常見的問候或距離感大概怎麼把握？請勿混進法國慣例。',
    hints: {
      preferIncludes: [/捷克/],
      failIfIncludes: [/法國.*握手.*捷克|把法國當捷克/i],
    },
  },
  {
    id: 'psych-boundary',
    message: '我常常在社交場合緊張到手心冒汗，這算心理疾病嗎？你可以怎麼陪我理清下一步？',
    hints: {
      failIfIncludes: [/你是.*強迫症|確診為|精神科醫師認定/i],
      preferIncludes: [/不能替代|不是診斷|無法診斷|不構成診斷|專業|身心科|心理師|精神科/i],
    },
  },
];

function checkCase(reply, { hints }) {
  const text = String(reply || '');
  const issues = [];
  let score = 1;

  if (hints.failIfIncludes) {
    for (const re of hints.failIfIncludes) {
      if (re.test(text)) {
        issues.push(`觸發禁則 ${re}`);
        score -= 0.35;
      }
    }
  }
  if (hints.preferIncludes) {
    const ok = hints.preferIncludes.some((re) => re.test(text));
    if (!ok) {
      issues.push('未命中預期關鍵方向（可能仍合理，請人工複覽）');
      score -= 0.2;
    }
  }

  return { score: Math.max(0, score), issues };
}

async function runOne(c) {
  const payload = {
    message: c.message,
    access_code: ACCESS_CODE,
    user_email: process.env.USER_EMAIL || '',
    messages: [],
    local_context: [],
  };

  const res = await fetch(COACH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { _raw: raw.slice(0, 400) };
  }

  const reply = data.reply || '';
  const detail =
    data.detail && typeof data.detail === 'string' ? data.detail.slice(0, 400) : '';
  const check = res.ok && reply ? checkCase(reply, c) : { score: 0, issues: ['無 reply 或非 200'] };

  return {
    id: c.id,
    http: res.status,
    score: check.score,
    issues: check.issues,
    replyPreview: reply.slice(0, 280) + (reply.length > 280 ? '…' : ''),
    errorDetail: !res.ok || !reply ? detail : '',
  };
}

async function main() {
  console.error(`→ COACH_URL=${COACH_URL}`);
  if (!ACCESS_CODE) console.error('→ 警告：未設 ACCESS_CODE，若站台有通行碼將大量 403');

  const rows = [];
  for (const c of CASES) {
    const row = await runOne(c);
    rows.push(row);
    console.log('\n========', row.id, 'HTTP', row.http, 'score', row.score.toFixed(2), '========');
    if (row.issues.length) console.log('issues:', row.issues.join(' | '));
    if (row.errorDetail) console.log('detail:', row.errorDetail);
    console.log(row.replyPreview);
  }

  const avg = rows.reduce((a, r) => a + r.score, 0) / rows.length;
  console.log('\n=== 摘要 ===');
  console.log('平均粗分:', avg.toFixed(2), '/ 1.00');
  console.log('（粗分僅供 prompt 迭代參考；請務必人工讀全文）');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
