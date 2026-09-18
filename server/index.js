// 千词斩 · 服务入口（步骤 2）
// npm start 启动，默认 3000 端口；监听 0.0.0.0 覆盖本机与局域网访问。
// 已接入：注册/登录/退出（F1）+ 登录失败限速；学习等功能接口在后续步骤实现。

const express = require('express');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { seedBooks, DB_PATH } = require('./db');
const { sessionMiddleware } = require('./auth');
const authRoutes = require('./routes-auth');
const taskRoutes = require('./routes-tasks');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

seedBooks();

const app = express();
app.use(express.json());
app.use(sessionMiddleware);

app.use('/api', authRoutes);
app.use('/api', taskRoutes);

// 静态前端（public/）；index:false 让根路径落到下面的分流路由，否则登录页会盖掉分流逻辑
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.get('/', (req, res) => {
  res.redirect(req.userId ? '/home.html' : '/index.html');
});

const server = createServer(app);
server.listen(PORT, HOST, () => {
  console.log(`千词斩服务已启动，数据库：${DB_PATH}`);
  console.log(`  本机访问：   http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  局域网访问： http://${a.address}:${PORT}`);
      }
    }
  }
});
