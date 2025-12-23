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

let sessionId = null;
let lastTtsAudio = null;

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

  if (ttsAudio) {
    const play = document.createElement('button');
    play.className = 'play-btn';
    play.type = 'button';
    play.textContent = '播放';
    play.addEventListener('click', () => playAudio(ttsAudio, getPlaybackRate()));
    meta.appendChild(play);
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
}

async function startSession() {
  const { sessionId: sid } = await fetchJSON('/session', { method: 'POST' });
  sessionId = sid;
  transcriptEl.innerHTML = '';
  feedbackEl.textContent = '';
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
});

scenarioSelect.addEventListener('change', () => {
  scenarioPill.textContent = `情景：${scenarioSelect.value}`;
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
  playAudio(lastTtsAudio, getPlaybackRate());
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
