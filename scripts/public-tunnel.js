// 千词斩 · 公网隧道启动脚本（步骤 9：F11）
// 用法：npm run public
// 行为：调用 Cloudflare cloudflared 快速隧道，把本机 3000 端口映射为一个临时公网网址
//       （https://xxx.trycloudflare.com，自带 HTTPS，每次重启网址会变化）。
// 未安装 cloudflared 时打印各系统安装指引，不抛报错堆栈。

const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');

const PORT = Number(process.env.PORT) || 3000;

function findCloudflared() {
  const probe = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
  return probe.error ? null : 'cloudflared';
}

function printInstallGuide() {
  console.log(`
未检测到 cloudflared——它负责把本机服务映射为公网网址（免费，无需注册）。

请先安装：

  macOS (Homebrew):
    brew install cloudflared

  Windows (winget 或下载 exe):
    winget install Cloudflare.cloudflared
    或到 https://github.com/cloudflare/cloudflared/releases 下载 cloudflared-windows-amd64.exe

  Linux (debian/ubuntu):
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
    sudo apt-get update && sudo apt-get install cloudflared

  其他 Linux 发行版：
    到 https://github.com/cloudflare/cloudflared/releases 下载对应架构的二进制，
    放进 PATH（如 /usr/local/bin）即可。

安装完成后重新运行：npm run public

不装 cloudflared 也可以：本机与局域网访问不受影响；或参考 README 的
「云服务器部署」「Tailscale 备选」章节获得公网/远程访问能力。
`);
}

function main() {
  const bin = findCloudflared();
  if (!bin) {
    printInstallGuide();
    process.exit(0);
  }

  console.log(`正在启动 Cloudflare 快速隧道（映射到本机 ${PORT} 端口）…`);
  console.log('提示：每次重启本命令，公网网址都会变化（免费快速隧道的预期行为）。');
  console.log('停止本命令或关机后公网网址立即失效；本机和局域网访问不受影响。\n');

  // cloudflared 首行输出含分配的 trycloudflare 网址
  const child = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const printUrl = (line) => {
    const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m) {
      console.log('╔══════════════════════════════════════════════════╗');
      console.log(`║  公网访问地址：${m[0]}`);
      console.log('║  手机用流量即可访问（自带 HTTPS，无需同一 WiFi）');
      console.log('╚══════════════════════════════════════════════════╝\n');
    }
  };
  child.stdout.on('data', d => { String(d).split('\n').forEach(l => { if (l.trim()) printUrl(l); }); });
  child.stderr.on('data', d => { String(d).split('\n').forEach(l => { if (l.trim()) printUrl(l); }); });
  child.on('error', (err) => {
    console.error('启动 cloudflared 失败：' + err.message);
    process.exit(1);
  });
  ['SIGINT', 'SIGTERM'].forEach(sig => child.on(sig, () => { child.kill(); process.exit(0); }));
}

main();
