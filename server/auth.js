// 千词斩 · 认证模块（步骤 2：F1 注册/登录/退出 + F11 配套登录失败限速）
// 密码：scrypt 加盐哈希（node:crypto 内置，无第三方依赖）
// 会话：内存 Map + 随机 token，HttpOnly Cookie
// 限速：同一用户名连续 15 次密码错误 → 锁定 10 分钟，期间即使密码正确也拒绝

const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_COOKIE = 'qcz_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
const MAX_FAILS = 15;       // 连续失败上限（SPEC F11 硬性规则）
const LOCK_MINUTES = 10;    // 锁定时长（分钟）

// ---- 会话（内存态；服务重启后需重新登录，进度数据不受影响） ----
const sessions = new Map(); // token -> { userId, expiresAt }

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
}

function destroySession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// 中间件：已登录 → req.userId；未登录 → 401（API）或重定向（页面，由调用方区分）
function sessionMiddleware(req, res, next) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const sess = token && sessions.get(token);
  if (sess && sess.expiresAt > Date.now()) {
    req.userId = sess.userId;
  } else {
    if (token) sessions.delete(token);
  }
  next();
}

// ---- 密码存储（2026-09-18 起为明文，用户明确要求；SPEC/AGENTS 已同步） ----
// password_hash 字段直接存明文密码。salt 字段保留但不再使用（兼容旧表结构）。
// 旧哈希账号（salt 非空且哈希为 64 位 hex）登录成功时自动升级为明文。
const LEGACY_HASH_RE = /^[0-9a-f]{64}$/;

function isLegacyHash(user) {
  return Boolean(user.salt) && LEGACY_HASH_RE.test(user.password_hash);
}

function verifyPassword(user, password) {
  if (isLegacyHash(user)) {
    // 旧方案：scrypt 加盐哈希比对（两侧都按 hex 解码为 32 字节）
    const a = Buffer.from(crypto.scryptSync(password, user.salt, 32).toString('hex'), 'hex');
    const b = Buffer.from(user.password_hash, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      // 首次以旧哈希登录成功 → 升级为明文
      db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
        .run(password, '', Number(user.id));
      return true;
    }
    return false;
  }
  return password === user.password_hash;
}

// ---- 登录失败计数与锁定（login_attempts 表，按用户名计） ----
function getAttempt(username) {
  return db.prepare('SELECT fail_count, locked_until FROM login_attempts WHERE username = ?').get(username);
}

function remainingLockSeconds(username) {
  const row = getAttempt(username);
  if (!row?.locked_until) return 0;
  const remain = Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 1000);
  return remain > 0 ? remain : 0;
}

function recordFail(username) {
  const row = getAttempt(username);
  if (!row) {
    db.prepare('INSERT INTO login_attempts (username, fail_count) VALUES (?, 1)').run(username);
    return;
  }
  const failCount = row.fail_count + 1;
  // 达到 15 次即锁定：从现在起 10 分钟
  const lockedUntil = failCount >= MAX_FAILS
    ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString()
    : row.locked_until;
  db.prepare('UPDATE login_attempts SET fail_count = ?, locked_until = ? WHERE username = ?')
    .run(failCount, lockedUntil, username);
}

function clearFails(username) {
  db.prepare('UPDATE login_attempts SET fail_count = 0, locked_until = NULL WHERE username = ?').run(username);
}

module.exports = {
  SESSION_COOKIE,
  MAX_FAILS,
  createSession,
  destroySession,
  sessionMiddleware,
  parseCookies,
  verifyPassword,
  getAttempt,
  remainingLockSeconds,
  recordFail,
  clearFails,
};
