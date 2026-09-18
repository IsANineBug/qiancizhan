// 千词斩 · 认证路由（步骤 2）
// POST /api/register  注册（用户名唯一、密码 ≥6 位）成功即登录
// POST /api/login     登录；连错 15 次锁 10 分钟（含剩余时间提示）
// POST /api/logout    退出
// GET  /api/me        当前登录用户（未登录返回 {user:null}）

const express = require('express');
const { db } = require('./db');
const auth = require('./auth');

const router = express.Router();

// 用户名：2–20 位，中英文/数字/下划线；密码 ≥6 位
function validate(username, password) {
  if (!username || !/^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) {
    return '用户名需为 2–20 位中英文、数字或下划线';
  }
  if (!password || password.length < 6) return '密码至少 6 位';
  return null;
}

router.post('/register', (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const err = validate(username, password);
  if (err) return res.status(400).json({ error: err });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ error: '用户名已存在' });

  const salt = require('node:crypto').randomBytes(16).toString('hex');
  const hash = auth.hashPassword(password, salt);
  const info = db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)')
    .run(username, hash, salt);
  auth.createSession(res, Number(info.lastInsertRowid));
  res.json({ ok: true, user: { id: Number(info.lastInsertRowid), username } });
});

router.post('/login', (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');

  // 锁定检查在前：锁定期间即使密码正确也拒绝，并提示剩余等待时间
  const lockRemain = auth.remainingLockSeconds(username);
  if (lockRemain > 0) {
    const minutes = Math.ceil(lockRemain / 60);
    return res.status(429).json({ error: `已锁定，请 ${minutes} 分钟后再试（剩余 ${lockRemain} 秒）` });
  }

  const user = db.prepare('SELECT id, username, password_hash, salt FROM users WHERE username = ?').get(username);
  if (!user || !auth.verifyPassword(password, user.salt, user.password_hash)) {
    auth.recordFail(username);
    // 本次失败若正好达到 15 次，锁定即刻生效，本响应就直接提示锁定
    const justLocked = auth.remainingLockSeconds(username);
    if (justLocked > 0) {
      return res.status(429).json({ error: `已锁定，请 ${Math.ceil(justLocked / 60)} 分钟后再试（剩余 ${justLocked} 秒）` });
    }
    const fails = auth.getAttempt(username)?.fail_count ?? 0;
    // 未达锁定阈值前只提示密码错误；接近阈值（≥12 次）附带警示
    const hint = fails >= 12 ? `（连续错误 ${fails} 次，达 15 次将锁定 10 分钟）` : '';
    return res.status(401).json({ error: `用户名或密码错误${hint}` });
  }

  auth.clearFails(username);
  auth.createSession(res, Number(user.id));
  res.json({ ok: true, user: { id: Number(user.id), username: user.username } });
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.userId) return res.json({ user: null });
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(req.userId));
  res.json({ user: user ? { id: Number(user.id), username: user.username } : null });
});

module.exports = router;
