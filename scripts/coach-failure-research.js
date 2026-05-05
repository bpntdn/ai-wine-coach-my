#!/usr/bin/env node
/**
 * 中文註解：針對 quality 報告中的低分題，自動做公開資料補強研究，輸出到 reports/。
 *
 * 用法：
 *   node scripts/coach-failure-research.js
 *   COACH_RESEARCH_MAX=10 COACH_RESEARCH_THRESHOLD=0.75 node scripts/coach-failure-research.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

if (typeof fetch !== 'function') {
  console.error('請使用 Node.js 18 以上（內建 fetch）');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports');
const MAX_ITEMS = Math.max(1, parseInt(process.env.COACH_RESEARCH_MAX || '8', 10) || 8);
const FAIL_THRESHOLD = Number(process.env.COACH_RESEARCH_THRESHOLD || '0.78');
const FETCH_TIMEOUT_MS = Math.max(
  2000,
  parseInt(process.env.COACH_RESEARCH_FETCH_MS || '5500', 10) || 5500,
);

function listQualityJsonFiles() {
  if (!fs.existsSync(REPORT_DIR)) return [];
  return fs
    .readdirSync(REPORT_DIR)
    .filter((n) => /^quality-.*\.json$/.test(n))
    .map((n) => path.join(REPORT_DIR, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function readLatestQualityReport() {
  const files = listQualityJsonFiles();
  if (!files.length) return null;
  const latest = files[0];
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(latest, 'utf8'));
  } catch (e) {
    throw new Error(`quality 報告解析失敗：${latest} :: ${e.message}`);
  }
  return { path: latest, data };
}

function pickFailures(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .filter((r) => {
      const score = typeof r.score === 'number' ? r.score : 0;
      const issues = Array.isArray(r.issues) ? r.issues.join(' ') : '';
      return (
        score < FAIL_THRESHOLD ||
        /上游模型不可用|無 reply|網路錯誤|觸發禁則|必提未命中|預期方向未命中/.test(issues)
      );
    })
    .sort((a, b) => (a.score || 0) - (b.score || 0))
    .slice(0, MAX_ITEMS);
}

function buildSearchQuery(row) {
  const msg = String((row && row.message) || '').replace(/\s+/g, ' ').trim();
  if (!msg) return 'business etiquette conversation tips';
  return `${msg} 文化 禮儀 重點`;
}

async function fetchDuckDuckGo(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
    query,
  )}&format=json&no_html=1&skip_disambig=1`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    if (data.AbstractText) {
      out.push({
        title: data.Heading || '摘要',
        snippet: String(data.AbstractText).slice(0, 280),
        source: data.AbstractURL || 'https://duckduckgo.com',
      });
    }
    const related = Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [];
    for (const t of related) {
      if (out.length >= 4) break;
      if (t && typeof t.Text === 'string' && t.Text.trim()) {
        out.push({
          title: t.FirstURL || 'RelatedTopic',
          snippet: t.Text.slice(0, 280),
          source: t.FirstURL || 'https://duckduckgo.com',
        });
      }
      if (Array.isArray(t && t.Topics)) {
        for (const k of t.Topics) {
          if (out.length >= 4) break;
          if (k && typeof k.Text === 'string' && k.Text.trim()) {
            out.push({
              title: k.FirstURL || 'Topic',
              snippet: k.Text.slice(0, 280),
              source: k.FirstURL || 'https://duckduckgo.com',
            });
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(tid);
  }
}

function makeSuggestion(row, refs) {
  const issues = Array.isArray(row.issues) ? row.issues : [];
  const suggest = [];
  if (issues.some((x) => /必提未命中|預期方向未命中/.test(x))) {
    suggest.push('在 prompt 增加此題型的「必提元素」與關鍵詞，避免答非所問。');
  }
  if (issues.some((x) => /觸發禁則/.test(x))) {
    suggest.push('在 prompt 明示禁則優先級，並提供安全替代句型。');
  }
  if (issues.some((x) => /上游模型不可用|無 reply|網路錯誤/.test(x))) {
    suggest.push('優先排查 Vercel/Gemini 配額與可用性，避免把可用性問題誤判為 prompt 問題。');
  }
  if (!suggest.length) {
    suggest.push('先以失敗題關鍵詞補強 prompt，再跑回歸確認是否提升。');
  }

  const refsLine = refs.length
    ? refs
        .slice(0, 2)
        .map((r) => `${r.snippet}`)
        .join(' / ')
    : '（未取得公開片段）';

  return { suggest, refsLine };
}

function writeReport(inputPath, failures, analyses) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(REPORT_DIR, `research-${stamp}.json`);
  const mdPath = path.join(REPORT_DIR, `research-${stamp}.md`);

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceReport: inputPath,
    failThreshold: FAIL_THRESHOLD,
    maxItems: MAX_ITEMS,
    count: analyses.length,
    analyses,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

  let md = '# 梅娜斯失敗題研究補強報告\n\n';
  md += `- 來源報告：\`${path.basename(inputPath)}\`\n`;
  md += `- 失敗門檻：score < ${FAIL_THRESHOLD}\n`;
  md += `- 研究題數：${analyses.length}\n\n`;
  if (!analyses.length) {
    md += '本輪未檢出需研究的失敗題。\n';
  } else {
    analyses.forEach((a, idx) => {
      md += `## ${idx + 1}. ${a.id}（score=${(a.score || 0).toFixed(2)}）\n\n`;
      md += `問題：${a.message}\n\n`;
      md += `失敗原因：${(a.issues || []).join('；') || '—'}\n\n`;
      md += `補強建議：${a.suggest.join(' ')}\n\n`;
      md += `公開片段：${a.refsLine}\n\n`;
      md += `---\n\n`;
    });
  }
  fs.writeFileSync(mdPath, md, 'utf8');

  console.error(`→ research JSON ${jsonPath}`);
  console.error(`→ research MD   ${mdPath}`);
}

async function main() {
  const latest = readLatestQualityReport();
  if (!latest) {
    console.error('[research] 找不到 quality-*.json，略過');
    process.exit(0);
  }

  const rows = latest.data && Array.isArray(latest.data.rows) ? latest.data.rows : [];
  const failures = pickFailures(rows);
  console.error(
    `[research] source=${path.basename(latest.path)} rows=${rows.length} failures=${failures.length}`,
  );

  const analyses = [];
  for (const row of failures) {
    const query = buildSearchQuery(row);
    const refs = await fetchDuckDuckGo(query);
    const enriched = makeSuggestion(row, refs);
    analyses.push({
      id: row.id,
      score: row.score,
      message: row.message,
      issues: row.issues || [],
      query,
      refs,
      suggest: enriched.suggest,
      refsLine: enriched.refsLine,
    });
  }

  writeReport(latest.path, failures, analyses);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

