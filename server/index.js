// 千词斩 · 服务入口（步骤 1：骨架）
// npm start 启动，默认 3000 端口；监听 0.0.0.0 覆盖本机与局域网访问。
// 本步仅骨架：占位首页 + 词书入库；注册登录、学习接口在后续步骤实现。

const express = require('express');
const { createServer } = require('node:http');
const os = require('node:os');
const { seedBooks, DB_PATH } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

seedBooks();

const app = express();
app.use(express.json());

// 占位首页（后续步骤替换为登录页/首页）
app.get('/', (req, res) => {
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>千词斩</title><h1>千词斩 · 服务已启动</h1>');
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
