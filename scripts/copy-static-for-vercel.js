/**
 * 中文註解：Vercel 建置時只複製 ai/index.html → dist/index.html（單頁 App，不把 backend 當靜態檔公開）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcFile = path.join(root, 'ai', 'index.html');
const destDir = path.join(root, 'dist');

if (!fs.existsSync(srcFile)) {
  console.error('找不到 ai/index.html');
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(srcFile, path.join(destDir, 'index.html'));
console.log('已建立 dist/index.html（供 Vercel 靜態根路徑）');
