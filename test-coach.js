#!/usr/bin/env node
/**
 * 中文註解：本機呼叫 /api/coach-chat（Vercel 或本機 dev），快速確認通行碼與 Gemini。
 * 需 Node.js 18+（內建 fetch）。
 *
 * 用法：
 *   ACCESS_CODE=你的通行碼 COACH_URL=https://你的專案.vercel.app/api/coach-chat node test-coach.js
 *   ACCESS_CODE=xxx node test-coach.js 商務場合如何選酒比較安全
 */

const COACH_URL = process.env.COACH_URL || '';
const ACCESS_CODE = process.env.ACCESS_CODE || process.env.APP_ACCESS_CODE || '';

async function main() {
  if (!COACH_URL) {
    // 中文註解：整合測試需要明確指定可連線的 API，避免在 CI/離線環境誤判失敗。
    console.error('⏭️ 略過 test:coach：尚未設定 COACH_URL（例如 https://你的網域/api/coach-chat）');
    console.error('   範例：COACH_URL=http://127.0.0.1:3000/api/coach-chat npm run test:coach');
    process.exit(0);
  }

  const message =
    process.argv.slice(2).join(' ').trim() || '請用繁體中文簡短自我介紹，並列出你能協助的三類主題。';

  const payload = {
    message,
    access_code: ACCESS_CODE,
    user_email: process.env.USER_EMAIL || '',
    messages: [],
    local_context: [],
  };

  console.error(`→ POST ${COACH_URL}`);
  console.error(`→ message: ${message.slice(0, 120)}${message.length > 120 ? '…' : ''}`);
  if (!ACCESS_CODE) {
    console.error('→ （未設 ACCESS_CODE：若站台有設 APP_ACCESS_CODE，將會 403）');
  }

  const res = await fetch(COACH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }

  console.log(`← HTTP ${res.status}`);
  if (data.reply) {
    console.log('--- reply ---');
    console.log(data.reply);
    console.log('--- meta ---');
    console.log(JSON.stringify({ web_used: data.web_used, mode: data.mode, llm: data.llm }, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
