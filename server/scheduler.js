// 千词斩 · 调度核心（步骤 3：F6 艾宾浩斯复习调度的服务端部分）
// 规则（SPEC F6，硬性）：
//   - 档位 1..5 对应复习间隔 1/2/4/7/15 天；通过第 5 档 → 已斩（status=done）
//   - 新词当日学完（首次检验答对）即进入第 1 档，次日到期
//   - 复习点答对升一档；答错回退一档并按回退档位的间隔重排（第 1 档答错则仍第 1 档重新数）
//   - 检验环节内答错的新词只在本次会话回炉（会话层处理），不影响档位
//   - 到期词全部入当日队列按到期先后排序；按本地自然日切换，积压一次补齐
//   - 先复习词后新词

const { db } = require('./db');

// 档位 → 间隔天数（下标 1..5）
const STAGE_INTERVALS = { 1: 1, 2: 2, 3: 4, 4: 7, 5: 15 };

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// 用户当前词书：users.current_book_key（词书页可切换；默认 gaokao）
function currentBookId(userId) {
  const row = db.prepare(
    `SELECT b.id FROM users u JOIN books b ON b.key = u.current_book_key WHERE u.id = ?`
  ).get(Number(userId));
  if (row) return Number(row.id);
  const book = db.prepare(`SELECT id FROM books WHERE key = 'gaokao'`).get();
  return Number(book.id);
}

// ---- 今日任务：到期复习词（全部、按到期先后）+ 新词（按每日上限，跳过已有进度记录的词） ----
function getTodayTasks(userId) {
  const today = todayStr();
  const bookId = currentBookId(userId);

  const reviewRows = db.prepare(
    `SELECT p.word_id, p.stage, p.due_date, w.word, w.usphone, w.ukphone, w.trans_json
     FROM progress p JOIN words w ON w.id = p.word_id
     WHERE p.user_id = ? AND p.book_id = ? AND p.status = 'learning' AND p.due_date <= ?
     ORDER BY p.due_date, p.id`
  ).all(Number(userId), bookId, today);

  const limitRow = db.prepare('SELECT daily_new_limit FROM users WHERE id = ?').get(Number(userId));
  const dailyLimit = Number(limitRow.daily_new_limit);

  // 当日已学新词数：first_seen 是 SQLite localtime 字符串（无时区标记），
  // 不能再对它套 'localtime' 修饰（会被当作 UTC 再偏移一次），直接 date() 取日期
  const learnedToday = db.prepare(
    `SELECT COUNT(*) c FROM progress WHERE user_id = ? AND book_id = ? AND date(first_seen) = ?`
  ).get(Number(userId), bookId, today).c;
  const newQuota = Math.max(0, dailyLimit - learnedToday);

  const newRows = newQuota > 0 ? pickNewWords(userId, bookId, newQuota) : [];

  return { today, bookId, review: reviewRows, newWords: newRows };
}

// ---- 新词选取：按用户的学习顺序模式（word_order_mode）----
// default   → 词书内置 rank（正序版词书，由易到难）
// frequency → COCA 词频序号（高频先学；词表外的词排最后，其间保持书内序）
// random    → 按「日期|用户|词书」种子洗牌，同日稳定、隔日变化
function pickNewWords(userId, bookId, quota) {
  const modeRow = db.prepare('SELECT word_order_mode FROM users WHERE id = ?').get(Number(userId));
  const mode = modeRow?.word_order_mode ?? 'default';

  if (mode === 'default' || mode === 'frequency') {
    const orderBy = mode === 'frequency'
      ? 'ORDER BY w.freq_rank IS NULL, w.freq_rank, w.rank'
      : 'ORDER BY w.rank';
    return db.prepare(
      `SELECT w.id AS word_id, w.word, w.usphone, w.ukphone, w.trans_json
       FROM words w
       WHERE w.book_id = ?
         AND NOT EXISTS (SELECT 1 FROM progress p WHERE p.user_id = ? AND p.word_id = w.id)
       ${orderBy}
       LIMIT ?`
    ).all(bookId, Number(userId), quota);
  }

  // random：种子洗牌（mulberry32，种子取自日期+用户+词书，同日同书稳定）
  const candidates = db.prepare(
    `SELECT w.id AS word_id, w.word, w.usphone, w.ukphone, w.trans_json
     FROM words w
     WHERE w.book_id = ?
       AND NOT EXISTS (SELECT 1 FROM progress p WHERE p.user_id = ? AND p.word_id = w.id)
     ORDER BY w.rank`
  ).all(bookId, Number(userId));
  let seed = 0;
  const key = `${todayStr()}|${userId}|${bookId}`;
  for (let i = 0; i < key.length; i++) {
    seed = (seed * 31 + key.charCodeAt(i)) >>> 0;
  }
  shuffleInPlace(candidates, mulberry32(seed));
  return candidates.slice(0, quota);
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ---- 提交结果 ----
// kind='new'    新词首次检验：wordId 必须在今日新词队列里
// kind='review' 到期复习：wordId 必须在该用户到期队列里
// isNewCorrect 仅对 kind='new' 有意义：新词检验答对 → 立即入第 1 档明日到期；
//              答错 → 只记当日错误数，不建进度（新词翻卡阶段可反复回炉，会话层管）
function submitResult(userId, { kind, wordId, correct }) {
  const today = todayStr();
  const wid = Number(wordId);
  if (kind !== 'new' && kind !== 'review') throw new Error('kind 必须为 new 或 review');

  // 当日记录 upsert
  const logRow = db.prepare('SELECT id FROM daily_log WHERE user_id = ? AND date = ?').get(Number(userId), today);
  if (!logRow) db.prepare('INSERT INTO daily_log (user_id, date) VALUES (?, ?)').run(Number(userId), today);

  if (kind === 'new') {
    const w = db.prepare('SELECT id, book_id FROM words WHERE id = ?').get(wid);
    if (!w) throw new Error('词不存在');
    if (!correct) {
      db.prepare('UPDATE daily_log SET wrong_count = wrong_count + 1 WHERE user_id = ? AND date = ?')
        .run(Number(userId), today);
      return { ok: true, stage: 0, due_date: null, done: false }; // 不入档位，会话内回炉
    }
    // 新词学完 → 第 1 档，明天到期；已建过进度记录则拒绝（防重复提交重复计数）
    const inserted = db.prepare(
      `INSERT INTO progress (user_id, word_id, book_id, stage, status, due_date, first_seen, last_seen)
       VALUES (?, ?, ?, 1, 'learning', ?, datetime('now','localtime'), datetime('now','localtime'))
       ON CONFLICT(user_id, word_id) DO NOTHING`
    ).run(Number(userId), wid, Number(w.book_id), addDaysStr(today, STAGE_INTERVALS[1]));
    if (Number(inserted.changes) === 0) throw new Error('该词已有进度记录，不能按新词重复提交');
    db.prepare('UPDATE daily_log SET learned = learned + 1 WHERE user_id = ? AND date = ?').run(Number(userId), today);
    return { ok: true, stage: 1, due_date: addDaysStr(today, 1), done: false };
  }

  // kind='review'：必须是 learning 且已到期
  const p = db.prepare(
    `SELECT id, stage, due_date FROM progress WHERE user_id = ? AND word_id = ? AND status = 'learning'`
  ).get(Number(userId), wid);
  if (!p) throw new Error('该词不在复习状态');
  if (p.due_date > today) throw new Error(`该词尚未到期（due ${p.due_date}）`);

  if (correct) {
    const nextStage = Number(p.stage) + 1;
    if (nextStage > 5) {
      // 通过第 5 档 → 已斩
      db.prepare(`UPDATE progress SET status = 'done', stage = 5, last_seen = datetime('now','localtime') WHERE id = ?`)
        .run(Number(p.id));
      return { ok: true, stage: 5, due_date: null, done: true };
    }
    const due = addDaysStr(today, STAGE_INTERVALS[nextStage]);
    db.prepare(`UPDATE progress SET stage = ?, due_date = ?, last_seen = datetime('now','localtime') WHERE id = ?`)
      .run(nextStage, due, Number(p.id));
    return { ok: true, stage: nextStage, due_date: due, done: false };
  } else {
    // 答错回退一档；第 1 档答错仍第 1 档，间隔重新数 1 天
    const backStage = Math.max(1, Number(p.stage) - 1);
    const due = addDaysStr(today, STAGE_INTERVALS[backStage]);
    db.prepare(
      `UPDATE progress SET stage = ?, due_date = ?, wrong_count = wrong_count + 1, last_seen = datetime('now','localtime') WHERE id = ?`
    ).run(backStage, due, Number(p.id));
    db.prepare('UPDATE daily_log SET wrong_count = wrong_count + 1 WHERE user_id = ? AND date = ?').run(Number(userId), today);
    return { ok: true, stage: backStage, due_date: due, done: false };
  }
}

// ---- 首页统计（步骤 5 首页将用；本步先供 curl 验证） ----
function getHomeStats(userId) {
  const today = todayStr();
  const bookId = currentBookId(userId);
  const book = db.prepare('SELECT id, key, title, total FROM books WHERE id = ?').get(bookId);
  const reviewDue = db.prepare(
    `SELECT COUNT(*) c FROM progress WHERE user_id = ? AND book_id = ? AND status = 'learning' AND due_date <= ?`
  ).get(Number(userId), bookId, today).c;
  const newPlanned = getTodayTasks(userId).newWords.length;
  const doneTotal = db.prepare(
    `SELECT COUNT(*) c FROM progress WHERE user_id = ? AND book_id = ? AND status = 'done'`
  ).get(Number(userId), bookId).c;
  const learningTotal = db.prepare(
    `SELECT COUNT(*) c FROM progress WHERE user_id = ? AND book_id = ? AND status = 'learning'`
  ).get(Number(userId), bookId).c;
  // 连续学习天数：从今天（或昨天）往回数 daily_log 有学习行为的连续自然日
  let streak = 0;
  const active = new Set(
    db.prepare('SELECT date FROM daily_log WHERE user_id = ?').all(Number(userId)).map(r => r.date)
  );
  let cursor = active.has(today) ? today : addDaysStr(today, -1);
  while (active.has(cursor)) { streak++; cursor = addDaysStr(cursor, -1); }
  return {
    book: { id: Number(book.id), key: book.key, title: book.title, total: Number(book.total) },
    todayNew: newPlanned,
    todayReview: reviewDue,
    doneTotal,
    learningTotal,
    streak,
  };
}

// ---- 词书页（F3）：三本书各自的进度计数 ----
function getBookProgress(userId) {
  const cur = db.prepare('SELECT current_book_key FROM users WHERE id = ?').get(Number(userId));
  const currentKey = cur?.current_book_key ?? 'gaokao';
  return db.prepare('SELECT id, key, title, total FROM books ORDER BY id').all().map(b => {
    const done = db.prepare(
      `SELECT COUNT(*) c FROM progress WHERE user_id = ? AND book_id = ? AND status = 'done'`
    ).get(Number(userId), Number(b.id)).c;
    const learning = db.prepare(
      `SELECT COUNT(*) c FROM progress WHERE user_id = ? AND book_id = ? AND status = 'learning'`
    ).get(Number(userId), Number(b.id)).c;
    return {
      key: b.key, title: b.title, total: Number(b.total),
      done, learning, untouched: Number(b.total) - done - learning,
      isCurrent: b.key === currentKey,
      finished: done >= Number(b.total) && Number(b.total) > 0,
    };
  });
}

// 切换当前词书（key 必须是内置三本之一）
function setCurrentBook(userId, key) {
  const book = db.prepare('SELECT id FROM books WHERE key = ?').get(String(key));
  if (!book) throw new Error('词书不存在');
  db.prepare('UPDATE users SET current_book_key = ? WHERE id = ?').run(String(key), Number(userId));
  return { ok: true, currentBookKey: String(key) };
}

// ---- 统计页（F8）：累计斩词、连续天数、三书进度、最近 7 天学习量 ----
function getStatsPage(userId) {
  const books = getBookProgress(userId);
  const doneTotal = books.reduce((a, b) => a + b.done, 0);
  // 连续学习天数（斩词或复习都算学习行为）
  const active = new Set(
    db.prepare('SELECT date FROM daily_log WHERE user_id = ?').all(Number(userId)).map(r => r.date)
  );
  const today = todayStr();
  let streak = 0;
  let cursor = active.has(today) ? today : addDaysStr(today, -1);
  while (active.has(cursor)) { streak++; cursor = addDaysStr(cursor, -1); }
  // 最近 7 天（含今天，最旧在前）：每日 新学+复习
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDaysStr(today, -i);
    const row = db.prepare(
      'SELECT learned, reviewed FROM daily_log WHERE user_id = ? AND date = ?'
    ).get(Number(userId), d);
    days.push({ date: d, learned: row ? Number(row.learned) : 0, reviewed: row ? Number(row.reviewed) : 0 });
  }
  return { doneTotal, streak, books, last7: days };
}

// ---- 设置（F9） ----
function getSettings(userId) {
  const u = db.prepare('SELECT username, daily_new_limit, accent, word_order_mode FROM users WHERE id = ?').get(Number(userId));
  return { username: u.username, dailyNewLimit: Number(u.daily_new_limit), accent: u.accent, wordOrderMode: u.word_order_mode };
}

function updateSettings(userId, { dailyNewLimit, accent, wordOrderMode }) {
  if (dailyNewLimit !== undefined) {
    const n = Number(dailyNewLimit);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('每日新词数需为 1–100 的整数');
    db.prepare('UPDATE users SET daily_new_limit = ? WHERE id = ?').run(n, Number(userId));
  }
  if (accent !== undefined) {
    if (accent !== 'us' && accent !== 'uk') throw new Error('口音只支持 us / uk');
    db.prepare('UPDATE users SET accent = ? WHERE id = ?').run(accent, Number(userId));
  }
  if (wordOrderMode !== undefined) {
    if (!['default', 'frequency', 'random'].includes(wordOrderMode)) {
      throw new Error('学习顺序只支持 default / frequency / random');
    }
    db.prepare('UPDATE users SET word_order_mode = ? WHERE id = ?').run(wordOrderMode, Number(userId));
  }
  return getSettings(userId);
}

module.exports = { getTodayTasks, submitResult, getHomeStats, getBookProgress, setCurrentBook, getStatsPage, getSettings, updateSettings, todayStr, addDaysStr, STAGE_INTERVALS, currentBookId };
