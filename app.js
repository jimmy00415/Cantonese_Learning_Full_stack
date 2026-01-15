const META_API = document.querySelector('meta[name="api-base"]');
const DEFAULT_API_BASE = window.location.hostname === 'localhost' 
  ? `${window.location.protocol}//${window.location.hostname}:4000/api`
  : 'http://hongkongtutor.azurewebsites.net/api';
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
const systemStateEl = document.getElementById('systemState');
const stateIconEl = document.getElementById('stateIcon');
const stateLabelEl = document.getElementById('stateLabel');
const feedbackImmediateEl = document.getElementById('feedbackImmediate');
const topCorrectionsEl = document.getElementById('topCorrections');
const feedbackDetailsEl = document.getElementById('feedbackDetails');
const micPermissionDialog = document.getElementById('micPermissionDialog');
const micBlockedDialog = document.getElementById('micBlockedDialog');

let sessionId = null;
let lastTtsAudio = null;
let isPlaying = false;
let currentAudio = null;
let micPermissionGranted = false;
let processingStartTime = null;
let mediaRecorder = null;
let audioChunks = [];

// System states: idle, listening, processing, speaking, error
const STATES = {
  IDLE: 'idle',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  SPEAKING: 'speaking',
  ERROR: 'error'
};

const STATE_LABELS = {
  idle: '就緒',
  listening: '聽緊中…',
  processing: '處理中…',
  speaking: '播放中…',
  error: '出錯了'
};

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

function setSystemState(state) {
  if (!systemStateEl) return;
  systemStateEl.className = `system-state state-${state}`;
  if (stateLabelEl) stateLabelEl.textContent = STATE_LABELS[state] || state;
  systemStateEl.setAttribute('aria-label', `系統狀態: ${STATE_LABELS[state] || state}`);
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

async function requestMicPermission() {
  if (micPermissionGranted) return true;
  
  return new Promise((resolve) => {
    if (!micPermissionDialog) {
      resolve(false);
      return;
    }

    micPermissionDialog.showModal();
    
    const allowBtn = document.getElementById('micAllowBtn');
    const denyBtn = document.getElementById('micDenyBtn');
    
    const handleAllow = async () => {
      cleanup();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        micPermissionGranted = true;
        micPermissionDialog.close();
        resolve(true);
      } catch (err) {
        console.error('Mic permission denied:', err);
        micPermissionDialog.close();
        showMicBlockedDialog();
        resolve(false);
      }
    };
    
    const handleDeny = () => {
      cleanup();
      micPermissionDialog.close();
      setNotice('已切換至打字模式', 'info');
      resolve(false);
    };
    
    const cleanup = () => {
      allowBtn?.removeEventListener('click', handleAllow);
      denyBtn?.removeEventListener('click', handleDeny);
    };
    
    allowBtn?.addEventListener('click', handleAllow);
    denyBtn?.addEventListener('click', handleDeny);
  });
}

function showMicBlockedDialog() {
  if (!micBlockedDialog) return;
  
  micBlockedDialog.showModal();
  
  const retryBtn = document.getElementById('micBlockedRetry');
  const closeBtn = document.getElementById('micBlockedClose');
  
  const handleRetry = async () => {
    micBlockedDialog.close();
    const granted = await requestMicPermission();
    if (!granted) setSystemState(STATES.IDLE);
  };
  
  const handleClose = () => {
    micBlockedDialog.close();
    setNotice('已切換至打字模式', 'info');
    setSystemState(STATES.IDLE);
  };
  
  retryBtn?.addEventListener('click', handleRetry, { once: true });
  closeBtn?.addEventListener('click', handleClose, { once: true });
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

function renderMessage({ role, text, ttsAudio, timestamp, corrections }) {
  clearEmptyState();
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.dataset.timestamp = timestamp;
  div.dataset.text = text;
  
  // Store audio data on the element
  if (ttsAudio) {
    div.dataset.ttsAudio = ttsAudio;
  }
  
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
    play.setAttribute('aria-label', '播放導師回應');
    play.addEventListener('click', () => {
      const audioData = div.dataset.ttsAudio;
      console.log('Play button clicked, audio data exists:', !!audioData);
      if (audioData) {
        playAudioWithButton(audioData, getPlaybackRate(), play);
      } else {
        setNotice('音頻數據不存在', 'error');
      }
    });

    const replay = document.createElement('button');
    replay.className = 'play-btn';
    replay.type = 'button';
    replay.textContent = '重播';
    replay.setAttribute('aria-label', '重播導師回應');
    replay.addEventListener('click', () => {
      const audioData = div.dataset.ttsAudio;
      console.log('Replay button clicked, audio data exists:', !!audioData);
      if (audioData) {
        playAudioWithButton(audioData, getPlaybackRate(), replay);
      } else {
        setNotice('音頻數據不存在', 'error');
      }
    });

    controls.appendChild(play);
    controls.appendChild(replay);
    meta.appendChild(controls);
  }
  
  if (role === 'user') {
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.type = 'button';
    editBtn.textContent = '編輯';
    editBtn.setAttribute('aria-label', '編輯記錄');
    editBtn.addEventListener('click', () => editTranscript(div, text));
    meta.appendChild(editBtn);
  }

  const body = document.createElement('div');
  body.innerText = text || '';

  div.appendChild(meta);
  div.appendChild(body);
  
  if (corrections && role === 'user') {
    renderImmediateFeedback(corrections);
  }
  
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function playAudio(ttsAudio, rate = 1) {
  if (!ttsAudio) {
    console.warn('playAudio called with no audio data');
    return;
  }
  console.log('playAudio called with audio data length:', ttsAudio.length);
  try {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    const audio = new Audio(ttsAudio);
    audio.playbackRate = rate || 1;
    currentAudio = audio;
    setSystemState(STATES.SPEAKING);
    
    console.log('Starting audio playback...');
    await audio.play();
    console.log('Audio playback started successfully');
    
    lastTtsAudio = ttsAudio;
    audio.addEventListener('ended', () => {
      console.log('Audio playback ended');
      setSystemState(STATES.IDLE);
      currentAudio = null;
    });
  } catch (err) {
    console.error('Audio playback error:', err);
    setNotice('音頻播放失敗: ' + err.message, 'error');
    setSystemState(STATES.ERROR);
    setTimeout(() => setSystemState(STATES.IDLE), 2000);
  }
}

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
    setSystemState(STATES.IDLE);
  }
}

function editTranscript(messageDiv, originalText) {
  const body = messageDiv.querySelector('div:last-child');
  if (!body) return;
  
  const input = document.createElement('input');
  input.type = 'text';
  input.value = originalText;
  input.className = 'edit-input';
  
  const saveBtn = document.createElement('button');
  saveBtn.textContent = '保存';
  saveBtn.className = 'save-edit-btn';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.className = 'cancel-edit-btn ghost';
  
  const actions = document.createElement('div');
  actions.className = 'edit-actions';
  actions.appendChild(input);
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  
  body.replaceWith(actions);
  input.focus();
  
  const restore = () => {
    const newBody = document.createElement('div');
    newBody.innerText = originalText;
    actions.replaceWith(newBody);
  };
  
  saveBtn.addEventListener('click', async () => {
    const newText = input.value.trim();
    if (!newText || newText === originalText) {
      restore();
      return;
    }
    const newBody = document.createElement('div');
    newBody.innerHTML = `${newText} <small>(已編輯)</small>`;
    actions.replaceWith(newBody);
    messageDiv.dataset.text = newText;
    messageDiv.dataset.edited = 'true';
    // Re-analyze edited text
    await reanalyzeUtterance(newText);
  });
  
  cancelBtn.addEventListener('click', restore);
  
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
    if (e.key === 'Escape') cancelBtn.click();
  });
}

async function reanalyzeUtterance(text) {
  if (!sessionId) return;
  setNotice('重新分析中…', 'info');
  // Placeholder: would call backend to re-analyze
  setTimeout(() => {
    const mockCorrections = [
      { original: text, suggested: text, reason: '編輯後的文本已重新分析' }
    ];
    renderImmediateFeedback(mockCorrections);
    setNotice('分析完成', 'info');
  }, 500);
}

async function processAudioRecording(audioBlob) {
  try {
    setSystemState(STATES.PROCESSING);
    setStatus('轉換語音中...');
    
    console.log('Processing audio, blob size:', audioBlob.size, 'type:', audioBlob.type);
    
    // Convert blob to base64 - send original format, let backend handle conversion
    const reader = new FileReader();
    reader.readAsDataURL(audioBlob);
    
    reader.onloadend = async () => {
      const audioData = reader.result;
      console.log('Base64 audio data length:', audioData.length);
      
      try {
        const res = await fetchJSON('/speech-to-text', {
          method: 'POST',
          body: JSON.stringify({ audioData })
        });
        
        console.log('ASR response:', res);
        
        if (res.transcript) {
          const confidence = res.confidence || 0;
          
          // Filter out mock responses
          if (res.transcript.includes('(模擬)')) {
            setNotice('語音辨識服務未啟用，請使用打字模式', 'warning');
            setSystemState(STATES.IDLE);
            return;
          }
          
          // Show low-confidence warning
          if (confidence < 0.7) {
            setNotice(`辨識信心度較低 (${Math.round(confidence * 100)}%)，請確認`, 'warning');
          }
          
          await sendUtterance(res.transcript);
        } else {
          throw new Error('No transcript returned');
        }
      } catch (err) {
        console.error('ASR error:', err);
        setNotice('語音辨識失敗：' + (err.message || '請重試或使用打字'), 'error');
        setSystemState(STATES.ERROR);
        setTimeout(() => setSystemState(STATES.IDLE), 2000);
      }
    };
    
    reader.onerror = (err) => {
      console.error('FileReader error:', err);
      setNotice('音訊處理失敗', 'error');
      setSystemState(STATES.ERROR);
      setTimeout(() => setSystemState(STATES.IDLE), 2000);
    };
  } catch (err) {
    console.error('Audio processing error:', err);
    setNotice('處理錄音時出錯：' + err.message, 'error');
    setSystemState(STATES.ERROR);
    setTimeout(() => setSystemState(STATES.IDLE), 2000);
  }
}

// Convert audio to WAV format for Azure ASR
async function convertToWav(audioBlob) {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Resample to 16kHz mono for Azure
    const offlineContext = new OfflineAudioContext(1, audioBuffer.duration * 16000, 16000);
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start();
    
    const resampled = await offlineContext.startRendering();
    
    // Convert to WAV
    const wavBuffer = audioBufferToWav(resampled);
    return new Blob([wavBuffer], { type: 'audio/wav' });
  } catch (err) {
    console.error('Audio conversion error:', err);
    // Fallback: return original blob
    return audioBlob;
  }
}

// Convert AudioBuffer to WAV format
function audioBufferToWav(buffer) {
  const length = buffer.length * buffer.numberOfChannels * 2 + 44;
  const arrayBuffer = new ArrayBuffer(length);
  const view = new DataView(arrayBuffer);
  const channels = [];
  let offset = 0;
  let pos = 0;

  // Write WAV header
  const setUint16 = (data) => { view.setUint16(pos, data, true); pos += 2; };
  const setUint32 = (data) => { view.setUint32(pos, data, true); pos += 4; };

  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"
  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(buffer.numberOfChannels);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * buffer.numberOfChannels); // avg. bytes/sec
  setUint16(buffer.numberOfChannels * 2); // block-align
  setUint16(16); // 16-bit
  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  // Write interleaved data
  for (let i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (pos < length) {
    for (let i = 0; i < buffer.numberOfChannels; i++) {
      let sample = Math.max(-1, Math.min(1, channels[i][offset]));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }

  return arrayBuffer;
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

function renderImmediateFeedback(corrections) {
  if (!topCorrectionsEl) return;
  
  topCorrectionsEl.innerHTML = '';
  const topThree = corrections.slice(0, 3);
  
  if (topThree.length === 0) {
    topCorrectionsEl.innerHTML = '<p style="color: #86efac;">發音不錯！</p>';
    return;
  }
  
  topThree.forEach((corr, idx) => {
    const item = document.createElement('div');
    item.className = 'correction-item';
    
    const original = document.createElement('div');
    original.className = 'original';
    original.textContent = `你講：${corr.original}`;
    
    const suggested = document.createElement('div');
    suggested.className = 'suggested';
    suggested.textContent = `建議：${corr.suggested}`;
    
    const reason = document.createElement('div');
    reason.className = 'reason';
    reason.textContent = corr.reason;
    
    const actions = document.createElement('div');
    actions.className = 'correction-actions';
    
    const hearBtn = document.createElement('button');
    hearBtn.textContent = '聽正確音頻';
    hearBtn.className = 'ghost';
    hearBtn.addEventListener('click', () => {
      // Placeholder: would synthesize correct audio
      setNotice('正確音頻播放（模擬）', 'info');
    });
    
    const tryBtn = document.createElement('button');
    tryBtn.textContent = '再試一次';
    tryBtn.addEventListener('click', () => {
      textInput.value = corr.suggested;
      textInput.focus();
    });
    
    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存為卡片';
    saveBtn.className = 'ghost';
    saveBtn.addEventListener('click', () => {
      setNotice('已保存至復習卡片', 'info');
    });
    
    actions.appendChild(hearBtn);
    actions.appendChild(tryBtn);
    actions.appendChild(saveBtn);
    
    item.appendChild(original);
    item.appendChild(suggested);
    item.appendChild(reason);
    item.appendChild(actions);
    
    topCorrectionsEl.appendChild(item);
  });
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
  
  setSystemState(STATES.PROCESSING);
  processingStartTime = Date.now();
  
  renderMessage({ role: 'user', text, timestamp: Date.now() });
  textInput.value = '';
  sendBtn.disabled = true;
  holdBtn.disabled = true;
  setStatus('處理中...');
  
  // Show "Still working..." if processing takes >2s
  const longProcessTimeout = setTimeout(() => {
    if (processingStartTime) {
      setStatus('仍在處理中… 點擊取消');
      statusEl.style.cursor = 'pointer';
      statusEl.onclick = () => {
        clearTimeout(longProcessTimeout);
        setStatus('已取消');
        setSystemState(STATES.IDLE);
        sendBtn.disabled = false;
        holdBtn.disabled = false;
        processingStartTime = null;
        statusEl.onclick = null;
        statusEl.style.cursor = 'default';
      };
    }
  }, 2000);
  
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
    
    clearTimeout(longProcessTimeout);
    processingStartTime = null;
    statusEl.onclick = null;
    statusEl.style.cursor = 'default';
    
    console.log('Response received:', {
      hasAiText: !!res.aiText,
      hasTtsAudio: !!res.ttsAudio,
      ttsProvider: res.ttsProvider,
      ttsAudioLength: res.ttsAudio ? res.ttsAudio.length : 0
    });
    
    // Mock corrections for demo
    const mockCorrections = [
      { original: text, suggested: res.aiText, reason: '語氣更自然' }
    ];
    
    renderMessage({ role: 'ai', text: res.aiText, ttsAudio: res.ttsAudio, timestamp: Date.now() });
    renderImmediateFeedback(mockCorrections);
    
    if (res.latencyMs) {
      console.log(`Response latency: ${res.latencyMs}ms`);
    }
    
    if (res.ttsAudio) {
      console.log('Auto-playing TTS audio...');
      await playAudio(res.ttsAudio, getPlaybackRate());
    } else {
      console.warn('No TTS audio in response');
      setSystemState(STATES.IDLE);
    }
  } catch (err) {
    clearTimeout(longProcessTimeout);
    processingStartTime = null;
    setNotice('出錯了，請再試一次', 'error');
    setSystemState(STATES.ERROR);
    console.error(err);
    setTimeout(() => setSystemState(STATES.IDLE), 2000);
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

holdBtn.addEventListener('mousedown', handleRecordStart);
holdBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  handleRecordStart();
});

// Azure Speech SDK recognizer (initialized on demand)
let speechRecognizer = null;
let speechConfig = null;
let audioConfig = null;

// Initialize Azure Speech SDK with Language Identification
async function initSpeechSDK() {
  if (speechConfig) return; // Already initialized
  
  try {
    // Check if Speech SDK is loaded
    if (!window.SpeechSDK && !window.Microsoft) {
      throw new Error('Azure Speech SDK not loaded');
    }
    
    // Get auth token from backend (secure - doesn't expose API key)
    const tokenResponse = await fetchJSON('/speech-token', { method: 'GET' });
    if (!tokenResponse.token || !tokenResponse.region) {
      throw new Error('Failed to get speech token from backend');
    }
    
    const { token, region } = tokenResponse;
    const SpeechSDK = window.SpeechSDK || window.Microsoft.CognitiveServices.Speech;
    
    // Create Speech Config (not Translation config - we're doing recognition with LID)
    speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
    
    // Set initial recognition language (required by SDK even though LID will detect)
    speechConfig.speechRecognitionLanguage = 'zh-CN';
    
    // Configure audio from microphone
    audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
    
    console.log('Azure Speech SDK initialized with region:', region);
  } catch (err) {
    console.error('Speech SDK init error:', err);
    throw err;
  }
}

document.addEventListener('mouseup', handleRecordStop);
document.addEventListener('touchend', handleRecordStop);

async function handleRecordStart() {
  const hasPermission = await requestMicPermission();
  if (!hasPermission) {
    setNotice('需要麥克風權限，已切換至打字模式', 'info');
    return;
  }
  
  try {
    setSystemState(STATES.LISTENING);
    holdBtn.textContent = '錄音中... 放開即發送';
    
    // Initialize Speech SDK if needed
    await initSpeechSDK();
    
    const SpeechSDK = window.SpeechSDK || window.Microsoft.CognitiveServices.Speech;
    
    // Create auto-detect config with Mandarin and Cantonese as candidates
    const autoDetectConfig = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages([
      'zh-CN',  // Mandarin (Simplified Chinese)
      'yue-CN'  // Cantonese (Cantonese, China)
    ]);
    
    // Create recognizer with Language Identification
    speechRecognizer = SpeechSDK.SpeechRecognizer.FromConfig(
      speechConfig,
      audioConfig,
      autoDetectConfig
    );
    
    console.log('Speech recognizer created with LID for zh-CN and yue-CN');
    
    // Handle recognition results
    speechRecognizer.recognized = (s, e) => {
      if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
        const detectedLanguage = e.result.language || 'unknown';
        const transcript = e.result.text;
        console.log(`Detected language: ${detectedLanguage}, Transcript: ${transcript}`);
        
        // Show detected language to user
        const langName = detectedLanguage === 'zh-CN' ? '普通話' : (detectedLanguage === 'yue-CN' ? '廣東話' : detectedLanguage);
        setNotice(`已識別：${langName}`, 'success');
        
        // Send transcript to AI
        if (transcript) {
          sendUtterance(transcript);
        }
      } else if (e.result.reason === SpeechSDK.ResultReason.NoMatch) {
        console.error('No speech recognized');
        setNotice('未能識別語音，請重試', 'error');
        setSystemState(STATES.IDLE);
      }
    };
    
    // Handle errors
    speechRecognizer.canceled = (s, e) => {
      console.error('Recognition canceled:', e.errorDetails);
      setNotice('語音識別失敗：' + e.errorDetails, 'error');
      setSystemState(STATES.ERROR);
      setTimeout(() => setSystemState(STATES.IDLE), 2000);
      if (speechRecognizer) {
        speechRecognizer.close();
        speechRecognizer = null;
      }
    };
    
    // Start continuous recognition
    speechRecognizer.startContinuousRecognitionAsync(
      () => console.log('Recognition started'),
      (err) => {
        console.error('Failed to start recognition:', err);
        setNotice('無法啟動錄音', 'error');
        setSystemState(STATES.ERROR);
        setTimeout(() => setSystemState(STATES.IDLE), 2000);
      }
    );
    
  } catch (err) {
    console.error('Recording error:', err);
    setNotice('無法啟動錄音：' + err.message, 'error');
    setSystemState(STATES.ERROR);
    setTimeout(() => setSystemState(STATES.IDLE), 2000);
    holdBtn.textContent = '按住說話';
  }
}

function handleRecordStop() {
  if (speechRecognizer) {
    speechRecognizer.stopContinuousRecognitionAsync(
      () => {
        console.log('Recognition stopped');
        if (speechRecognizer) {
          speechRecognizer.close();
          speechRecognizer = null;
        }
        holdBtn.textContent = '按住說話';
        setSystemState(STATES.IDLE);
      },
      (err) => {
        console.error('Error stopping recognition:', err);
        if (speechRecognizer) {
          speechRecognizer.close();
          speechRecognizer = null;
        }
        holdBtn.textContent = '按住說話';
        setSystemState(STATES.IDLE);
      }
    );
  }
}

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
  // Ctrl+Enter to send
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    const text = textInput.value.trim();
    if (text) sendUtterance(text);
    return;
  }
  
  // Ctrl+Shift+R to replay
  if (e.ctrlKey && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault();
    replayBtn.click();
    return;
  }
  
  // Ctrl+Arrow to change speed
  if (e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const options = Array.from(speedSelect.options);
    const idx = speedSelect.selectedIndex;
    const next = e.key === 'ArrowUp' ? Math.max(0, idx - 1) : Math.min(options.length - 1, idx + 1);
    speedSelect.selectedIndex = next;
    setNotice(`播放速度：${speedSelect.value}x`, 'info');
    return;
  }
  
  // Space to interrupt TTS (when not typing)
  if (e.key === ' ' && document.activeElement !== textInput && currentAudio) {
    e.preventDefault();
    stopAudio();
    setNotice('已停止播放', 'info');
    return;
  }
  
  // Escape to close dialogs
  if (e.key === 'Escape') {
    if (micPermissionDialog?.open) micPermissionDialog.close();
    if (micBlockedDialog?.open) micBlockedDialog.close();
  }
});

(async function init() {
  setSystemState(STATES.IDLE);
  try {
    const health = await fetchJSON('/health');
    setStatus('連線成功');
    if (ttsPill) ttsPill.textContent = `語音：${health.ttsProvider === 'azure' ? 'Azure TTS' : '模擬'}`;
    setNotice(`已連線 API：${API_BASE}`, 'info');
    setControlsEnabled(true);
  } catch {
    setStatus('後端未連線');
    setNotice('後端未連線，3 秒後重試...', 'error');
    setSystemState(STATES.ERROR);
    setControlsEnabled(false);
    setTimeout(init, 3000);
    return;
  }
  await loadScenarios();
  await startSession();
  textInput?.focus();
})();
