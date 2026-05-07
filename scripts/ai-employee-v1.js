#!/usr/bin/env node
/**
 * 中文註解：AI 員工 v1 — 每次執行會做三件事：
 * 1) 檢查正式 API 是否接上雲端模型（llm_live）
 * 2) 執行小型品質抽測（coach-prompt-eval）
 * 3) 產出一份可讀報告（reports/ai-employee-v1-*.md + latest）
 *
 * 用法：
 *   ACCESS_CODE=xxx COACH_URL=https://ai.winemaenads.com/api/coach-chat node scripts/ai-employee-v1.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports');
const COACH_URL = process.env.COACH_URL || 'https://ai.winemaenads.com/api/coach-chat';
const ACCESS_CODE = process.env.ACCESS_CODE || process.env.APP_ACCESS_CODE || '';

function runNodeScript(relPath, extraEnv) {
  const scriptPath = path.join(ROOT, relPath);
  const r = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

async function probeProduction() {
  if (!ACCESS_CODE) {
    return {
      ok: false,
      reason: 'NO_ACCESS_CODE',
      note: '未設定 ACCESS_CODE / APP_ACCESS_CODE，無法探測正式站。',
    };
  }
  try {
    const resp = await fetch(COACH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        message: '商務社交破冰，給我三句可直接照說的開場',
        access_code: ACCESS_CODE,
        user_email: process.env.USER_EMAIL || '',
        messages: [],
        local_context: [],
      }),
    });
    const raw = await resp.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    const mode = data && data.mode ? String(data.mode) : '';
    const provider = data && data.provider ? String(data.provider) : '';
    const detail = data && typeof data.detail === 'string' ? data.detail.slice(0, 500) : '';
    const replyPreview =
      data && typeof data.reply === 'string'
        ? data.reply.replace(/\s+/g, ' ').slice(0, 220)
        : '';
    const ok = resp.ok && mode === 'llm_live' && provider !== 'fallback';
    return {
      ok,
      status: resp.status,
      mode,
      provider,
      model: data && data.model ? String(data.model) : '',
      finishReason: data && data.finishReason ? String(data.finishReason) : '',
      detail,
      replyPreview,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'FETCH_FAILED',
      note: String(err && err.message ? err.message : err),
    };
  }
}

function buildActions(probe) {
  const actions = [];
  if (probe.ok) {
    actions.push('正式站已連上雲端模型，可持續跑品質迴歸。');
    return actions;
  }
  if (probe.reason === 'NO_ACCESS_CODE') {
    actions.push('先設定 ACCESS_CODE（需與 Vercel APP_ACCESS_CODE 一致）。');
    return actions;
  }
  const d = String(probe.detail || '');
  if (/NO_OPENAI_KEY/i.test(d)) {
    actions.push('Vercel Production 新增 OPENAI_API_KEY，並 Redeploy。');
    actions.push('建議同時設定 OPENAI_FIRST=1 與 OPENAI_MODEL=gpt-4o-mini。');
  }
  if (/RESOURCE_EXHAUSTED|limit:\s*0|429/i.test(d)) {
    actions.push('Gemini 免費層已觸頂：降低測試頻率，或啟用 OpenAI 作為主力。');
  }
  if (/404|NOT_FOUND/i.test(d)) {
    actions.push('目前模型代號在該專案不可用：固定 GEMINI_MODEL 為可用型號。');
  }
  if (!actions.length) {
    actions.push('請先檢查 Vercel 環境變數是否套用到 Production，再 Redeploy。');
  }
  return actions;
}

function writeReport(probe, evalRun) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(REPORT_DIR, `ai-employee-v1-${stamp}.md`);
  const latestPath = path.join(REPORT_DIR, 'ai-employee-v1-latest.md');
  const actions = buildActions(probe);

  let md = '# AI 員工 v1 執行報告\n\n';
  md += `- 時間（UTC）：${new Date().toISOString()}\n`;
  md += `- COACH_URL：${COACH_URL}\n\n`;
  md += '## 1) 正式站連線狀態\n\n';
  md += `- ok：${probe.ok ? 'true' : 'false'}\n`;
  if (probe.status != null) md += `- HTTP：${probe.status}\n`;
  if (probe.mode) md += `- mode：${probe.mode}\n`;
  if (probe.provider) md += `- provider：${probe.provider}\n`;
  if (probe.model) md += `- model：${probe.model}\n`;
  if (probe.finishReason) md += `- finishReason：${probe.finishReason}\n`;
  if (probe.note) md += `- note：${probe.note}\n`;
  if (probe.detail) md += `- detail：${probe.detail}\n`;
  if (probe.replyPreview) md += `- replyPreview：${probe.replyPreview}\n`;

  md += '\n## 2) 品質抽測（coach-prompt-eval）\n\n';
  md += `- exit code：${evalRun.code}\n`;
  if (evalRun.stdout.trim()) {
    md += '\n```text\n' + evalRun.stdout.slice(0, 4000) + '\n```\n';
  }
  if (evalRun.stderr.trim()) {
    md += '\n```text\n' + evalRun.stderr.slice(0, 2000) + '\n```\n';
  }

  md += '\n## 3) 下一步（自動建議）\n\n';
  actions.forEach((x) => {
    md += `- ${x}\n`;
  });

  fs.writeFileSync(outPath, md, 'utf8');
  fs.writeFileSync(latestPath, md, 'utf8');
  return { outPath, latestPath };
}

async function main() {
  console.error('[ai-employee-v1] 開始執行');
  const probe = await probeProduction();
  const evalRun = runNodeScript('scripts/coach-prompt-eval.js', {
    COACH_URL,
    ACCESS_CODE,
  });
  const report = writeReport(probe, evalRun);
  console.error(`[ai-employee-v1] 報告已寫入: ${report.outPath}`);
  console.error(`[ai-employee-v1] 最新摘要: ${report.latestPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[ai-employee-v1] failed:', err);
  process.exit(1);
});

