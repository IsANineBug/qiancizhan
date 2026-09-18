// 千词斩 · 发音模块（步骤 7：F7）
// 策略：有道 dictvoice 在线发音优先（音质好），加载/播放失败自动降级浏览器 speechSynthesis。
// 连点不叠加：同一时间只允许一路播放；在线音频未就绪前连点按最新词处理，不排队。
// 口音：us/uk（设置页步骤 8 提供切换，当前从 /api/me 或默认 us 读取）。
let currentAudio = null;   // 当前在线音频对象
let currentKey = '';       // 正在播的 word+accent，用于连点去重

function youdaoUrl(word, accent) {
  // type=2 美音、type=1 英音（有道 dictvoice 约定）
  const t = accent === 'uk' ? 1 : 2;
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${t}`;
}

// 降级：浏览器语音合成
function speakLocal(word, accent) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = accent === 'uk' ? 'en-GB' : 'en-US';
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

// 播放主入口：挂到 window.speakWord 供各页调用
window.speakWord = function (word, accent = 'us') {
  const key = word + '|' + accent;
  // 快速连点：同一个词且在线音频已在加载/播放中 → 忽略，不叠加
  if (key === currentKey && currentAudio) return;
  currentKey = key;

  if (currentAudio) { try { currentAudio.pause(); } catch {} currentAudio = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();

  const audio = new Audio(youdaoUrl(word, accent));
  currentAudio = audio;
  audio.addEventListener('ended', () => { if (currentAudio === audio) { currentAudio = null; currentKey = ''; } });
  audio.addEventListener('error', () => {
    // 在线失败 → 离线播报兜底，不弹错误
    if (currentAudio === audio) { currentAudio = null; currentKey = ''; }
    speakLocal(word, accent);
  });
  audio.play().catch(() => { /* 自动播放策略等导致失败 → 降级 */ speakLocal(word, accent); });
};

// 按钮接线和可感知反馈（图标瞬时变化）：页面对 .speaker 按钮统一绑定
window.bindSpeakerButtons = function (getWord, getAccent = () => 'us') {
  document.querySelectorAll('.speaker').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation(); // 翻卡场景：不触发卡片翻面
      // 恢复用固定常量（连点时「当前文本」会已被改成 🔈，不能拿它当原值）
      btn.textContent = '🔈';
      clearTimeout(btn.__iconTimer);
      btn.__iconTimer = setTimeout(() => { btn.textContent = '🔊'; }, 350);
      const word = getWord();
      if (word) window.speakWord(word, getAccent());
    });
  });
};

// 读取用户口音设置（未登录或接口失败一律默认美音）
window.getUserAccent = async function () {
  try {
    const r = await fetch('/api/me');
    const { user } = await r.json();
    return user?.accent === 'uk' ? 'uk' : 'us';
  } catch { return 'us'; }
};
