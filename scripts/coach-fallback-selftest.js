#!/usr/bin/env node
/**
 * 中文註解：離線「總模擬」 — 把 coach-quality-batch.js 的 25 題餵給 buildEmergencyReply
 * 然後用同一套 hints 計分，回報「假如雲端 LLM 全掛、整站只剩 fallback」這個下界分數。
 *
 * 這個數字代表：即使 OpenAI 額度爆 + Gemini rate limit 全失效，使用者拿到的回覆品質保證。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 中文註解：抽出 buildEmergencyReply 函式（用 Function 建構子避免 strict-mode eval 作用域問題）
const coachSrc = fs.readFileSync(path.join(ROOT, 'api/coach-chat.js'), 'utf8');
const fnStart = coachSrc.indexOf('function buildEmergencyReply');
const fnEnd = coachSrc.indexOf('function loadMaenadsSystemPrompt');
const fnSrc = coachSrc.slice(fnStart, fnEnd);
const buildEmergencyReply = new Function(fnSrc + '\nreturn buildEmergencyReply;')();

// 中文註解：載入測試題庫
const batchSrc = fs.readFileSync(path.join(ROOT, 'scripts/coach-quality-batch.js'), 'utf8');
const casesStart = batchSrc.indexOf('const CASES =');
const casesEnd = batchSrc.indexOf('\nfunction checkCase');
const casesSrc = batchSrc.slice(casesStart, casesEnd);
const CASES = new Function(casesSrc + '\nreturn CASES;')();

// 中文註解：與 batch 一致的計分函式（簡化重寫，避免 require 整個檔）
function checkCase(reply, hints) {
  const text = String(reply || '');
  const wc = text.length;
  const issues = [];
  let score = 1;
  if (hints.mustMentionAll) {
    for (const re of hints.mustMentionAll) {
      if (!re.test(text)) {
        issues.push(`必提:${re}`);
        score -= 0.3;
      }
    }
  }
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
      issues.push('預期方向未命中');
      score -= 0.18;
    }
  }
  if (hints.wordCountRange) {
    const [lo, hi] = hints.wordCountRange;
    if (wc < lo) {
      issues.push(`太短(${wc}<${lo})`);
      score -= 0.15;
    } else if (wc > hi) {
      issues.push(`太長(${wc}>${hi})`);
      score -= 0.15;
    }
  }
  return { score: Math.max(0, score), issues, wc };
}

function main() {
  console.log('離線 fallback 總模擬（共', CASES.length, '題）\n');

  const rows = [];
  for (const c of CASES) {
    // 中文註解：多輪題目把 messages 當 priorHistory 餵入
    const priorHistory = Array.isArray(c.messages)
      ? c.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }))
      : [];
    const reply = buildEmergencyReply(c.message, priorHistory);
    const { score, issues, wc } = checkCase(reply, c.hints);
    rows.push({ id: c.id, cat: c.cat, score, issues, wc, replyHead: reply.slice(0, 80) });
    const tag = score >= 0.85 ? 'OK  ' : score >= 0.7 ? 'WARN' : 'FAIL';
    console.log(
      `[${tag}] ${c.id.padEnd(36)} cat=${(c.cat || '').padEnd(6)}  score=${score.toFixed(2)} wc=${wc} ${
        issues.length ? '| ' + issues.slice(0, 2).join(' | ') : ''
      }`,
    );
  }

  const avg = rows.reduce((a, r) => a + r.score, 0) / rows.length;
  const byCat = {};
  const cnt = {};
  for (const r of rows) {
    byCat[r.cat] = (byCat[r.cat] || 0) + r.score;
    cnt[r.cat] = (cnt[r.cat] || 0) + 1;
  }
  for (const k of Object.keys(byCat)) byCat[k] = byCat[k] / cnt[k];

  console.log('\n=== 摘要 ===');
  console.log(`fallback 下界平均: ${avg.toFixed(3)} / 1.00`);
  Object.entries(byCat).forEach(([k, v]) => console.log(`  ${k}: ${v.toFixed(2)}`));

  const fails = rows.filter((r) => r.score < 0.85);
  if (fails.length) {
    console.log('\n=== 仍未達 0.85 的題（待後續 fallback 補強）===');
    fails.sort((a, b) => a.score - b.score);
    fails.forEach((r) => {
      console.log(`  [${r.score.toFixed(2)}] ${r.id} ${r.issues.join(' | ')}`);
      console.log(`    回覆首段: ${r.replyHead}`);
    });
  } else {
    console.log('\n✅ 全部 25 題 fallback 也能拿到 ≥0.85');
  }
}

main();
