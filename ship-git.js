#!/usr/bin/env node
/**
 * 中文註解：git add → commit → push，觸發 Vercel（Git 綁定時）自動部署。
 *
 * 手動（一律嘗試提交）：  npm run ship
 * 自訂訊息：             COMMIT_MSG='fix: UI' npm run ship
 *
 * Cursor Hook 模式（僅在專案根目錄存在 .cursor/auto-ship-on 時才會 push）：
 *   node ship-git.js --hook
 *
 * 注意：GitHub Desktop 本身不會監聽檔案自動 commit；若要「Agent 結束就推」請建立開關檔並啟用 .cursor/hooks.json。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
process.chdir(ROOT);

const hookMode = process.argv.includes('--hook');
if (hookMode && !fs.existsSync(path.join(ROOT, '.cursor', 'auto-ship-on'))) {
  process.exit(0);
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', encoding: 'utf8' });
}

try {
  const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
  if (!status) {
    console.error('[ship-git] 工作區無變更，跳過 commit／push');
    process.exit(0);
  }

  run('git add -A');
  const msg =
    process.env.COMMIT_MSG ||
    `chore: ship ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;

  try {
    run(`git commit -m ${JSON.stringify(msg)}`);
  } catch {
    console.error('[ship-git] git commit 失敗（檢查 git user.name／email，或已無新變更可提交）');
    process.exit(1);
  }

  run('git push');
  console.error('[ship-git] 已 push。若 Vercel 已連結此 repo，約 1～2 分鐘後重新整理網頁即可。');
} catch (e) {
  console.error('[ship-git]', e.message || e);
  process.exit(1);
}
