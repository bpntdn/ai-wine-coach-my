#!/usr/bin/env node
/**
 * 中文註解：後台循環呼叫 coach-prompt-eval（嚴格模式），把結果附加寫入 reports/autopilot.ndjson。
 * 無法自動「修正模型回答內容」或替你 push（需本機憑證）；請搭配 GitHub Actions 或本機長跑 tmux。
 *
 * 環境變數：
 *   COACH_AUTOPILOT_INTERVAL_SEC — 每輪間隔秒數，預設 900（15 分鐘）
 *   COACH_URL、ACCESS_CODE — 與 eval 相同
 *
 * 用法：
 *   ACCESS_CODE=xxx node scripts/coach-autopilot.js           # 無限循環
 *   ACCESS_CODE=xxx node scripts/coach-autopilot.js --once    # 只跑一輪，繼承 exit code
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports');
const LOG_FILE = path.join(REPORT_DIR, 'autopilot.ndjson');

const INTERVAL_SEC = Math.max(
  60,
  Number(process.env.COACH_AUTOPILOT_INTERVAL_SEC || '900'),
);
const ONCE = process.argv.includes('--once');

function sleepSync(seconds) {
  try {
    execSync(`sleep ${Number(seconds)}`, { stdio: 'ignore' });
  } catch {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {}
  }
}

function appendReport(record) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, 'utf8');
}

function runEvalCycle() {
  const ts = new Date().toISOString();
  const env = {
    ...process.env,
    COACH_EVAL_STRICT: '1',
  };

  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'coach-prompt-eval.js')], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 12 * 1024 * 1024,
  });

  const record = {
    ts,
    exitCode: r.status,
    signal: r.signal,
    stdoutTail: (r.stdout || '').slice(-6000),
    stderrTail: (r.stderr || '').slice(-2000),
  };
  appendReport(record);

  return r.status;
}

function main() {
  if (!process.env.ACCESS_CODE && !process.env.APP_ACCESS_CODE) {
    console.error('[coach-autopilot] 請設定 ACCESS_CODE（或 APP_ACCESS_CODE），否則評測會失敗。');
    process.exit(1);
  }

  console.error(
    `[coach-autopilot] ROOT=${ROOT} 間隔=${INTERVAL_SEC}s strict=1 紀錄=${LOG_FILE}`,
  );

  if (ONCE) {
    const code = runEvalCycle();
    process.exit(code === 0 ? 0 : code == null ? 1 : code);
  }

  for (;;) {
    const code = runEvalCycle();
    console.error(`[coach-autopilot] 輪次結束 exit=${code}，${INTERVAL_SEC}s 後再跑`);
    sleepSync(INTERVAL_SEC);
  }
}

main();
