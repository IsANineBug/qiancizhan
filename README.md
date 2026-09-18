# 千词斩

本地部署的背单词网页应用：内置高考/四级/六级三本词书，「翻卡学习 + 四选一检验」混合模式，艾宾浩斯间隔重复（1/2/4/7/15 天五档）安排复习。账号数据存本地服务端，换设备登录同一账号可继续。

## 快速开始

```bash
npm install        # 首次运行前安装依赖
npm start          # 启动服务
```

终端会打印访问地址：

- 本机访问：http://localhost:3000
- 局域网访问：http://<你的局域网IP>:3000 （同一 WiFi 下的手机浏览器可直接打开）

端口被占用时换端口启动：`PORT=3001 npm start`

词库数据在首次启动时自动从 `data/dicts/*.json` 灌入数据库（书已存在则跳过）。若词库文件缺失，先运行：

```bash
npm run prepare-dicts   # 从 kajweb/dict 下载并清洗三本词书（需联网）
```

## 公网访问（可选，npm run public）

出门在外、手机流量也想背词时，用 Cloudflare 快速隧道把本机服务映射为一个临时公网网址（自带 HTTPS，免费，无需注册）：

```bash
npm run public
```

- 终端会打印一个 `https://xxx.trycloudflare.com` 形式的公网网址，手机开流量即可访问。
- **每次重启该命令，网址都会变化**（免费快速隧道的预期行为）。
- 停止命令或电脑关机后网址立即失效；本机和局域网访问不受影响。
- 未安装 cloudflared 时，命令会打印各系统的安装指引（macOS `brew install cloudflared`、Windows `winget install Cloudflare.cloudflared`、Linux 见指引），装好后重新运行即可。

**公网安全**：同一账号连续 15 次密码错误会锁定 10 分钟（期间正确密码也拒绝，并提示剩余等待时间），到期自动解锁。

## 云服务器部署（可选）

同一套代码不改一行即可部署到云服务器（单核 2GB 内存即可流畅运行）。

1. **安装 Node.js**（服务器上，≥22 版本）：
   ```bash
   # Debian/Ubuntu（NodeSource 源）
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
2. **上传代码**：把项目文件夹（不含 `node_modules/`、`server/data.db`）传到服务器，如 `scp -r ./Zdemo1 user@服务器IP:~/`。
3. **安装依赖并启动**：
   ```bash
   cd ~/Zdemo1 && npm install
   npm start
   ```
4. **进程常驻**（二选一）：
   - pm2：`npm i -g pm2 && pm2 start server/index.js --name qiancizhan && pm2 save`
   - systemd：创建 `/etc/systemd/system/qiancizhan.service`：
     ```ini
     [Unit]
     Description=QianCiZhan
     After=network.target
     [Service]
     WorkingDirectory=/home/你的用户名/Zdemo1
     ExecStart=/usr/bin/node server/index.js
     Restart=always
     [Install]
     WantedBy=multi-user.target
     ```
     然后 `sudo systemctl enable --now qiancizhan`。
5. **防火墙/安全组**：在云控制台安全组放行 3000 端口（TCP），服务器本机防火墙同理。之后任何设备访问 `http://服务器IP:3000` 即可使用。
6. **HTTPS（可选）**：v1 不配置域名。需要时在服务器前挂 Nginx/Caddy 反代并配证书即可，本应用无特殊要求。

> 云服务器模式与本机模式仅监听配置不同（默认已监听 0.0.0.0，无功能差异）。务必依赖上面的登录锁定机制保护账号安全。

## Tailscale 备选（远程访问的第三条路）

不想暴露公网、又要在外访问家里电脑时，可用 [Tailscale](https://tailscale.com)（免费组网）：

1. 家里电脑和手机都安装 Tailscale 并登录同一账号；
2. 家里电脑正常 `npm start`；
3. 手机浏览器访问家里电脑的 Tailscale IP（如 `http://100.x.y.z:3000`）。

流量端到端加密、不经过公网，适合个人自用。

## 项目结构

```
Zdemo1/
├── server/            # 后端：入口、认证、调度、数据库
│   └── data.db        # 运行时生成的 SQLite 文件（用户数据，勿删）
├── public/            # 前端：原生 HTML/CSS/JS（无框架）
├── scripts/           # 词库预处理 + 隧道脚本
├── data/dicts/        # 预处理后的三本词书 JSON
└── data/raw/          # 词书原始 zip（不入库）
```

## 常见问题

- **忘记密码**：联系开发者直接清库重建（v1 不做找回功能）。
- **数据备份**：备份 `server/data.db` 单文件即可。
- **词书扩充**：`scripts/prepare-dicts.mjs` 可重跑用于扩充其他词书（v1 无界面功能）。
