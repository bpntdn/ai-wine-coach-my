/**
 * 中文註解：每月問答次數上限（需 Vercel KV 或 Upstash Redis REST）。
 * 環境變數（擇一組即可）：
 *   KV_REST_API_URL + KV_REST_API_TOKEN（Vercel KV）
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * 可調：COACH_MONTHLY_QUESTION_LIMIT（預設 30）、COACH_MONTHLY_QUOTA=0 關閉
 */
'use strict';

const crypto = require('crypto');

function isQuotaEnabled() {
  const raw = String(process.env.COACH_MONTHLY_QUOTA ?? '1').trim();
  return !/^(0|false|no|off)$/i.test(raw);
}

function getRedisConfig() {
  const url = (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ''
  ).replace(/\/$/, '');
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) return null;
  return { url, token };
}

function getMonthlyLimit() {
  const n = parseInt(String(process.env.COACH_MONTHLY_QUESTION_LIMIT || '30'), 10);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(500, n);
}

function monthKeyUtc() {
  return new Date().toISOString().slice(0, 7);
}

/** 中文註解：辨識單一使用者——優先信箱，其次前端 client_id，最後 IP */
function buildUserQuotaId({ userEmail, clientId, req }) {
  const email = String(userEmail || '')
    .trim()
    .toLowerCase();
  if (email && email.includes('@')) {
    return 'email:' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);
  }
  const cid = String(clientId || '').trim();
  if (cid.length >= 8 && cid.length <= 80) {
    return 'cid:' + cid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  }
  const ip =
    (req &&
      (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '')
        .toString()
        .split(',')[0]
        .trim()) ||
    '';
  if (ip) {
    return 'ip:' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24);
  }
  return '';
}

async function redisCommand(pathSuffix) {
  const cfg = getRedisConfig();
  if (!cfg) return { ok: false, missing: true };
  const resp = await fetch(`${cfg.url}${pathSuffix}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!resp.ok) {
    return { ok: false, error: `HTTP ${resp.status}` };
  }
  const data = await resp.json();
  return { ok: true, result: data.result };
}

async function redisGet(key) {
  const r = await redisCommand(`/get/${encodeURIComponent(key)}`);
  if (!r.ok) return r;
  const n = parseInt(String(r.result ?? '0'), 10);
  return { ok: true, value: Number.isFinite(n) ? n : 0 };
}

async function redisIncr(key) {
  return redisCommand(`/incr/${encodeURIComponent(key)}`);
}

async function redisExpire(key, seconds) {
  return redisCommand(`/expire/${encodeURIComponent(key)}/${seconds}`);
}

function buildQuotaExceededReply(limit, used) {
  return (
    '謝謝你這個月這麼認真使用梅娜斯教練。\n\n' +
    `你本月的教練問答已達 ${used}/${limit} 題上限，為了讓每位學員都能公平使用，請下個月再來，或把想問的題目先整理成 1～2 個重點。\n\n` +
    '若你是正式學員需要加開額度，請加入官方 LINE「葡萄酒女神梅娜斯Maenads」，由小幫手協助你。'
  );
}

/**
 * @returns {Promise<{allowed:boolean, used:number, limit:number, configured:boolean, userId:string}>}
 */
async function consumeMonthlyQuestionQuota({ userEmail, clientId, req }) {
  const limit = getMonthlyLimit();
  const userId = buildUserQuotaId({ userEmail, clientId, req });
  if (!isQuotaEnabled()) {
    return { allowed: true, used: 0, limit, configured: false, userId };
  }
  if (!userId) {
    return { allowed: true, used: 0, limit, configured: false, userId: '' };
  }
  if (!getRedisConfig()) {
    // 中文註解：未接 KV 時不阻擋學員，但標記未設定（部署時應補上）
    return { allowed: true, used: 0, limit, configured: false, userId };
  }

  const redisKey = `coach:quota:${monthKeyUtc()}:${userId}`;
  const current = await redisGet(redisKey);
  if (!current.ok) {
    return { allowed: true, used: 0, limit, configured: true, userId, degraded: true };
  }
  if (current.value >= limit) {
    return {
      allowed: false,
      used: current.value,
      limit,
      configured: true,
      userId,
    };
  }

  const inc = await redisIncr(redisKey);
  if (!inc.ok) {
    return { allowed: true, used: current.value, limit, configured: true, userId, degraded: true };
  }
  const used = parseInt(String(inc.result ?? current.value + 1), 10) || current.value + 1;
  if (used === 1) {
    await redisExpire(redisKey, 60 * 60 * 24 * 40);
  }
  return { allowed: true, used, limit, configured: true, userId };
}

module.exports = {
  isQuotaEnabled,
  getMonthlyLimit,
  buildUserQuotaId,
  consumeMonthlyQuestionQuota,
  buildQuotaExceededReply,
};
