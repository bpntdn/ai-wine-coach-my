/**
 * 中文註解：Vercel 建置時把 ai/ 複製到 public/，讓根路徑能抓到 index.html（修正部署後 404）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'ai');
const dest = path.join(root, 'public');

if (!fs.existsSync(src)) {
  console.error('找不到 ai/ 目錄');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log('已將 ai/ 複製為 public/（Vercel 靜態輸出）');
