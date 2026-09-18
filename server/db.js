// 千词斩 · 数据库模块（步骤 1）
// 职责：初始化 node:sqlite 连接、建表、启动时把 data/dicts/*.json 灌入词书表（书已存在则跳过）。

const { DatabaseSync } = require('node:sqlite');
const { readFileSync, existsSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');

const ROOT = resolve(dirname(__dirname));
const DB_PATH = process.env.DB_PATH || join(ROOT, 'server/data.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  salt             TEXT NOT NULL,
  daily_new_limit  INTEGER NOT NULL DEFAULT 20 CHECK (daily_new_limit BETWEEN 1 AND 100),
  accent           TEXT NOT NULL DEFAULT 'us' CHECK (accent IN ('us', 'uk')),
  current_book_key TEXT NOT NULL DEFAULT 'gaokao',
  word_order_mode  TEXT NOT NULL DEFAULT 'default' CHECK (word_order_mode IN ('default', 'frequency', 'random')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS books (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  key       TEXT NOT NULL UNIQUE,          -- gaokao / cet4 / cet6
  title     TEXT NOT NULL,
  total     INTEGER NOT NULL               -- 入库词数
);

CREATE TABLE IF NOT EXISTS words (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id        INTEGER NOT NULL REFERENCES books(id),
  word           TEXT NOT NULL,
  usphone        TEXT NOT NULL DEFAULT '',
  ukphone        TEXT NOT NULL DEFAULT '',
  trans_json     TEXT NOT NULL,            -- [{pos, cn}]
  sentences_json TEXT NOT NULL DEFAULT '[]', -- [{en, cn}]
  rank           INTEGER NOT NULL,          -- 书内序号，取词时稳定排序
  freq_rank      INTEGER                    -- COCA 词频序号（1=最高频；NULL=词表外，排最后）
);
CREATE INDEX IF NOT EXISTS idx_words_book ON words(book_id, rank);
CREATE INDEX IF NOT EXISTS idx_words_book_word ON words(book_id, word);

CREATE TABLE IF NOT EXISTS progress (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  word_id    INTEGER NOT NULL REFERENCES words(id),
  book_id    INTEGER NOT NULL REFERENCES books(id),
  stage      INTEGER NOT NULL DEFAULT 0,   -- 0=新词已翻卡未过首检；1..5=艾宾浩斯档位
  status     TEXT NOT NULL DEFAULT 'learning' CHECK (status IN ('learning', 'done')),
  due_date   TEXT NOT NULL,                -- 到期日 YYYY-MM-DD（本地时区自然日）
  first_seen TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  wrong_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, word_id)
);
CREATE INDEX IF NOT EXISTS idx_progress_due ON progress(user_id, book_id, status, due_date);

CREATE TABLE IF NOT EXISTS daily_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  date        TEXT NOT NULL,               -- YYYY-MM-DD 本地时区
  learned     INTEGER NOT NULL DEFAULT 0,  -- 当日新学词数
  reviewed    INTEGER NOT NULL DEFAULT 0,  -- 当日复习词数
  wrong_count INTEGER NOT NULL DEFAULT 0,  -- 当日答错次数
  UNIQUE(user_id, date)
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE,       -- 按账号计失败次数（不区分是否存在该账号）
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT                        -- 锁定截止时间（本地 ISO），NULL=未锁定
);
`);

// 轻量迁移：已存在的库补新列（CREATE TABLE IF NOT EXISTS 对旧库不生效）
function migrate() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('current_book_key')) {
    db.exec("ALTER TABLE users ADD COLUMN current_book_key TEXT NOT NULL DEFAULT 'gaokao'");
  }
  if (!cols.includes('word_order_mode')) {
    db.exec("ALTER TABLE users ADD COLUMN word_order_mode TEXT NOT NULL DEFAULT 'default'");
  }
  const wcols = db.prepare('PRAGMA table_info(words)').all().map(c => c.name);
  if (!wcols.includes('freq_rank')) {
    db.exec('ALTER TABLE words ADD COLUMN freq_rank INTEGER');
  }
}

// 词书入库：data/dicts/*.json → books + words；书已存在（按 key）则跳过插入，
// 但仍回填 freq_rank（词书 JSON 新增了该字段而库是旧结构时的升级路径）
function seedBooks() {
  const DICT_DIR = join(ROOT, 'data/dicts');
  const DICTS = [
    { key: 'gaokao', file: 'gaokao.json' },
    { key: 'cet4', file: 'cet4.json' },
    { key: 'cet6', file: 'cet6.json' },
  ];
  for (const { key, file } of DICTS) {
    const existing = db.prepare('SELECT id, title, total FROM books WHERE key = ?').get(key);
    if (existing) {
      backfillFreqRank(Number(existing.id), join(DICT_DIR, file));
      console.log(`[词书] ${key}（${existing.title}）已入库，跳过（${existing.total} 词）`);
      continue;
    }
    const path = join(DICT_DIR, file);
    if (!existsSync(path)) {
      console.warn(`[词书] 缺少 ${path}，请先运行 npm run prepare-dicts`);
      continue;
    }
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const insertBook = db.prepare('INSERT INTO books (key, title, total) VALUES (?, ?, ?)');
    const insertWord = db.prepare(
      'INSERT INTO words (book_id, word, usphone, ukphone, trans_json, sentences_json, rank, freq_rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    db.exec('BEGIN');
    try {
      const bookInfo = insertBook.run(key, data.title, data.words.length);
      const bookId = Number(bookInfo.lastInsertRowid);
      data.words.forEach((w, i) => {
        insertWord.run(bookId, w.word, w.usphone, w.ukphone, JSON.stringify(w.trans), JSON.stringify(w.sentences), i + 1, w.freq_rank ?? null);
      });
      db.exec('COMMIT');
      console.log(`[词书] ${key}（${data.title}）入库完成：${data.words.length} 词`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// 回填 freq_rank：只更新当前为 NULL 的词（按 词+书 定位），已有进度不受影响
function backfillFreqRank(bookId, dictPath) {
  if (!existsSync(dictPath)) return;
  const pending = db.prepare(
    'SELECT id, word FROM words WHERE book_id = ? AND freq_rank IS NULL'
  ).all(bookId);
  if (pending.length === 0) return;
  const data = JSON.parse(readFileSync(dictPath, 'utf8'));
  const rankByWord = new Map(data.words.map(w => [w.word, w.freq_rank ?? null]));
  const update = db.prepare('UPDATE words SET freq_rank = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    let filled = 0;
    for (const row of pending) {
      const fr = rankByWord.get(row.word);
      if (fr !== undefined) { update.run(fr, Number(row.id)); filled++; }
    }
    db.exec('COMMIT');
    if (filled > 0) console.log(`[词书] 回填 freq_rank：${filled}/${pending.length} 词`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, seedBooks, migrate, DB_PATH };
