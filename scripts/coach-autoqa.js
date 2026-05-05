#!/usr/bin/env node
/**
 * 中文註解：自動問答煙霧測——模擬使用者題目（含截圖曾失敗句），本機直連 Gemini 或打正式 COACH_URL。
 *
 * 本機（與 Vercel 相同 prompt／組裝邏輯）：
 *   GEMINI_API_KEY=xxx node scripts/coach-autoqa.js
 *
 * 正式網址（需通行碼）：
 *   ACCESS_CODE=xxx COACH_URL=https://ai.winemaenads.com/api/coach-chat node scripts/coach-autoqa.js --remote
 *
 * 兩者皆設時會先跑本機再跑遠端。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROMPT_PATH = path.join(ROOT, 'maenads_system_prompt.md');

const { generateGeminiContent } = require(path.join(ROOT, 'api', 'gemini-generate-content.js'));
const {
  normalizeHistoryExcludingLatestUser,
  clampHistoryMaxTurns,
  buildGeminiContents,
} = require(path.join(ROOT, 'api', 'coach-history.js'));

/** 中文註解：含使用者曾回報「拒答／502」與一般 coaching */
const CASES = [
  { id: 'icebreak', message: '給我三句破冰話術，我要照著練', messages: [] },
  {
    id: 'second_round_date',
    message: '我想約她續攤，要怎麼說她才會跟我去？',
    messages: [
      {
        role: 'user',
        content: '跟暗戀對象吃飯，如何表現？',
      },
      {
        role: 'assistant',
        content:
          '你先放輕鬆：語氣慢一點、眼神自然交接就好。選酒可以問她偏好偏清爽或偏果香，當成話題而不是考試。',
      },
    ],
  },
  {
    id: 'biz_wine',
    message: '客戶飯局我想用酒開話題，給我三個不冷場的切入句。',
    messages: [],
  },
];

function loadSystemPrompt() {
  try {
    const t = fs.readFileSync(PROMPT_PATH, 'utf8').trim();
    if (t) return t;
  } catch (e) {
    console.error('[coach-autoqa] 讀不到 maenads_system_prompt.md', e.message);
  }
  process.exit(1);
}

async function runOneLocal(apiKey, systemPrompt, c, maxTurns, maxOut) {
  const prior = normalizeHistoryExcludingLatestUser(c.messages || [], c.message);
  const contents = buildGeminiContents(prior, c.message, maxTurns);
  const result = await generateGeminiContent(apiKey, {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: maxOut,
      topP: 0.95,
    },
  });
  const preview = (result.reply || '').replace(/\s+/g, ' ').slice(0, 140);
  const ok =
    result.ok &&
    typeof result.reply === 'string' &&
    result.reply.length >= 12 &&
    result.finishReason !== 'CLIENT_FALLBACK_EMPTY';
  return { ok, soft: result.ok && result.finishReason === 'CLIENT_FALLBACK_EMPTY', preview, result };
}

async function runLocalAll() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[coach-autoqa] 略過本機：未設 GEMINI_API_KEY');
    return false;
  }
  const systemPrompt = loadSystemPrompt();
  const maxTurns = clampHistoryMaxTurns(process.env.GEMINI_HISTORY_MAX_TURNS);
  const maxOut = Math.min(
    8192,
    Math.max(512, parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '2048', 10) || 2048),
  );

  console.error('\n=== coach-autoqa：本機 Gemini（與 api/coach-chat 相同組裝）===\n');
  let fail = 0;
  for (const c of CASES) {
    const row = await runOneLocal(apiKey, systemPrompt, c, maxTurns, maxOut);
    const tag = row.ok ? 'PASS' : row.soft ? 'SOFT' : 'FAIL';
    if (!row.ok) fail += 1;
    console.log(`[${tag}] ${c.id}`);
    console.log(`  finishReason: ${row.result.finishReason || '—'} model: ${row.result.model || '—'}`);
    console.log(`  preview: ${row.preview}${row.preview.length >= 140 ? '…' : ''}\n`);
  }
  console.error(`摘要：理想 PASS ${CASES.length - fail}/${CASES.length}（SOFT=有回覆但為空回備援文案）`);
  return true;
}

async function runRemoteAll() {
  const url = (process.env.COACH_URL || '').trim();
  const code = (process.env.ACCESS_CODE || process.env.APP_ACCESS_CODE || '').trim();
  if (!url || !code) {
    console.error('[coach-autoqa] 略過遠端：未設 COACH_URL 或 ACCESS_CODE');
    return false;
  }

  console.error('\n=== coach-autoqa：遠端 POST（與瀏覽器相同）===\n');
  let fail = 0;
  for (const c of CASES) {
    const payload = {
      message: c.message,
      access_code: code,
      user_email: process.env.USER_EMAIL || '',
      messages: (c.messages || []).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      local_context: [],
    };
    const res = await fetch(url, {
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
    const preview = reply.replace(/\s+/g, ' ').slice(0, 140);
    const upstreamFallback =
      reply.includes('這一刻線路不穩') || reply.includes('沒能把你的句子完整接進沙龍');
    const ok = res.ok && reply.length >= 12 && !upstreamFallback;
    const soft = res.ok && reply.length >= 12 && upstreamFallback;
    if (!res.ok || !reply.trim()) fail += 1;
    const tag = ok ? 'PASS' : soft ? 'SOFT' : 'FAIL';
    console.log(`[${tag}] ${c.id} HTTP ${res.status}`);
    console.log(`  finishReason: ${data && data.finishReason ? data.finishReason : '—'}`);
    console.log(`  preview: ${preview}${preview.length >= 140 ? '…' : ''}\n`);
  }
  console.error(`摘要：HTTP 200 且有文字 ${CASES.length - fail}/${CASES.length}`);
  return true;
}

async function main() {
  if (typeof fetch !== 'function') {
    console.error('請使用 Node.js 18 以上（內建 fetch）。');
    process.exit(1);
  }

  const remoteOnly = process.argv.includes('--remote');
  let ran = false;

  if (remoteOnly) {
    if (await runRemoteAll()) ran = true;
    else {
      console.error('請設定 COACH_URL 與 ACCESS_CODE');
      process.exit(1);
    }
  } else {
    if (await runLocalAll()) ran = true;
    if (
      process.env.COACH_URL &&
      (process.env.ACCESS_CODE || process.env.APP_ACCESS_CODE)
    ) {
      if (await runRemoteAll()) ran = true;
    }
  }

  if (!ran) {
    console.error(
      '\n請至少設定 GEMINI_API_KEY（本機），或 COACH_URL + ACCESS_CODE（遠端）；遠端強制請加 --remote。',
    );
    process.exit(1);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
