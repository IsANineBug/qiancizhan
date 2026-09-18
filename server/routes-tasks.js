// 千词斩 · 学习任务 API（步骤 3）
// 全部要求登录（sessionMiddleware 已在应用级挂载，此处显式拒绝未登录）
// GET  /api/tasks/today    今日任务（到期复习词 + 新词）
// POST /api/tasks/result   提交单词结果 { kind: 'new'|'review', wordId, correct: bool }
// GET  /api/stats/home    首页统计（词书、今日新词/复习数、累计斩词、连续天数）

const express = require('express');
const scheduler = require('./scheduler');

const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: '未登录' });
  next();
}
router.use(requireLogin);

router.get('/tasks/today', (req, res) => {
  try {
    const t = scheduler.getTodayTasks(req.userId);
    res.json({
      today: t.today,
      bookId: t.bookId,
      review: t.review.map(r => ({
        wordId: Number(r.word_id), stage: Number(r.stage), dueDate: r.due_date,
        word: r.word, usphone: r.usphone, ukphone: r.ukphone, trans: JSON.parse(r.trans_json),
      })),
      newWords: t.newWords.map(w => ({
        wordId: Number(w.word_id), word: w.word, usphone: w.usphone, ukphone: w.ukphone,
        trans: JSON.parse(w.trans_json),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/tasks/result', (req, res) => {
  try {
    const { kind, wordId, correct } = req.body ?? {};
    const out = scheduler.submitResult(req.userId, { kind, wordId, correct: Boolean(correct) });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/stats/home', (req, res) => {
  try {
    res.json(scheduler.getHomeStats(req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 词书页：三本书进度
router.get('/books', (req, res) => {
  try {
    res.json({ books: scheduler.getBookProgress(req.userId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 切换当前词书：POST { key: 'gaokao'|'cet4'|'cet6' }
router.post('/books/current', (req, res) => {
  try {
    res.json(scheduler.setCurrentBook(req.userId, req.body?.key));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 统计页
router.get('/stats/page', (req, res) => {
  try {
    res.json(scheduler.getStatsPage(req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 设置：读取 / 保存
router.get('/settings', (req, res) => {
  try {
    res.json(scheduler.getSettings(req.userId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/settings', (req, res) => {
  try {
    res.json(scheduler.updateSettings(req.userId, req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
