#!/usr/bin/env node
/**
 * 中文註解：自動驗證循環入口 — 先跑無網路單元測試；若設 COACH_URL 與 ACCESS_CODE 再跑 scripts/coach-prompt-eval.js。
 * 用法：node scripts/coach-verify-loop.js
 * 嚴格：COACH_EVAL_STRICT=1 node scripts/coach-verify-loop.js
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function runNode(relScript, extraEnv) {
  const scriptPath = path.join(ROOT, relScript);
  const r = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status ?? 1;
}

function main() {
  const u = runNode('scripts/coach-chat-unit-selftest.js');
  if (u !== 0) {
    console.error('[coach-verify-loop] 單元測試失敗，停止。');
    process.exit(u);
  }

  const url = (process.env.COACH_URL || '').trim();
  const code = (process.env.ACCESS_CODE || process.env.APP_ACCESS_CODE || '').trim();
  if (!url || !code) {
    console.error(
      '[coach-verify-loop] 未同時設定 COACH_URL 與 ACCESS_CODE（或 APP_ACCESS_CODE），略過遠端 API 測試。',
    );
    console.error(
      '  範例：COACH_URL=https://ai.winemaenads.com/api/coach-chat ACCESS_CODE=*** node scripts/coach-verify-loop.js',
    );
    process.exit(0);
  }

  const e = runNode('scripts/coach-prompt-eval.js');
  if (e !== 0) {
    console.error('[coach-verify-loop] coach-prompt-eval 失敗（可設 COACH_EVAL_STRICT=0 僅看輸出）。');
    process.exit(e);
  }
  console.error('[coach-verify-loop] 單元 + 遠端 eval 完成');
  process.exit(0);
}

main();
