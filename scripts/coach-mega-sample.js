#!/usr/bin/env node
/**
 * 中文註解：大量「抽樣」呼叫 coach API，粗分排序後輸出最差 N 題與 prompt 人工修正備忘。
 *
 * ⚠️ 關於「每天 50,000 題」：
 * - 每一題至少 1 次 generateContent，50k／日會撞上速率限制、帳單與 Vercel 逾時，實務上不可行。
 * - 本腳本預設上限 500；超過需環境變數確認（見下方）。若真要長期大規模請改：多日分批 + 付費配額 + 自建 runner。
 *
 * 環境變數：
 *   COACH_URL、ACCESS_CODE（必填）
 *   COACH_MEGA_CAP — 題數上限，預設 200
 *   COACH_MEGA_WORST — 報告列出最差幾題，預設 10
 *   COACH_MEGA_DELAY_MS — 每題間隔毫秒，預設 350（降 429）
 *   COACH_MEGA_ALLOW_LARGE=1 — 允許 CAP 最高 5000
 *   COACH_I_ACCEPT_LONG_RUN=1 — CAP 最高 15000（仍遠低於 50k／日；請自行承擔費用）
 *
 * 用法：
 *   ACCESS_CODE=xxx COACH_URL=https://…/api/coach-chat node scripts/coach-mega-sample.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

if (typeof fetch !== 'function') {
  console.error('請使用 Node.js 18+');
  process.exit(1);
}

const COACH_URL =
  process.env.COACH_URL || 'https://ai-wine-coach-my.vercel.app/api/coach-chat';
const ACCESS_CODE = process.env.ACCESS_CODE || process.env.APP_ACCESS_CODE || '';

let CAP = Math.max(1, parseInt(process.env.COACH_MEGA_CAP || '200', 10) || 200);
const WORST_N = Math.max(1, parseInt(process.env.COACH_MEGA_WORST || '10', 10) || 10);
const DELAY_MS = Math.max(0, parseInt(process.env.COACH_MEGA_DELAY_MS || '350', 10) || 0);

const ALLOW_LARGE = process.env.COACH_MEGA_ALLOW_LARGE === '1';
const ACCEPT_LONG = process.env.COACH_I_ACCEPT_LONG_RUN === '1';

/** 中文註解：硬性縮 cap，避免不小心刷爆額度 */
function clampCap(n) {
  let x = n;
  if (!ALLOW_LARGE && x > 500) {
    console.error('[mega] CAP>500 需設 COACH_MEGA_ALLOW_LARGE=1，已降至 500');
    x = 500;
  }
  if (ALLOW_LARGE && !ACCEPT_LONG && x > 5000) {
    console.error('[mega] CAP>5000 需 COACH_I_ACCEPT_LONG_RUN=1，已降至 5000');
    x = 5000;
  }
  if (ACCEPT_LONG && x > 15000) {
    console.error('[mega] 單次run上限 15000；若要更多請分批多日執行');
    x = 15000;
  }
  return x;
}

CAP = clampCap(CAP);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function checkCase(reply, hints) {
  if (!hints) return { score: 1, issues: [] };
  const text = String(reply || '');
  const issues = [];
  let score = 1;
  if (hints.failIfIncludes) {
    for (const re of hints.failIfIncludes) {
      if (re.test(text)) {
        issues.push(`禁則:${re}`);
        score -= 0.35;
      }
    }
  }
  if (hints.preferIncludes) {
    const ok = hints.preferIncludes.some((re) => re.test(text));
    if (!ok) {
      issues.push('未命中偏好關鍵');
      score -= 0.22;
    }
  }
  return { score: Math.max(0, score), issues };
}

/** 中文註解：組合題庫（可再擴充） */
function buildQuestionPool() {
  const regions = ['日本', '韓國', '法國', '捷克', '德國', '台灣'];
  const occasions = ['客戶晚宴', '部門聚餐', '初次拜訪供應商', '婚禮敬酒'];
  const wines = ['夏多內', '黑皮諾', '赤霞珠', '麗絲玲'];
  const pool = [];

  for (const r of regions) {
    for (const o of occasions) {
      pool.push({
        id: `rg-${r}-${o}`,
        message: `下週在${r}有場${o}，我是外地人，有什麼容易踩雷的餐桌／敬酒細節？請用繁體中文條列重點。`,
        hints: {
          preferIncludes: [new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))],
          failIfIncludes: [/^\s*#/m],
        },
      });
    }
  }

  for (const w of wines) {
    pool.push({
      id: `wine-${w}`,
      message: `請用兩句話向新手說明「${w}」喝起來大概什麼個性，順便給一個安全搭餐方向。`,
      hints: {
        preferIncludes: [/酸|單寧|酒體|果香|清爽|厚實|搭配|餐/i],
      },
    });
  }

  const moods = ['很緊張', '怕被冷落', '怕被灌酒'];
  for (const m of moods) {
    pool.push({
      id: `psych-${m}`,
      message: `公司尾牙我${m}，想提早離場又不想得罪長官，怎麼說比較妥當？給我可直接用的說法。`,
      hints: {
        preferIncludes: [/可以先|不好意思|身體|明天|感謝/i],
        failIfIncludes: [/確診|心理疾病$/],
      },
    });
  }

  const gens = ['數學', '行程規劃', '英文 email'];
  for (const g of gens) {
    pool.push({
      id: `general-${g}`,
      message:
        g === '數學'
          ? '365 除以 7 的餘數是多少？只要答案一句話，不要談葡萄酒。'
          : g === '行程規劃'
            ? '我要安排三天兩夜台東親子行，請給極簡行程骨架（三段標題即可），不要談酒。'
            : '請把這句翻成禮貌英文：「想跟您約下週二下午電話，十五分鐘可以嗎？」不要談酒。',
      hints: {
        failIfIncludes: [/Pinot|波爾多|夏布利|香檳/i],
      },
    });
  }

  const rivals = ['競品業務', '嚴格的主管'];
  for (const rv of rivals) {
    pool.push({
      id: `nego-${rv}`,
      message: `與${rv}同桌，他一直打壓我們方案，我想把球打回去又不失禮，怎麼接話？`,
      hints: {
        preferIncludes: [/我理解|先確認|換個角度|資料|下一步/i],
      },
    });
  }

  return pool;
}

function shuffle(arr, seedStr) {
  const s = String(seedStr || Date.now());
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const j = h % (i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/** 中文註解：題庫小時透過輕微尾綴循環擴充，避免同一天 CAP 大於種子數時無題可抽 */
function expandPoolTo(basePool, targetN) {
  const out = [];
  let round = 0;
  while (out.length < targetN) {
    const batch = shuffle(basePool.slice(), `mega-${round}`);
    const suffix =
      round === 0 ? '' : `\n\n【請仍完整作答；這是抽樣第 ${round} 輪變體。】`;
    for (const q of batch) {
      out.push({
        ...q,
        id: `${q.id}__v${round}__${out.length}`,
        message: q.message + suffix,
        hints: q.hints,
      });
      if (out.length >= targetN) break;
    }
    round++;
    if (round > 5000) throw new Error('expandPoolTo 異常迴圈');
  }
  return out.slice(0, targetN);
}

async function runOne(q) {
  const payload = {
    message: q.message,
    access_code: ACCESS_CODE,
    user_email: process.env.USER_EMAIL || '',
    messages: Array.isArray(q.messages) ? q.messages : [],
    local_context: [],
  };

  const res = await fetch(COACH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  const reply = data && typeof data.reply === 'string' ? data.reply : '';
  let score = 0;
  let issues = ['HTTP 或非 JSON'];

  if (res.ok && reply.trim()) {
    const ck = checkCase(reply, q.hints);
    score = ck.score;
    issues = ck.issues;
  }

  return {
    id: q.id,
    http: res.status,
    score,
    issues,
    message: q.message,
    replyPreview: reply.slice(0, 420) + (reply.length > 420 ? '…' : ''),
    detail: data && data.detail ? String(data.detail).slice(0, 300) : '',
  };
}

function writeReports(summaryRows, worst) {
  const dir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(dir, `mega-report-${stamp}.json`);
  const mdPath = path.join(dir, `mega-report-${stamp}.md`);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), cap: CAP, rows: summaryRows }, null, 2),
    'utf8',
  );

  let md = `# 梅娜斯 mega-sample 報告\n\n`;
  md += `- 執行時間（UTC）：${new Date().toISOString()}\n`;
  md += `- 抽樣題數：${summaryRows.length}（上限設定 ${CAP}）\n`;
  md += `- **最差 ${worst.length} 題（粗分低→高）**\n\n`;
  md += `> 粗分僅為規則／關鍵字代理指標，請你一定人工讀全文後再改 \`maenads_system_prompt.md\`。\n\n`;

  worst.forEach((w, i) => {
    md += `## ${i + 1}. ${w.id}（score=${w.score.toFixed(2)} HTTP=${w.http}）\n\n`;
    md += `**問：** ${w.message.replace(/\n/g, ' ')}\n\n`;
    md += `**Issues：** ${w.issues.join('；') || '—'}\n\n`;
    md += `**答片段：**\n\n${w.replyPreview}\n\n`;
    md += `**Prompt 修正備忘（請人工取捨）：** 檢查 system prompt 是否涵蓋此題型；若為國別題確認「對國作答」；若為通用題確認勿灌酒；若 HTTP≠200 先修部署／金鑰／逾時而非改 prompt。\n\n---\n\n`;
  });

  fs.writeFileSync(mdPath, md, 'utf8');
  console.error(`→ JSON ${jsonPath}`);
  console.error(`→ MD   ${mdPath}`);
}

async function main() {
  console.error(`→ COACH_URL=${COACH_URL}`);
  console.error(`→ CAP=${CAP} WORST_N=${WORST_N} DELAY_MS=${DELAY_MS}`);
  console.error(
    '[mega] 提醒：50,000 題／日本腳本無法替你自動 deploy；請於本機 git push 觸發 Vercel。',
  );

  if (!ACCESS_CODE) {
    console.error('請設定 ACCESS_CODE');
    process.exit(1);
  }

  const base = buildQuestionPool();
  const pool = expandPoolTo(base, CAP);
  const slice = shuffle(pool, process.env.COACH_MEGA_SEED || '').slice(0, CAP);
  const rows = [];

  let i = 0;
  for (const q of slice) {
    i++;
    process.stderr.write(`\r[mega] ${i}/${slice.length} ${q.id}`.padEnd(60));
    const row = await runOne(q);
    rows.push(row);
    if (DELAY_MS) await sleep(DELAY_MS);
  }
  process.stderr.write('\n');

  rows.sort((a, b) => a.score - b.score || a.http - b.http);
  const worst = rows.slice(0, WORST_N);

  console.log('\n=== 最差', WORST_N, '題（摘要）===');
  worst.forEach((w) => {
    console.log(w.score.toFixed(2), w.http, w.id, w.issues.join('|'));
  });

  writeReports(rows, worst);

  const avg = rows.reduce((s, r) => s + r.score, 0) / rows.length;
  console.error(`\n平均粗分 ${avg.toFixed(3)}（抽樣 ${rows.length}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
