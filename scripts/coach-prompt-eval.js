#!/usr/bin/env node
/**
 * 中文註解：批次呼叫 /api/coach-chat，粗評回答是否符合梅娜斯規則（關鍵字／禁則）。
 *
 * 用法（專案根目錄）：
 *   ACCESS_CODE=xxx COACH_URL=https://…/api/coach-chat node scripts/coach-prompt-eval.js
 *
 * 若未設 COACH_URL，預設為 test-coach.js 同款預設網址。
 *
 * 嚴格模式（CI／自動監看用）：任一案例 HTTP 非 200、無 reply、或 score 低於門檻 → process.exit(1)
 *   COACH_EVAL_STRICT=1 node scripts/coach-prompt-eval.js
 *   node scripts/coach-prompt-eval.js --strict
 *
 * 擴充廣測（含多輪對話模擬）：
 *   COACH_EVAL_FULL=1 ACCESS_CODE=xxx node scripts/coach-prompt-eval.js
 */

// 中文註解：需 Node.js 18+（內建 fetch）
if (typeof globalThis.fetch !== 'function') {
  console.error('請使用 Node.js 18 以上執行本腳本。');
  process.exit(1);
}

const COACH_URL =
  process.env.COACH_URL || 'https://ai.winemaenads.com/api/coach-chat';
const ACCESS_CODE = process.env.ACCESS_CODE || process.env.APP_ACCESS_CODE || '';

const EVAL_STRICT =
  process.env.COACH_EVAL_STRICT === '1' ||
  process.argv.includes('--strict');

/** 中文註解：嚴格模式下低於此分數視為失敗（粗分 0～1） */
const STRICT_MIN_SCORE = Number(process.env.COACH_EVAL_MIN_SCORE || '0.79');

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
  {
    id: 'biz-big-client-meal',
    message: '如何讓大客戶主動在餐敘上談合作的生意',
    hints: {
      failIfIncludes: [/請先補場景與目標/],
      preferIncludes: [/客戶|合作|餐|飯局|信任|節奏|時機|提案|利害|下一步|第一|第二/i],
    },
  },
];

/** 中文註解：廣泛／多輪情境（預設 CI 不跑，COACH_EVAL_FULL=1 才跑） */
const EXTRA_CASES = [
  {
    id: 'multiturn-ex-followup',
    message: '如何做？',
    messages: [
      {
        role: 'user',
        content: '跟前女友約會，推薦餐廳和酒款？',
      },
      {
        role: 'assistant',
        content:
          '先把目標想清楚：你想製造輕鬆、無壓力的對話，還是想確認彼此想法？餐酒上可以選中性口味、方便對話的環境；若要細講我可以依照預算調整。',
      },
      { role: 'user', content: '如何做？' },
    ],
    hints: {
      preferIncludes: [/先從|第一步|可以試試|例如|具體|選/i],
    },
  },
  {
    id: 'broad-math-tangent',
    message: '365 除以 7 餘數是多少？只用一句話。',
    hints: {
      failIfIncludes: [/Pinot|波爾多/i],
      preferIncludes: [/1|餘/i],
    },
  },
  {
    id: 'broad-toast-zh-tw',
    message: '敬酒杯時有什麼話術比較不尷尬？給我兩個版本（長輩／同事）。',
    hints: {
      preferIncludes: [/長輩|同事|敬|先/i],
    },
  },
];

function getCasesToRun() {
  if (process.env.COACH_EVAL_FULL === '1') {
    console.error('→ COACH_EVAL_FULL=1：追加廣測 ' + EXTRA_CASES.length + ' 例');
    return CASES.concat(EXTRA_CASES);
  }
  return CASES;
}

const UPSTREAM_FALLBACK_RE =
  /線路不穩|沒能把你的句子完整接進沙龍|沙龍尚在準備中|離線教練模式接住你/;

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
    messages: Array.isArray(c.messages) ? c.messages : [],
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
  const finishReason = data && data.finishReason ? String(data.finishReason) : '';
  const detail =
    data.detail && typeof data.detail === 'string' ? data.detail.slice(0, 400) : '';
  const fallback =
    res.ok &&
    reply &&
    (String(data.provider || '') === 'fallback' ||
      String(data.mode || '') === 'fallback' ||
      UPSTREAM_FALLBACK_RE.test(reply) ||
      /UPSTREAM_UNAVAILABLE|NO_API_KEY|HANDLER_EXCEPTION|CLIENT_FALLBACK_EMPTY/.test(finishReason));
  const check = fallback
    ? { score: 0, issues: ['上游模型不可用（備援文案）'] }
    : res.ok && reply
      ? checkCase(reply, c)
      : { score: 0, issues: ['無 reply 或非 200'] };

  return {
    id: c.id,
    http: res.status,
    score: check.score,
    issues: check.issues,
    replyPreview: reply.slice(0, 280) + (reply.length > 280 ? '…' : ''),
    errorDetail: !res.ok || !reply ? detail : '',
    finishReason,
  };
}

async function main() {
  console.error(`→ COACH_URL=${COACH_URL}`);
  if (!ACCESS_CODE) console.error('→ 警告：未設 ACCESS_CODE，若站台有通行碼將大量 403');

  const rows = [];
  const suite = getCasesToRun();
  for (const c of suite) {
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

  if (EVAL_STRICT) {
    const bad = rows.filter(
      (r) => r.http !== 200 || !r.replyPreview || r.score < STRICT_MIN_SCORE,
    );
    if (bad.length) {
      console.error(
        `\n[COACH_EVAL_STRICT] 失敗 ${bad.length}/${rows.length} 例（門檻 score≥${STRICT_MIN_SCORE} 且 HTTP 200 有 reply）`,
      );
      bad.forEach((r) =>
        console.error(`  - ${r.id} http=${r.http} score=${r.score.toFixed(2)}`),
      );
      process.exit(1);
    }
    console.error('\n[COACH_EVAL_STRICT] 全數通過');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
