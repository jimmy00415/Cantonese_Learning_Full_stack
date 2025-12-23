const META_API = document.querySelector('meta[name="api-base"]');
const DEFAULT_API_BASE = `${window.location.protocol}//${window.location.hostname}:4000/api`;
const API_BASE = window.__API_BASE__ || META_API?.content || DEFAULT_API_BASE;

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const scenarioSelect = document.getElementById('scenario');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendText');
const holdBtn = document.getElementById('holdToSpeak');
const newSessionBtn = document.getElementById('newSession');
const feedbackEl = document.getElementById('feedback');
const noticeEl = document.getElementById('notice');
const scenarioPill = document.getElementById('scenarioPill');
const sessionPill = document.getElementById('sessionPill');
const ttsPill = document.getElementById('ttsPill');
const clearChatBtn = document.getElementById('clearChat');
const speedSelect = document.getElementById('speed');
const replayBtn = document.getElementById('replay');
const starterChipsEl = document.getElementById('starterChips');

let sessionId = null;
let lastTtsAudio = null;
let isPlaying = false;

const starterPhrases = {
  default: ['你好，我想練習日常對話', '可唔可以幫我糾正發音？', '講個笑話俾我聽吓？'],
  '餐廳點餐 (At the Restaurant)': ['我想點一碗雲吞麵', '呢度有冇素食選擇？', '可唔可以少冰少甜？'],
  '認識新朋友 (Meeting New People)': ['你好，我叫阿明，第一次嚟香港', '你平時有咩興趣？', '可唔可以同我講慢啲？'],
  '去香港旅行 (Traveling in Hong Kong)': ['點樣去太平山頂最方便？', '附近有咩地道小食推介？', '可唔可以講下八達通點用？'],
  '購物閒聊 (Shopping Small Talk)': ['有冇其他顏色同尺碼？', '可唔可以平啲呀？', '呢件衫可唔可以試下？'],
  '工作寒暄 (Workplace Small Talk)': ['今日開會會講啲乜？', '你哋通常點分工？', '可唔可以幫我review一下文件？']
};

function scenarioKey(val) {
  return starterPhrases[val] ? val : 'default';
}

function renderStarterChips(val) {
  if (!starterChipsEl) return;
  const phrases = starterPhrases[scenarioKey(val)] || starterPhrases.default;
  starterChipsEl.innerHTML = '';
  phrases.forEach((p) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.textContent = p;
    chip.addEventListener('click', () => {
      textInput.value = p;
      textInput.focus();
    });
    starterChipsEl.appendChild(chip);
  });
}

function renderEmptyState() {
  if (!transcriptEl) return;
  transcriptEl.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'empty-state';
  box.innerHTML = '<strong>開始你的第一句</strong><p>選一個情景或點擊上方建議句子，然後按住麥克風或直接輸入。</p>';
  transcriptEl.appendChild(box);
}

function clearEmptyState() {
  if (!transcriptEl) return;
  const empty = transcriptEl.querySelector('.empty-state');
  if (empty) empty.remove();
}

function setNotice(text, kind = 'info') {
  noticeEl.textContent = text || '';
  noticeEl.classList.remove('error', 'info');
  noticeEl.classList.add(kind);
}

function setControlsEnabled(enabled) {
  [sendBtn, holdBtn, newSessionBtn, scenarioSelect, textInput, speedSelect, replayBtn].forEach((el) => {
    el.disabled = !enabled;
  });
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.remove('ok', 'error');
  if (text.includes('成功') || text.includes('進行')) statusEl.classList.add('ok');
  if (text.includes('未連線') || text.includes('錯')) statusEl.classList.add('error');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderMessage({ role, text, ttsAudio, timestamp }) {
  clearEmptyState();
  const div = document.createElement('div');
  div.className = `message ${role}`;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = role === 'ai' ? '導師' : '我';
  const time = document.createElement('span');
  time.textContent = fmtTime(timestamp || Date.now());
  meta.appendChild(badge);
  meta.appendChild(time);

  if (ttsAudio && role === 'ai') {
    const controls = document.createElement('div');
    controls.className = 'controls-inline';

    const play = document.createElement('button');
    play.className = 'play-btn';
    play.type = 'button';
    play.textContent = '播放';
    play.addEventListener('click', () => playAudioWithButton(ttsAudio, getPlaybackRate(), play));

    const replay = document.createElement('button');
    replay.className = 'play-btn';
    replay.type = 'button';
    replay.textContent = '重播';
    replay.addEventListener('click', () => playAudioWithButton(ttsAudio, getPlaybackRate(), replay));

    controls.appendChild(play);
    controls.appendChild(replay);
    meta.appendChild(controls);
  }

  const body = document.createElement('div');
  body.innerText = text || '';

  div.appendChild(meta);
  div.appendChild(body);
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function playAudio(ttsAudio, rate = 1) {
  if (!ttsAudio) return;
  try {
    const audio = new Audio(ttsAudio);
    audio.playbackRate = rate || 1;
    await audio.play();
    lastTtsAudio = ttsAudio;
  } catch (err) {
    console.warn('Audio playback failed', err);
    setNotice('音頻播放失敗', 'error');
  }
}

async function playAudioWithButton(ttsAudio, rate, btn) {
  if (!ttsAudio || isPlaying) return;
  isPlaying = true;
  const original = btn.textContent;
  btn.textContent = '播放中…';
  btn.classList.add('is-playing');
  btn.disabled = true;
  try {
    await playAudio(ttsAudio, rate);
  } finally {
    btn.textContent = original;
    btn.classList.remove('is-playing');
    btn.disabled = false;
    isPlaying = false;
  }
}

async function fetchJSON(path, options) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadScenarios() {
  const { scenarios } = await fetchJSON('/scenarios');
  scenarioSelect.innerHTML = '';
  scenarios.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    scenarioSelect.appendChild(opt);
  });
  scenarioPill.textContent = `情景：${scenarioSelect.value || '自由對話'}`;
  renderStarterChips(scenarioSelect.value);
}

async function startSession() {
  const { sessionId: sid } = await fetchJSON('/session', { method: 'POST' });
  sessionId = sid;
  transcriptEl.innerHTML = '';
  feedbackEl.textContent = '';
  renderEmptyState();
  renderMessage({ role: 'ai', text: '你好！我係你嘅廣東話導師，講句嘢嚟聽下？', timestamp: Date.now() });
  setStatus(`已建立對話：${sessionId.slice(0, 8)}`);
  sessionPill.textContent = `會話 ${sessionId.slice(0, 8)}`;
}

async function sendUtterance(text) {
  if (!text || !sessionId) return;
  renderMessage({ role: 'user', text, timestamp: Date.now() });
  textInput.value = '';
  sendBtn.disabled = true;
  holdBtn.disabled = true;
  setStatus('處理中...');
  try {
    const payload = {
      sessionId,
      userText: text,
      scenario: scenarioSelect.value
    };
    const res = await fetchJSON('/recognize-and-respond', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    renderMessage({ role: 'ai', text: res.aiText, ttsAudio: res.ttsAudio, timestamp: Date.now() });
    feedbackEl.textContent = res.feedback || '';
    if (res.ttsAudio) {
      await playAudio(res.ttsAudio, getPlaybackRate());
    }
  } catch (err) {
    feedbackEl.textContent = '出錯了，請再試一次';
    console.error(err);
  } finally {
    sendBtn.disabled = false;
    holdBtn.disabled = false;
    setStatus(`對話進行中：${sessionId.slice(0, 8)}`);
  }
}

sendBtn.addEventListener('click', () => {
  const text = textInput.value.trim();
  sendUtterance(text);
});

textInput.addEventListener('keyup', (e) => {
  if (e.key === 'Enter') sendBtn.click();
});

holdBtn.addEventListener('mousedown', () => {
  holdBtn.textContent = '錄音中（模擬）放開即發送';
});

holdBtn.addEventListener('mouseup', () => {
  holdBtn.textContent = '按住說話（模擬）';
  const simulated = textInput.value.trim() || '（模擬語音）你好，我想練習廣東話';
  sendUtterance(simulated);
});

newSessionBtn.addEventListener('click', startSession);
clearChatBtn.addEventListener('click', () => {
  transcriptEl.innerHTML = '';
  feedbackEl.textContent = '';
  setNotice('已清除對話記錄', 'info');
  renderEmptyState();
});

scenarioSelect.addEventListener('change', () => {
  scenarioPill.textContent = `情景：${scenarioSelect.value}`;
  renderStarterChips(scenarioSelect.value);
});

function getPlaybackRate() {
  const val = parseFloat(speedSelect?.value || '1');
  return Number.isFinite(val) ? val : 1;
}

replayBtn.addEventListener('click', () => {
  if (!lastTtsAudio) {
    setNotice('暫時未有可重播的導師語音', 'info');
    return;
  }
  playAudioWithButton(lastTtsAudio, getPlaybackRate(), replayBtn);
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    const text = textInput.value.trim();
    sendUtterance(text);
  }
  if (e.ctrlKey && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault();
    replayBtn.click();
  }
  if (e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const options = Array.from(speedSelect.options);
    const idx = speedSelect.selectedIndex;
    const next = e.key === 'ArrowUp' ? Math.max(0, idx - 1) : Math.min(options.length - 1, idx + 1);
    speedSelect.selectedIndex = next;
    setNotice(`播放速度：${speedSelect.value}x`, 'info');
  }
});

(async function init() {
  try {
    const health = await fetchJSON('/health');
    setStatus('連線成功');
    if (ttsPill) ttsPill.textContent = `語音：${health.ttsProvider === 'azure' ? 'Azure TTS' : '模擬'}`;
    setNotice(`已連線 API：${API_BASE}`, 'info');
    setControlsEnabled(true);
  } catch {
    setStatus('後端未連線');
    setNotice('後端未連線，3 秒後重試...', 'error');
    setControlsEnabled(false);
    setTimeout(init, 3000);
    return;
  }
  await loadScenarios();
  await startSession();
  textInput?.focus();
})();
