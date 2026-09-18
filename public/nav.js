// 千词斩 · 底部导航（步骤 5 注入）
// 用法：页面引入本脚本后，调用 renderNav('home'|'books'|'stats'|'settings')
function renderNav(active) {
  const items = [
    { key: 'home', href: '/home.html', icon: '🏠', label: '首页' },
    { key: 'books', href: '/books.html', icon: '📚', label: '词书' },
    { key: 'stats', href: '/stats.html', icon: '📊', label: '统计' },
    { key: 'settings', href: '/settings.html', icon: '⚙️', label: '设置' },
  ];
  const nav = document.createElement('nav');
  nav.className = 'bottom-nav';
  nav.innerHTML = items.map(it => `
    <a href="${it.href}" class="${it.key === active ? 'active' : ''}">
      <span class="icon">${it.icon}</span><span>${it.label}</span>
    </a>`).join('');
  document.body.appendChild(nav);
}
