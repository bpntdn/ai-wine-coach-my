#!/usr/bin/env node
/**
 * 中文註解：無需網路、不呼叫 Gemini；驗證 api/coach-history.js 與 coach-chat 組裝邏輯一致。
 */
'use strict';

const assert = require('assert');
const {
  normalizeHistoryExcludingLatestUser,
  compactGeminiContents,
  clampHistoryMaxTurns,
  buildGeminiContents,
} = require('../api/coach-history.js');

function testNormalizeStripsDupTail() {
  const h = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'hello' },
  ];
  const out = normalizeHistoryExcludingLatestUser(h, 'hello');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].content, 'b');
}

function testClampTurns() {
  assert.strictEqual(clampHistoryMaxTurns('12'), 12);
  assert.strictEqual(clampHistoryMaxTurns('3'), 4);
  assert.strictEqual(clampHistoryMaxTurns('99'), 48);
  assert.strictEqual(clampHistoryMaxTurns('oops'), 12);
}

function testCompactMergesSameRole() {
  const merged = compactGeminiContents([
    { role: 'user', parts: [{ text: 'a' }] },
    { role: 'user', parts: [{ text: 'b' }] },
    { role: 'model', parts: [{ text: 'x' }] },
  ]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].parts[0].text, 'a\n\nb');
}

function testBuildRespectsMaxTurns() {
  const prior = [];
  for (let i = 0; i < 10; i++) {
    prior.push({ role: 'user', content: `u${i}` });
    prior.push({ role: 'assistant', content: `a${i}` });
  }
  const contents = buildGeminiContents(prior, 'CURRENT', 4);
  const texts = contents.map((c) => c.parts[0].text);
  assert.ok(texts[texts.length - 1].includes('CURRENT'));
  // 中文註解：最後一則為本輪 user；其前最多 4 則「輪」來自 prior（compact 後段落數會 ≤ 歷史長度）
  assert.ok(contents.length >= 2);
  assert.ok(texts.some((t) => t.includes('u9')));
  assert.ok(!texts.some((t) => t.includes('u0')));
}

function testLeadingModelDropped() {
  const prior = [{ role: 'assistant', content: 'orphan' }];
  const contents = buildGeminiContents(prior, 'hi', 12);
  assert.strictEqual(contents[0].role, 'user');
  assert.strictEqual(contents[0].parts[0].text, 'hi');
}

function main() {
  testNormalizeStripsDupTail();
  testClampTurns();
  testCompactMergesSameRole();
  testBuildRespectsMaxTurns();
  testLeadingModelDropped();
  console.error('[coach-chat-unit-selftest] 5 組斷言通過');
}

main();
