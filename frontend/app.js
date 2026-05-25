// P3-1: Import i18n module
import { t, setLanguage, getLanguage, initI18n, getAvailableLanguages, locales } from './i18n/index.js?v=20260514coach1';
import { elderlyVisitPlaybook } from './content/playbooks.js?v=20260522visit1';

const META_API = document.querySelector('meta[name="api-base"]');

// Speech SDK version tracking (P0-1)
const SPEECH_SDK_VERSION = '1.38.0'; // Update when upgrading SDK

// Auto-detect localhost for development, use same-origin backend in production
const DEFAULT_API_BASE = window.location.hostname === 'localhost'
  ? `${window.location.protocol}//${window.location.hostname}:4000/api`
  : `${window.location.origin}/api`;
const API_BASE = window.__API_BASE__ || (window.location.hostname === 'localhost' ? DEFAULT_API_BASE : META_API?.content || DEFAULT_API_BASE);

const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const scenarioSelect = document.getElementById('scenario');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendText');
const holdBtn = document.getElementById('holdToSpeak');
const stopSpeakingBtn = document.getElementById('stopSpeaking');
const newSessionBtn = document.getElementById('newSession');
const feedbackEl = document.getElementById('feedback');
const noticeEl = document.getElementById('notice');
const scenarioPill = document.getElementById('scenarioPill');
const sessionPill = document.getElementById('sessionPill');
const ttsPill = document.getElementById('ttsPill');
const voiceSelect = document.getElementById('ttsVoice');
const clearChatBtn = document.getElementById('clearChat');
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
const roleOnboardingEl = document.getElementById('roleOnboarding');
const roleContextPanel = document.getElementById('roleContextPanel');
const roleContextEyebrow = document.getElementById('roleContextEyebrow');
const roleContextTitle = document.getElementById('roleContextTitle');
const roleContextBody = document.getElementById('roleContextBody');
const roleContextActions = document.getElementById('roleContextActions');
const changeModeBtn = document.getElementById('changeModeBtn');
const roleCards = document.querySelectorAll('.role-card[data-user-mode]');
const scenarioGuideEl = document.getElementById('scenarioGuide');
const scenarioGuideTitle = document.getElementById('scenarioGuideTitle');
const scenarioGuideHint = document.getElementById('scenarioGuideHint');
const scenarioGuideBody = document.getElementById('scenarioGuideBody');
const scenarioGuidePhrase = document.getElementById('scenarioGuidePhrase');
const scenarioGuideSteps = document.getElementById('scenarioGuideSteps');
const visitPhraseList = document.getElementById('visitPhraseList');
const visitLargeText = document.getElementById('visitLargeText');
const startVisitTranslationFromPlaybook = document.getElementById('startVisitTranslationFromPlaybook');
const clearVisitPhrase = document.getElementById('clearVisitPhrase');
const visitDirection = document.getElementById('visitDirection');
const visitTranslateBtn = document.getElementById('visitTranslateBtn');
const visitTranslationOutput = document.getElementById('visitTranslationOutput');
const visitTranslationWarning = document.getElementById('visitTranslationWarning');

// P1: Mode toggle elements
const modeFreeTalkBtn = document.getElementById('modeFreeTalk');
const modeTeachingBtn = document.getElementById('modeTeaching');

// P2: Correct Me button
const correctMeBtn = document.getElementById('correctMeBtn');

// P3-1: Language toggle
const uiLangSelect = document.getElementById('uiLang');

// P3-2: TTS Speed slider and presets
const ttsSpeedSlider = document.getElementById('ttsSpeed');
const ttsSpeedValue = document.getElementById('ttsSpeedValue');
const presetBtns = document.querySelectorAll('.preset-btn');

// P3-3: Recording countdown timer
const recordingIndicator = document.getElementById('recordingIndicator');
const ringProgress = document.getElementById('ringProgress');
const timeRemainingEl = document.getElementById('timeRemaining');
const MAX_RECORDING_TIME = 60; // seconds
let recordingTimerInterval = null;

let sessionId = null;
let lastTtsAudio = null;
let isPlaying = false;
let currentAudio = null;
let micPermissionGranted = false;
let processingStartTime = null;
let mediaRecorder = null;
let recordingStream = null;
let audioChunks = [];
let lastUserUtterance = null; // P2: Track last user message for correction
let isRecording = false; // Guard flag for async recording lifecycle

// P1: Current mode state
let currentMode = 'freeChat'; // 'freeChat' or 'teaching'
const USER_MODE_STORAGE_KEY = 'hkbuddy.userMode';
const initialUiLanguagePreference = localStorage.getItem('uiLang');
let userChangedLanguage = false;
let currentUserMode = localStorage.getItem(USER_MODE_STORAGE_KEY) || '';
let currentAsrProvider = 'mock';
let currentAsrLanguage = 'zh-HK';
let currentTtsProvider = 'mock';
let currentTtsVoice = localStorage.getItem('ttsVoice') || 'Cantonese_GentleLady';
let availableTtsVoices = [];
let voiceSelectionEnabled = false;

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

// P3-1: Dynamic i18n state labels (will be updated by updateUILanguage())
let STATE_LABELS_I18N = { ...STATE_LABELS };

const starterPhrases = {
  default: ['你好，我想練習日常對話', '可唔可以幫我糾正發音？', '講個笑話俾我聽吓？'],
  '餐廳點餐 (At the Restaurant)': ['我想點一碗雲吞麵', '呢度有冇素食選擇？', '可唔可以少冰少甜？'],
  '認識新朋友 (Meeting New People)': ['你好，我叫阿明，第一次嚟香港', '你平時有咩興趣？', '可唔可以同我講慢啲？'],
  '去香港旅行 (Traveling in Hong Kong)': ['點樣去太平山頂最方便？', '附近有咩地道小食推介？', '可唔可以講下八達通點用？'],
  '購物閒聊 (Shopping Small Talk)': ['有冇其他顏色同尺碼？', '可唔可以平啲呀？', '呢件衫可唔可以試下？'],
  '工作寒暄 (Workplace Small Talk)': ['今日開會會講啲乜？', '你哋通常點分工？', '可唔可以幫我review一下文件？']
};

const scenarioGuideCopy = {
  en: {
    nextStep: 'Next step',
    guidedScenario: 'Guided scenario',
    fallbackTitle: 'Try one useful line',
    fallbackBody: 'Use a starter card, say or type one short Cantonese line, then ask for correction.',
    meetingTitle: 'Meeting New Friends',
    meetingBody: 'Use this when you want to introduce yourself, ask someone to slow down, or start a friendly campus conversation.',
    phraseLabel: 'Try this first',
    phrase: '你好，我叫 Alex。可唔可以講慢少少？',
    jyutping: 'nei5 hou2, ngo5 giu3 Alex. ho2 m4 ho2 ji5 gong2 maan6 siu2 siu2?',
    meaning: 'Hi, I am Alex. Could you speak a little slower?',
    steps: ['Load the phrase', 'Try the phrase', 'Get feedback', 'Save or report']
  },
  'zh-TW': {
    nextStep: '下一步',
    guidedScenario: '情景指引',
    fallbackTitle: '試一句有用短句',
    fallbackBody: '先用開場句子卡，講或打一句短廣東話，再請 AI 糾正。',
    meetingTitle: '認識新朋友',
    meetingBody: '適合自我介紹、請對方講慢啲，或者開始校園友善對話。',
    phraseLabel: '先試呢句',
    phrase: '你好，我叫 Alex。可唔可以講慢少少？',
    jyutping: 'nei5 hou2, ngo5 giu3 Alex. ho2 m4 ho2 ji5 gong2 maan6 siu2 siu2?',
    meaning: '你好，我叫 Alex。可以講慢一點嗎？',
    steps: ['載入短句', '試講呢句', '取得回饋', '儲存或回報']
  },
  'zh-CN': {
    nextStep: '下一步',
    guidedScenario: '情景指引',
    fallbackTitle: '试一句有用短句',
    fallbackBody: '先用开场句子卡，说或打一短句粤语，再请 AI 纠正。',
    meetingTitle: '认识新朋友',
    meetingBody: '适合自我介绍、请对方说慢一点，或者开始校园友善对话。',
    phraseLabel: '先试这句',
    phrase: '你好，我叫 Alex。可唔可以講慢少少？',
    jyutping: 'nei5 hou2, ngo5 giu3 Alex. ho2 m4 ho2 ji5 gong2 maan6 siu2 siu2?',
    meaning: '你好，我叫 Alex。可以说慢一点吗？',
    steps: ['载入短句', '试说这句', '取得反馈', '保存或回报']
  }
};

const userModeConfig = {
  mainland_learner: {
    chatMode: 'teaching',
    defaultLanguage: 'zh-CN',
    titleKey: 'onboarding.selected.mainland.title',
    bodyKey: 'onboarding.selected.mainland.body',
    actionKeys: [
      { labelKey: 'onboarding.actions.pronunciation', action: 'startPractice' },
      { labelKey: 'onboarding.actions.particles', action: 'focusParticles' },
      { labelKey: 'onboarding.actions.changeMode', action: 'changeMode', secondary: true }
    ]
  },
  international_student: {
    chatMode: 'teaching',
    defaultLanguage: 'en',
    titleKey: 'onboarding.selected.international.title',
    bodyKey: 'onboarding.selected.international.body',
    actionKeys: [
      { labelKey: 'onboarding.actions.prepareVisit', action: 'prepareVisit' },
      { labelKey: 'onboarding.actions.survivalCantonese', action: 'startPractice' },
      { labelKey: 'onboarding.actions.changeMode', action: 'changeMode', secondary: true }
    ]
  },
  visit_translation: {
    chatMode: 'freeChat',
    defaultLanguage: 'en',
    titleKey: 'onboarding.selected.visit.title',
    bodyKey: 'onboarding.selected.visit.body',
    actionKeys: [
      { labelKey: 'onboarding.actions.startVisitTranslation', action: 'startVisitTranslation' },
      { labelKey: 'onboarding.actions.readVisitGuide', action: 'prepareVisit', secondary: true },
      { labelKey: 'onboarding.actions.changeMode', action: 'changeMode', secondary: true }
    ]
  }
};

function scenarioKey(val) {
  return starterPhrases[val] ? val : 'default';
}

function setSystemState(state) {
  if (!systemStateEl) return;
  systemStateEl.className = `system-state state-${state}`;
  // P3-1: Use i18n labels if available
  const label = (typeof STATE_LABELS_I18N !== 'undefined' && STATE_LABELS_I18N[state])
    ? STATE_LABELS_I18N[state]
    : (STATE_LABELS[state] || state);
  if (stateLabelEl) stateLabelEl.textContent = label;
  systemStateEl.setAttribute('aria-label', `系統狀態: ${label}`);

  // P0-3: Show/hide stop button based on state
  if (stopSpeakingBtn) {
    stopSpeakingBtn.hidden = state !== STATES.SPEAKING;
  }

  // P3-3: Show/hide recording indicator based on state
  if (state === STATES.LISTENING) {
    startRecordingTimer();
  } else {
    stopRecordingTimer();
  }
}

function getUserModeConfig(mode = currentUserMode) {
  return userModeConfig[mode] || null;
}

function applyUserModeDefaults(mode, { preserveLanguage = false } = {}) {
  const config = getUserModeConfig(mode);
  if (!config) return;

  setActiveMode(config.chatMode);
  if (!preserveLanguage && config.defaultLanguage && getLanguage() !== config.defaultLanguage) {
    setLanguage(config.defaultLanguage);
    if (uiLangSelect) uiLangSelect.value = config.defaultLanguage;
  }
}

function handleRoleAction(action) {
  if (action === 'changeMode') {
    showRoleSelection();
    return;
  }

  if (action === 'startVisitTranslation') {
    document.body.dataset.userMode = 'visit_translation';
    document.getElementById('practice')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setNotice(t('onboarding.notices.visitTranslationComingSoon'), 'info');
    return;
  }

  if (action === 'prepareVisit') {
    document.getElementById('guidePanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setNotice(t('onboarding.notices.visitGuideReady'), 'info');
    return;
  }

  document.getElementById('practice')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!sessionId) startSession();
}

function renderRoleContext() {
  const config = getUserModeConfig();
  if (!config || !roleContextPanel) return;

  if (roleContextEyebrow) roleContextEyebrow.textContent = t('onboarding.selected.eyebrow');
  if (roleContextTitle) roleContextTitle.textContent = t(config.titleKey);
  if (roleContextBody) roleContextBody.textContent = t(config.bodyKey);

  if (roleContextActions) {
    roleContextActions.innerHTML = '';
    config.actionKeys.forEach(({ labelKey, action, secondary }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = t(labelKey);
      if (secondary) button.className = 'ghost';
      button.addEventListener('click', () => handleRoleAction(action));
      roleContextActions.appendChild(button);
    });
  }

  roleContextPanel.hidden = false;
}

function showRoleSelection() {
  if (roleOnboardingEl) roleOnboardingEl.hidden = false;
  if (roleContextPanel) roleContextPanel.hidden = true;
  if (changeModeBtn) changeModeBtn.hidden = true;
  document.body.dataset.userMode = '';
}

function selectUserMode(mode, { fromStorage = false } = {}) {
  const config = getUserModeConfig(mode);
  if (!config) return;

  currentUserMode = mode;
  localStorage.setItem(USER_MODE_STORAGE_KEY, mode);
  document.body.dataset.userMode = mode;

  const preserveLanguage = Boolean(initialUiLanguagePreference) || userChangedLanguage || fromStorage;
  applyUserModeDefaults(mode, { preserveLanguage });

  roleCards.forEach((card) => {
    const active = card.dataset.userMode === mode;
    card.classList.toggle('active', active);
    card.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  if (roleOnboardingEl) roleOnboardingEl.hidden = true;
  if (changeModeBtn) changeModeBtn.hidden = false;
  renderRoleContext();
}

function initUserMode() {
  roleCards.forEach((card) => {
    card.setAttribute('aria-pressed', 'false');
    card.addEventListener('click', () => selectUserMode(card.dataset.userMode));
  });

  changeModeBtn?.addEventListener('click', showRoleSelection);

  if (currentUserMode && getUserModeConfig(currentUserMode)) {
    selectUserMode(currentUserMode, { fromStorage: true });
  } else {
    showRoleSelection();
  }
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

function getScenarioGuideCopy() {
  return scenarioGuideCopy[getLanguage()] || scenarioGuideCopy.en;
}

function isMeetingScenario(val) {
  return String(val || '').includes('Meeting New People') || String(val || '').includes('認識新朋友');
}

function renderScenarioGuide(val) {
  if (!scenarioGuideEl || !scenarioGuideSteps) return;
  const copy = getScenarioGuideCopy();
  const hasMeetingGuide = isMeetingScenario(val);
  const title = hasMeetingGuide ? copy.meetingTitle : copy.fallbackTitle;
  const body = hasMeetingGuide ? copy.meetingBody : copy.fallbackBody;
  const phrase = hasMeetingGuide
    ? copy.phrase
    : (starterPhrases[scenarioKey(val)] || starterPhrases.default)[0];

  scenarioGuideTitle.textContent = `${copy.nextStep}: ${title}`;
  scenarioGuideHint.textContent = copy.guidedScenario;
  scenarioGuideBody.textContent = body;
  scenarioGuidePhrase.innerHTML = `
    <strong>${copy.phraseLabel}</strong>
    <span>${phrase}</span>
    ${hasMeetingGuide ? `<small>${copy.jyutping}<br>${copy.meaning}</small>` : ''}
  `;
  scenarioGuideSteps.innerHTML = '';

  copy.steps.forEach((label, index) => {
    const step = document.createElement('button');
    step.type = 'button';
    step.className = index === 1 ? 'scenario-step primary' : 'scenario-step';
    step.textContent = `${index + 1}. ${label}`;
    step.addEventListener('click', () => handleScenarioStep(index, phrase));
    scenarioGuideSteps.appendChild(step);
  });
}

function handleScenarioStep(index, phrase) {
  if (index === 0) {
    textInput.value = phrase;
    textInput.focus();
    setNotice(getLanguage() === 'en' ? 'Phrase loaded. Press Send to hear the tutor response.' : '已載入短句，按送出聽導師回應。', 'info');
    return;
  }
  if (index === 1) {
    textInput.value = phrase;
    textInput.focus();
    return;
  }
  if (index === 2) {
    textInput.value = phrase;
    textInput.focus();
    setNotice(getLanguage() === 'en' ? 'Send the phrase, then use Correct Me for feedback.' : '先送出短句，再按「糾正我」取得回饋。', 'info');
    return;
  }
  setNotice(getLanguage() === 'en' ? 'Saved for this practice session.' : '已記錄喺今次練習。', 'success');
}

function renderElderlyVisitPlaybook() {
  if (!visitPhraseList) return;
  visitPhraseList.innerHTML = '';

  elderlyVisitPlaybook.phrases.forEach((phrase) => {
    const card = document.createElement('article');
    card.className = 'visit-phrase-card';
    card.innerHTML = `
      <div>
        <span class="visit-phrase-tag">${t(`playbook.categories.${phrase.category}`)} · ${t(`playbook.phases.${phrase.phase}`)}</span>
        <h4>${phrase.cantonese}</h4>
        <p>${phrase.jyutping}</p>
        <p>${phrase.english}</p>
      </div>
      <button type="button" class="ghost visit-phrase-use">${t('playbook.actions.usePhrase')}</button>
    `;
    card.querySelector('button')?.addEventListener('click', () => selectVisitPhrase(phrase));
    visitPhraseList.appendChild(card);
  });
}

function selectVisitPhrase(phrase) {
  textInput.value = phrase.cantonese;
  textInput.focus();
  if (visitLargeText) {
    visitLargeText.innerHTML = `
      <strong>${phrase.cantonese}</strong>
      <span>${phrase.jyutping}</span>
      <small>${phrase.english}</small>
    `;
  }
  setNotice(t('playbook.notices.phraseLoaded'), 'info');
}

function resetVisitPhrase() {
  if (visitLargeText) {
    visitLargeText.innerHTML = `
      <strong>${t('playbook.largeText.title')}</strong>
      <span>${t('playbook.largeText.empty')}</span>
    `;
  }
  if (textInput.value && elderlyVisitPlaybook.phrases.some((phrase) => phrase.cantonese === textInput.value)) {
    textInput.value = '';
  }
}

function resetVisitTranslationOutput() {
  if (!visitTranslationOutput) return;
  visitTranslationOutput.innerHTML = `
    <strong>${t('visitTranslate.outputTitle')}</strong>
    <span>${t('visitTranslate.outputEmpty')}</span>
  `;
  if (visitTranslationWarning) {
    visitTranslationWarning.hidden = true;
    visitTranslationWarning.textContent = '';
  }
}

function renderVisitTranslation(res) {
  if (!visitTranslationOutput) return;
  visitTranslationOutput.innerHTML = `
    <strong>${res.displayText || res.translatedText}</strong>
    ${res.romanization ? `<span>${res.romanization}</span>` : ''}
    <small>${t('visitTranslate.sourceLabel')}: ${res.sourceText}</small>
  `;

  if (visitLargeText) {
    visitLargeText.innerHTML = `
      <strong>${res.displayText || res.translatedText}</strong>
      ${res.romanization ? `<span>${res.romanization}</span>` : ''}
      <small>${res.sourceText}</small>
    `;
  }

  const needsConfirmation = res.needsConfirmation || res.provider === 'mock' || Number(res.confidence || 0) < 0.7;
  if (visitTranslationWarning) {
    visitTranslationWarning.hidden = !needsConfirmation;
    visitTranslationWarning.textContent = needsConfirmation
      ? t('visitTranslate.confirmationWarning')
      : '';
  }
}

async function translateVisitText(text, inputType = 'text') {
  const sourceText = String(text || '').trim();
  if (!sourceText) {
    setNotice(t('visitTranslate.notices.emptyInput'), 'info');
    return;
  }

  if (!sessionId) await startSession();
  selectUserMode('visit_translation', { fromStorage: true });
  setSystemState(STATES.PROCESSING);
  sendBtn.disabled = true;
  holdBtn.disabled = true;
  visitTranslateBtn.disabled = true;
  setStatus(t('visitTranslate.notices.translating'));

  try {
    renderMessage({ role: 'user', text: sourceText, timestamp: Date.now() });
    const res = await fetchJSON('/visit-translate', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        sourceText,
        direction: visitDirection?.value || 'en_to_yue',
        inputType,
        userMode: 'visit_translation'
      })
    });

    renderVisitTranslation(res);
    renderMessage({ role: 'ai', text: res.displayText || res.translatedText, ttsAudio: res.ttsAudio, timestamp: Date.now() });
    textInput.value = '';
    setNotice(res.needsConfirmation ? t('visitTranslate.notices.confirmWithStaff') : t('visitTranslate.notices.done'), res.needsConfirmation ? 'warning' : 'success');
    if (res.ttsAudio) await playAudio(res.ttsAudio, getPlaybackRate());
  } catch (err) {
    console.error(err);
    setNotice(t('visitTranslate.notices.failed'), 'error');
    setSystemState(STATES.ERROR);
    setTimeout(() => setSystemState(STATES.IDLE), 2000);
  } finally {
    sendBtn.disabled = false;
    holdBtn.disabled = false;
    visitTranslateBtn.disabled = false;
    setStatus(sessionId ? `對話進行中：${sessionId.slice(0, 8)}` : t('states.idle'));
    if (systemStateEl?.classList.contains('state-processing')) setSystemState(STATES.IDLE);
  }
}

function renderEmptyState() {
  if (!transcriptEl) return;
  transcriptEl.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'empty-state';
  box.innerHTML = '<strong>Ready for your first line</strong><p>Pick a mission, freestyle a Cantonese sentence, or warm up with a starter card.</p>';
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
  noticeEl.classList.remove('error', 'info', 'success', 'warning');
  noticeEl.classList.add(kind);
}

function setControlsEnabled(enabled) {
  [sendBtn, holdBtn, newSessionBtn, scenarioSelect, textInput, replayBtn].forEach((el) => {
    if (el) el.disabled = !enabled;
  });
  if (voiceSelect) voiceSelect.disabled = !enabled || !voiceSelectionEnabled;
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
  setNotice('Rechecking your line...', 'info');
  // Placeholder: would call backend to re-analyze
  setTimeout(() => {
    const mockCorrections = [
      {
        original: text,
        suggested: 'Nice edit. Keep the sentence short, direct, and tied to one real Hong Kong student-life situation.',
        reason: 'International learners improve faster when each practice line has one clear goal.',
        retryText: text
      }
    ];
    renderImmediateFeedback(mockCorrections);
    setNotice('Coach notes updated.', 'info');
  }, 500);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function processAudioRecording(audioBlob) {
  try {
    setSystemState(STATES.PROCESSING);
    setStatus(currentAsrProvider === 'azure' ? 'Azure Speech 轉換中...' : '轉換語音中...');

    console.log('Processing audio, blob size:', audioBlob.size, 'type:', audioBlob.type, 'provider:', currentAsrProvider);

    const uploadBlob = currentAsrProvider === 'azure'
      ? await convertToWav(audioBlob)
      : audioBlob;
    const audioData = await blobToDataUrl(uploadBlob);
    console.log('Base64 audio data length:', audioData.length, 'upload type:', uploadBlob.type);

    const res = await fetchJSON('/speech-to-text', {
      method: 'POST',
      body: JSON.stringify({ audioData })
    });

    console.log('ASR response:', res);

    if (!res.transcript) {
      throw new Error('No transcript returned');
    }

    const confidence = res.confidence || 0;

    if (res.transcript.includes('(模擬)')) {
      setNotice('語音辨識服務未啟用，請使用打字模式', 'warning');
      setSystemState(STATES.IDLE);
      return;
    }

    if (confidence < 0.7) {
      setNotice(`辨識信心度較低 (${Math.round(confidence * 100)}%)，請確認`, 'warning');
    } else if (res.provider === 'azure') {
      setNotice(`Azure Speech 已識別：${res.language || currentAsrLanguage}`, 'success');
    }

    if (currentUserMode === 'visit_translation') {
      await translateVisitText(res.transcript, 'speech');
    } else {
      await sendUtterance(res.transcript);
    }
  } catch (err) {
    console.error('ASR error:', err);
    setNotice('語音辨識失敗：' + (err.message || '請重試或使用打字'), 'error');
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
    const offlineContext = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * 16000), 16000);
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

function buildEnglishCoachNotes(userText, aiText, mode) {
  const trimmedText = userText.trim();
  const isQuestion = /[?？嗎吗]$/.test(trimmedText);
  const campusFrame = scenarioSelect?.value?.includes('餐廳')
    ? 'ordering food on campus or at a local cha chaan teng'
    : scenarioSelect?.value?.includes('認識')
      ? 'meeting classmates and making first conversations feel natural'
      : 'daily Hong Kong campus life';

  return [{
    original: trimmedText,
    suggested: mode === 'teaching'
      ? `Good practice line. For ${campusFrame}, focus on one intention first, then add details after the other person responds.`
      : `This works as a friendly opener. For ${campusFrame}, keep it casual and give one small detail so your buddy knows how to help.`,
    reason: isQuestion
      ? 'Your question is understandable. Make it even easier to answer by naming the place, task, or help you need.'
      : 'The meaning is understandable. Add a simple context cue so the reply can sound more local and useful.',
    retryText: trimmedText
  }];
}

function renderImmediateFeedback(corrections) {
  if (!topCorrectionsEl) return;

  topCorrectionsEl.innerHTML = '';
  const topThree = corrections.slice(0, 3);

  if (topThree.length === 0) {
    topCorrectionsEl.innerHTML = '<p class="feedback-empty">Nice start. Keep going with one short, real-life sentence.</p>';
    return;
  }

  topThree.forEach((corr, idx) => {
    const item = document.createElement('div');
    item.className = 'correction-item';

    const original = document.createElement('div');
    original.className = 'original';
    original.textContent = `Your line: ${corr.original}`;

    const suggested = document.createElement('div');
    suggested.className = 'suggested';
    suggested.textContent = `Coach note: ${corr.suggested}`;

    const reason = document.createElement('div');
    reason.className = 'reason';
    reason.textContent = corr.reason;

    const actions = document.createElement('div');
    actions.className = 'correction-actions';

    const hearBtn = document.createElement('button');
    hearBtn.textContent = 'Hear Model Audio';
    hearBtn.className = 'ghost';
    hearBtn.addEventListener('click', () => {
      // Placeholder: would synthesize correct audio
      setNotice('Model audio preview is coming soon.', 'info');
    });

    const tryBtn = document.createElement('button');
    tryBtn.textContent = 'Try Again';
    tryBtn.addEventListener('click', () => {
      textInput.value = corr.retryText || corr.original || '';
      textInput.focus();
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save Card';
    saveBtn.className = 'ghost';
    saveBtn.addEventListener('click', () => {
      setNotice('Saved to review cards.', 'info');
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
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const payload = await res.json();
      detail = payload.details || payload.message || payload.error || detail;
    } catch {
      // Keep the status fallback when the response body is not JSON.
    }
    throw new Error(detail);
  }
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
  renderScenarioGuide(scenarioSelect.value);
}

function voicePrefixLabel() {
  return (t('transcript.voiceDetecting') || '語音').split(/[：:]/)[0];
}

function getVoiceLabel(voiceId = currentTtsVoice) {
  return availableTtsVoices.find(voice => voice.voiceId === voiceId)?.label || voiceId;
}

function updateTtsPill(provider = currentTtsProvider) {
  if (!ttsPill) return;
  if (provider === 'minimax') {
    ttsPill.textContent = `${voicePrefixLabel()}：MiniMax · ${getVoiceLabel()}`;
  } else if (provider === 'azure') {
    ttsPill.textContent = `${voicePrefixLabel()}：Azure TTS`;
  } else {
    ttsPill.textContent = `${voicePrefixLabel()}：Mock`;
  }
}

function renderVoiceOptions() {
  if (!voiceSelect) return;
  voiceSelect.innerHTML = '';
  availableTtsVoices.forEach((voice) => {
    const option = document.createElement('option');
    option.value = voice.voiceId;
    option.textContent = voice.label || voice.voiceId;
    option.title = voice.description || voice.voiceId;
    voiceSelect.appendChild(option);
  });
  voiceSelect.value = availableTtsVoices.some(voice => voice.voiceId === currentTtsVoice)
    ? currentTtsVoice
    : availableTtsVoices[0]?.voiceId || currentTtsVoice;
  currentTtsVoice = voiceSelect.value;
  localStorage.setItem('ttsVoice', currentTtsVoice);
}

async function loadTtsVoices() {
  try {
    const result = await fetchJSON('/tts-voices');
    currentTtsProvider = result.provider || currentTtsProvider;
    voiceSelectionEnabled = currentTtsProvider === 'minimax';
    availableTtsVoices = Array.isArray(result.voices) && result.voices.length
      ? result.voices
      : [{ voiceId: result.currentVoice || currentTtsVoice, label: result.currentVoice || currentTtsVoice }];
    const savedVoice = localStorage.getItem('ttsVoice');
    currentTtsVoice = availableTtsVoices.some(voice => voice.voiceId === savedVoice)
      ? savedVoice
      : result.currentVoice || availableTtsVoices[0]?.voiceId || currentTtsVoice;
  } catch (err) {
    console.warn('Unable to load TTS voices:', err);
    currentTtsProvider = currentTtsProvider || 'mock';
    voiceSelectionEnabled = false;
    availableTtsVoices = [{ voiceId: currentTtsVoice, label: currentTtsVoice }];
  }
  renderVoiceOptions();
  updateTtsPill(currentTtsProvider);
  setControlsEnabled(true);
}

async function startSession() {
  // P1: Include mode in session creation
  const { sessionId: sid, mode } = await fetchJSON('/session', {
    method: 'POST',
    body: JSON.stringify({
      mode: currentMode,
      userMode: currentUserMode || 'international_student',
      uiLanguage: getLanguage(),
      responseLanguage: 'auto',
      ttsVoice: currentTtsVoice
    })
  });
  sessionId = sid;
  if (mode) currentMode = mode;

  transcriptEl.innerHTML = '';
  if (feedbackEl) feedbackEl.textContent = '';
  renderEmptyState();

  // P1: Mode-specific greeting
  const greeting = currentUserMode === 'visit_translation'
    ? t('visitTranslate.greeting')
    : currentMode === 'teaching'
      ? '你好！我係你嘅廣東話老師。今日我會幫你糾正發音同文法，有咩想練習？'
      : '你好！我係你嘅廣東話導師，講句嘢嚟聽下？';
  renderMessage({ role: 'ai', text: greeting, timestamp: Date.now() });

  setStatus(`已建立對話：${sessionId.slice(0, 8)}`);
  sessionPill.textContent = `會話 ${sessionId.slice(0, 8)}`;
  updateModePill();
}

async function sendUtterance(text) {
  if (!text) return;
  if (!sessionId) await startSession();

  if (currentUserMode === 'visit_translation') {
    await translateVisitText(text, 'text');
    return;
  }

  // P2: Track last user utterance for "Correct Me" feature
  lastUserUtterance = text;
  if (correctMeBtn) correctMeBtn.disabled = false;

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
      scenario: scenarioSelect.value,
      mode: currentMode,
      userMode: currentUserMode || 'international_student',
      uiLanguage: getLanguage(),
      responseLanguage: 'auto',
      ttsVoice: currentTtsVoice
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
      ttsVoice: res.ttsVoice,
      ttsAudioLength: res.ttsAudio ? res.ttsAudio.length : 0
    });
    if (res.ttsProvider) currentTtsProvider = res.ttsProvider;
    if (res.ttsVoice) currentTtsVoice = res.ttsVoice;
    updateTtsPill(currentTtsProvider);

    renderMessage({ role: 'ai', text: res.aiText, ttsAudio: res.ttsAudio, timestamp: Date.now() });
    renderImmediateFeedback(buildEnglishCoachNotes(text, res.aiText, currentMode));

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

// P0-3: Stop Speaking button handler
if (stopSpeakingBtn) {
  stopSpeakingBtn.addEventListener('click', () => {
    stopAudio();
    setNotice('已停止播放', 'info');
  });
}

holdBtn.addEventListener('mousedown', handleRecordStart);
holdBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  handleRecordStart();
});

// Azure Speech SDK recognizer (initialized on demand)
let speechRecognizer = null;
let speechConfig = null;
let audioConfig = null;
let azureSdkTranscript = '';
let azureSdkError = null;
// Note: recordingTimerInterval is defined at top of file (P3-3)
// Note: MAX_RECORDING_TIME is defined at top of file (P3-3)

// Initialize Azure Speech SDK with Language Identification
async function initSpeechSDK() {
  // Always create fresh audioConfig since closing a recognizer disposes the mic stream.
  // Only reuse speechConfig (token-based, valid for ~10 min).
  if (speechConfig && audioConfig) {
    console.log('Speech SDK config exists, creating fresh audioConfig');
    const SpeechSDK = window.SpeechSDK || window.Microsoft.CognitiveServices.Speech;
    audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
    return;
  }

  try {
    // Wait for SDK to load if needed
    let attempts = 0;
    while (!window.SpeechSDK && !window.Microsoft && attempts < 10) {
      console.log('Waiting for Speech SDK to load...', attempts);
      await new Promise(resolve => setTimeout(resolve, 300));
      attempts++;
    }

    // Check if Speech SDK is loaded
    if (!window.SpeechSDK && !window.Microsoft) {
      throw new Error('Azure Speech SDK not loaded after waiting. Please refresh the page.');
    }

    const SpeechSDK = window.SpeechSDK || window.Microsoft.CognitiveServices.Speech;
    if (!SpeechSDK) {
      throw new Error('Speech SDK namespace not found');
    }

    console.log('Speech SDK loaded successfully, namespace:', Object.keys(SpeechSDK).slice(0, 10));

    // Get auth token from backend (secure - doesn't expose API key)
    const tokenResponse = await fetchJSON('/speech-token', { method: 'GET' });
    if (!tokenResponse.token || !tokenResponse.region) {
      throw new Error('Failed to get speech token from backend');
    }

    const { token, region, language } = tokenResponse;
    console.log('Got speech token for region:', region);

    // Create Speech Config (not Translation config - we're doing recognition with LID)
    speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);

    if (!speechConfig) {
      throw new Error('Failed to create speech config');
    }

    // P0-4: Extend pause threshold to 3 seconds for users who pause to think
    speechConfig.setProperty(
      SpeechSDK.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
      "3000"
    );
    speechConfig.setProperty(
      SpeechSDK.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
      "10000"
    );

    // Set primary recognition language to Cantonese (Hong Kong)
    // Using zh-HK which is better supported than yue-CN for most cases
    speechConfig.speechRecognitionLanguage = language || currentAsrLanguage || 'zh-HK';

    console.log('Speech config created with 3s pause threshold');

    // Configure audio from microphone
    audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();

    if (!audioConfig) {
      throw new Error('Failed to create audio config');
    }

    console.log('Audio config created successfully');
    console.log('Azure Speech SDK fully initialized');
  } catch (err) {
    console.error('Speech SDK init error:', err);
    speechConfig = null;
    audioConfig = null;
    throw err;
  }
}

document.addEventListener('mouseup', handleRecordStop);
document.addEventListener('touchend', handleRecordStop);

function getSupportedAudioMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4'
  ];
  return candidates.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

async function startBackendSpeechRecording() {
  if (!window.MediaRecorder) {
    throw new Error('MediaRecorder is not supported in this browser');
  }

  audioChunks = [];
  const mimeType = getSupportedAudioMimeType();
  recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);

  mediaRecorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size > 0) audioChunks.push(event.data);
  });

  mediaRecorder.addEventListener('stop', async () => {
    const recordedMimeType = mediaRecorder?.mimeType || mimeType || 'audio/webm';
    const audioBlob = new Blob(audioChunks, { type: recordedMimeType });
    recordingStream?.getTracks().forEach(track => track.stop());
    recordingStream = null;
    mediaRecorder = null;
    holdBtn.textContent = '按住說話';

    if (audioBlob.size === 0) {
      setNotice('未錄到聲音，請再試一次', 'error');
      setSystemState(STATES.IDLE);
      return;
    }

    await processAudioRecording(audioBlob);
  });

  mediaRecorder.start();
  console.log('Backend ASR recording started:', mediaRecorder.mimeType || mimeType || 'default');
}

function cleanupRecordingResources() {
  recordingStream?.getTracks().forEach(track => track.stop());
  recordingStream = null;
  mediaRecorder = null;
  if (speechRecognizer) {
    try {
      speechRecognizer.close();
    } catch (closeError) {
      console.warn('Recognizer cleanup warning:', closeError);
    }
    speechRecognizer = null;
  }
  audioConfig = null;
}

async function startAzureSpeechSdkRecording() {
  await initSpeechSDK();

  if (!isRecording) {
    console.log('Recording was stopped during SDK init, aborting');
    holdBtn.textContent = '按住說話';
    return;
  }

  const SpeechSDK = window.SpeechSDK || window.Microsoft?.CognitiveServices?.Speech;
  if (!SpeechSDK) throw new Error('Speech SDK namespace not found');
  if (!speechConfig) throw new Error('Speech config not initialized');
  if (!audioConfig) throw new Error('Audio config not initialized');

  azureSdkTranscript = '';
  azureSdkError = null;

  console.log('Creating Azure Speech SDK recognizer with configs:', {
    hasSpeechConfig: !!speechConfig,
    hasAudioConfig: !!audioConfig,
    hasSpeechSDK: !!SpeechSDK
  });

  speechRecognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
  if (!speechRecognizer) throw new Error('Failed to create speech recognizer');

  let pauseTimer = null;
  const clearPauseTimer = () => {
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
  };

  speechRecognizer.recognizing = (_sender, event) => {
    clearPauseTimer();
    const partialText = event.result?.text || '';
    if (partialText) holdBtn.textContent = `識別中: ${partialText.substring(0, 20)}...`;
    pauseTimer = setTimeout(() => setNotice('唔緊要，慢慢講...', 'info'), 2000);
  };

  speechRecognizer.recognized = (_sender, event) => {
    clearPauseTimer();
    if (event.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
      const transcript = (event.result.text || '').trim();
      if (transcript) {
        azureSdkTranscript = [azureSdkTranscript, transcript].filter(Boolean).join(' ');
        holdBtn.textContent = `已識別: ${transcript.substring(0, 20)}...`;
        console.log(`Azure SDK recognized: ${transcript}`);
      }
    } else if (event.result.reason === SpeechSDK.ResultReason.NoMatch) {
      console.warn('Azure SDK no speech match');
    }
  };

  speechRecognizer.canceled = (_sender, event) => {
    clearPauseTimer();
    console.log('Azure SDK recognition canceled:', event.errorDetails, 'errorCode:', event.errorCode);
    if (event.errorCode !== SpeechSDK.CancellationErrorCode.NoError) {
      azureSdkError = new Error(event.errorDetails || 'Azure Speech recognition canceled');
    }
  };

  await new Promise((resolve, reject) => {
    speechRecognizer.startContinuousRecognitionAsync(resolve, reject);
  });

  setStatus('Azure Speech 正在聽...');
  console.log('Azure Speech SDK recognition started');
}

async function handleRecordStart() {
  const hasPermission = await requestMicPermission();
  if (!hasPermission) {
    setNotice('需要麥克風權限，已切換至打字模式', 'info');
    return;
  }

  // P0-3: Interrupt any playing audio when user wants to speak
  if (currentAudio && !currentAudio.paused) {
    stopAudio();
    setNotice('已停止播放，開始錄音', 'info');
  }

  try {
    isRecording = true;
    setSystemState(STATES.LISTENING);
    holdBtn.textContent = '錄音中... 放開即發送';
    if (currentAsrProvider === 'azure') {
      await startAzureSpeechSdkRecording();
    } else {
      await startBackendSpeechRecording();
    }
    return;
  } catch (err) {
    console.warn(`${currentAsrProvider === 'azure' ? 'Azure Speech SDK' : 'Backend ASR'} recording failed, trying fallback:`, err);
    cleanupRecordingResources();
  }

  try {
    isRecording = true;
    setSystemState(STATES.LISTENING);
    holdBtn.textContent = '錄音中... 放開即發送';
    if (currentAsrProvider === 'azure') {
      await startBackendSpeechRecording();
    } else {
      await startAzureSpeechSdkRecording();
    }
    return;
  } catch (err) {
    console.error('Recording error:', err);
    setNotice('無法啟動錄音：' + err.message, 'error');
    setSystemState(STATES.ERROR);
    setTimeout(() => setSystemState(STATES.IDLE), 2000);
    holdBtn.textContent = '按住說話';
    stopRecordingTimer();
    isRecording = false;
    cleanupRecordingResources();
  }
}

// Note: Recording timer functions moved to P3-3 section below (SVG ring indicator)

function handleRecordStop() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    isRecording = false;
    stopRecordingTimer();
    holdBtn.textContent = '處理錄音中...';
    mediaRecorder.stop();
    return;
  }

  if (!isRecording && !speechRecognizer) return;

  isRecording = false;
  // Stop recording timer
  stopRecordingTimer();

  if (speechRecognizer) {
    const recognizerRef = speechRecognizer;
    speechRecognizer = null; // Prevent double-stop
    holdBtn.textContent = '處理錄音中...';
    setSystemState(STATES.PROCESSING);
    setStatus('Azure Speech 轉換中...');
    recognizerRef.stopContinuousRecognitionAsync(
      () => {
        (async () => {
          console.log('Azure SDK recognition stopped');
          await new Promise(resolve => setTimeout(resolve, 250));
          recognizerRef.close();
          audioConfig = null; // Force fresh audioConfig on next recording
          holdBtn.textContent = '按住說話';

          const transcript = azureSdkTranscript.trim().replace(/\s+/g, ' ');
          const recognitionError = azureSdkError;
          azureSdkTranscript = '';
          azureSdkError = null;

          if (recognitionError && !transcript) throw recognitionError;
          if (!transcript) {
            setNotice('未能識別語音，請重試或使用打字', 'error');
            setSystemState(STATES.IDLE);
            setStatus(sessionId ? `對話進行中：${sessionId.slice(0, 8)}` : '就緒');
            return;
          }

          setNotice(`Azure Speech 已識別：${currentAsrLanguage}`, 'success');
          if (currentUserMode === 'visit_translation') {
            await translateVisitText(transcript, 'speech');
          } else {
            await sendUtterance(transcript);
          }
        })().catch((err) => {
          console.error('Azure Speech finalize error:', err);
          holdBtn.textContent = '按住說話';
          audioConfig = null;
          azureSdkTranscript = '';
          azureSdkError = null;
          setNotice('語音辨識失敗：' + (err.message || '請重試或使用打字'), 'error');
          setSystemState(STATES.ERROR);
          setTimeout(() => setSystemState(STATES.IDLE), 2000);
        });
      },
      (err) => {
        console.error('Error stopping recognition:', err);
        try { recognizerRef.close(); } catch (closeError) { console.warn('Recognizer close warning:', closeError); }
        audioConfig = null;
        azureSdkTranscript = '';
        azureSdkError = null;
        holdBtn.textContent = '按住說話';
        setNotice('語音識別停止失敗：' + (err?.message || err), 'error');
        setSystemState(STATES.ERROR);
        setTimeout(() => setSystemState(STATES.IDLE), 2000);
      }
    );
  } else {
    holdBtn.textContent = '按住說話';
    setSystemState(STATES.IDLE);
  }
}

newSessionBtn.addEventListener('click', startSession);
clearChatBtn.addEventListener('click', () => {
  transcriptEl.innerHTML = '';
  if (feedbackEl) feedbackEl.textContent = '';
  setNotice('已清除對話記錄', 'info');
  renderEmptyState();
});

scenarioSelect.addEventListener('change', () => {
  scenarioPill.textContent = `${t('transcript.scenarioPrefix')}${scenarioSelect.value}`;
  renderStarterChips(scenarioSelect.value);
  renderScenarioGuide(scenarioSelect.value);
});

// P3-2: Use slider value for playback rate
function getPlaybackRate() {
  const val = parseFloat(ttsSpeedSlider?.value || localStorage.getItem('ttsSpeed') || '1');
  return Number.isFinite(val) ? val : 1;
}

// P3-2: Speed slider event handlers
if (ttsSpeedSlider) {
  // Initialize from localStorage
  const savedSpeed = localStorage.getItem('ttsSpeed') || '1.0';
  ttsSpeedSlider.value = savedSpeed;
  if (ttsSpeedValue) ttsSpeedValue.textContent = `${parseFloat(savedSpeed).toFixed(2)}×`;
  updatePresetButtonsActive(parseFloat(savedSpeed));

  ttsSpeedSlider.addEventListener('input', (e) => {
    const speed = parseFloat(e.target.value);
    if (ttsSpeedValue) ttsSpeedValue.textContent = `${speed.toFixed(2)}×`;
    localStorage.setItem('ttsSpeed', speed.toString());
    updatePresetButtonsActive(speed);
  });
}

// P3-2: Preset buttons
presetBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const speed = parseFloat(btn.dataset.speed);
    if (ttsSpeedSlider) ttsSpeedSlider.value = speed.toString();
    if (ttsSpeedValue) ttsSpeedValue.textContent = `${speed.toFixed(2)}×`;
    localStorage.setItem('ttsSpeed', speed.toString());
    updatePresetButtonsActive(speed);
  });
});

if (voiceSelect) {
  voiceSelect.addEventListener('change', () => {
    currentTtsVoice = voiceSelect.value;
    localStorage.setItem('ttsVoice', currentTtsVoice);
    updateTtsPill(currentTtsProvider);
    setNotice(`${voicePrefixLabel()}：${getVoiceLabel()}`, 'info');
  });
}

function updatePresetButtonsActive(currentSpeed) {
  presetBtns.forEach(btn => {
    const presetSpeed = parseFloat(btn.dataset.speed);
    btn.classList.toggle('active', Math.abs(presetSpeed - currentSpeed) < 0.01);
  });
}

// P3-3: Recording countdown timer
function startRecordingTimer() {
  if (!recordingIndicator || !ringProgress || !timeRemainingEl) return null;

  // Clear any existing timer to prevent leaks from double-calls
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }

  let remaining = MAX_RECORDING_TIME;
  const circumference = 2 * Math.PI * 17; // r=17 from SVG

  recordingIndicator.hidden = false;
  recordingIndicator.classList.add('active');
  timeRemainingEl.textContent = `${remaining}s`;
  ringProgress.style.strokeDashoffset = '0';

  recordingTimerInterval = setInterval(() => {
    remaining--;
    timeRemainingEl.textContent = `${remaining}s`;

    // Update ring progress (stroke-dashoffset increases as time decreases)
    const offset = circumference - (remaining / MAX_RECORDING_TIME * circumference);
    ringProgress.style.strokeDashoffset = offset.toString();

    // Warning color at last 10 seconds
    if (remaining <= 10) {
      timeRemainingEl.style.color = 'var(--error)';
    }

    if (remaining <= 0) {
      stopRecordingTimer();
      // Auto-stop recording
      handleRecordStop();
    }
  }, 1000);

  return recordingTimerInterval;
}

function stopRecordingTimer() {
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
  if (recordingIndicator) {
    recordingIndicator.hidden = true;
    recordingIndicator.classList.remove('active');
  }
  if (timeRemainingEl) {
    timeRemainingEl.style.color = '';
  }
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
    if (!ttsSpeedSlider) return;
    const step = parseFloat(ttsSpeedSlider.step || '0.05');
    const currentSpeed = getPlaybackRate();
    const nextSpeed = e.key === 'ArrowUp'
      ? Math.min(parseFloat(ttsSpeedSlider.max), currentSpeed + step)
      : Math.max(parseFloat(ttsSpeedSlider.min), currentSpeed - step);
    ttsSpeedSlider.value = nextSpeed.toFixed(2);
    if (ttsSpeedValue) ttsSpeedValue.textContent = `${nextSpeed.toFixed(2)}×`;
    localStorage.setItem('ttsSpeed', nextSpeed.toString());
    updatePresetButtonsActive(nextSpeed);
    setNotice(`播放速度：${nextSpeed.toFixed(2)}x`, 'info');
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

// P1: Mode toggle handlers
function updateModePill() {
  const modePill = document.querySelector('.pill.mode-teaching, .pill.mode-freeChat');
  if (!modePill) {
    // Create mode pill if it doesn't exist
    const newPill = document.createElement('div');
    newPill.className = `pill mode-${currentMode}`;
    newPill.id = 'modePill';
    newPill.textContent = currentMode === 'teaching' ? 'Teaching Lab' : 'Free Talk';
    sessionPill?.parentNode?.insertBefore(newPill, sessionPill.nextSibling);
  } else {
    modePill.className = `pill mode-${currentMode}`;
    modePill.textContent = currentMode === 'teaching' ? 'Teaching Lab' : 'Free Talk';
  }
}

function setActiveMode(mode) {
  currentMode = mode;

  // Update button states
  if (modeFreeTalkBtn) {
    modeFreeTalkBtn.classList.toggle('active', mode === 'freeChat');
    modeFreeTalkBtn.setAttribute('aria-selected', mode === 'freeChat');
  }
  if (modeTeachingBtn) {
    modeTeachingBtn.classList.toggle('active', mode === 'teaching');
    modeTeachingBtn.setAttribute('aria-selected', mode === 'teaching');
  }

  updateModePill();
}

async function switchMode(newMode) {
  if (newMode === currentMode) return;

  setActiveMode(newMode);

  // Show feedback when mode changes
  const modeLabel = newMode === 'teaching' ? '教學模式' : '傾計模式';
  setNotice(`已切換至${modeLabel}`, 'info');

  // Add system message about mode change if session exists
  if (sessionId) {
    const modeChangeMsg = newMode === 'teaching'
      ? '【模式切換】現在進入教學模式，我會認真幫你糾正發音同文法。'
      : '【模式切換】現在進入傾計模式，我哋輕鬆傾下計！';
    renderMessage({ role: 'ai', text: modeChangeMsg, timestamp: Date.now() });
  }
}

// P2: "Correct Me" button handler
async function requestCorrection() {
  if (!lastUserUtterance) {
    setNotice('Speak or type one Cantonese line first.', 'info');
    return;
  }

  if (!correctMeBtn) return;

  correctMeBtn.disabled = true;
  correctMeBtn.classList.add('loading');
  correctMeBtn.textContent = 'Analyzing';
  setNotice('Analyzing your Cantonese line...', 'info');

  try {
    const res = await fetchJSON('/correct', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        utterance: lastUserUtterance
      })
    });

    if (res.correction) {
      // Display correction as AI message
      renderMessage({
        role: 'ai',
        text: `Correction analysis:\n\n${res.correction}`,
        timestamp: Date.now()
      });

      // Show cultural insights if available
      if (res.culturalInsights) {
        renderCulturalInsight(res.culturalInsights);
      }

      setNotice('Coach notes ready.', 'info');
    } else {
      throw new Error('No correction returned');
    }
  } catch (err) {
    console.error('Correction request failed:', err);
    // Better error handling for 404 (endpoint not available on Azure)
    if (err.message && err.message.includes('404')) {
      setNotice('Correction coaching is temporarily unavailable while the backend updates.', 'error');
    } else {
      setNotice('Correction request failed. Please try again.', 'error');
    }
  } finally {
    correctMeBtn.disabled = false;
    correctMeBtn.classList.remove('loading');
    correctMeBtn.textContent = t('input.correctMe') || 'Correct Me';
  }
}

// P2: Render cultural insight box
function renderCulturalInsight(insights) {
  if (!insights || !insights.summary) return;

  const insightDiv = document.createElement('div');
  insightDiv.className = 'cultural-insight';

  const header = document.createElement('div');
  header.className = 'cultural-insight-header';
  header.textContent = 'Culture context';

  const body = document.createElement('div');
  body.className = 'cultural-insight-body';
  body.textContent = insights.summary;

  insightDiv.appendChild(header);
  insightDiv.appendChild(body);

  // Add to the feedback panel
  if (feedbackDetailsEl) {
    feedbackDetailsEl.innerHTML = '';
    feedbackDetailsEl.appendChild(insightDiv);
  }
}

// Mode button click handlers
if (modeFreeTalkBtn) {
  modeFreeTalkBtn.addEventListener('click', () => switchMode('freeChat'));
}
if (modeTeachingBtn) {
  modeTeachingBtn.addEventListener('click', () => switchMode('teaching'));
}

// P2: Correct Me button handler
if (correctMeBtn) {
  correctMeBtn.disabled = true; // Disabled until user sends a message
  correctMeBtn.addEventListener('click', requestCorrection);
}

// P3-1: Language toggle handler
if (uiLangSelect) {
  // Initialize language from saved preference
  initI18n();
  uiLangSelect.value = getLanguage();

  uiLangSelect.addEventListener('change', (e) => {
    const newLang = e.target.value;
    userChangedLanguage = true;
    setLanguage(newLang);
    updateUILanguage();
    setNotice(newLang === 'en' ? 'Language changed to English' :
              newLang === 'zh-CN' ? '界面语言已切换为简体中文' :
              '界面語言已切換為繁體中文', 'info');
  });
}

document.querySelectorAll('.modal a[href^="#"]').forEach((link) => {
  link.addEventListener('click', () => {
    const dialog = link.closest('dialog');
    if (dialog?.open) dialog.close();
  });
});

startVisitTranslationFromPlaybook?.addEventListener('click', () => {
  selectUserMode('visit_translation');
  document.getElementById('practice')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setNotice(t('onboarding.notices.visitTranslationComingSoon'), 'info');
});

clearVisitPhrase?.addEventListener('click', resetVisitPhrase);
visitTranslateBtn?.addEventListener('click', () => translateVisitText(textInput.value, 'text'));

// P3-1: Update all UI text when language changes
function updateUILanguage() {
  const lang = getLanguage();
  const strings = locales[lang];
  if (!strings) return;

  // Update elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translation = t(key);
    if (translation && translation !== key) {
      el.textContent = translation;
    }
  });

  // Update placeholder attributes
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const translation = t(key);
    if (translation && translation !== key) {
      el.placeholder = translation;
    }
  });

  // Update dynamic state labels
  STATE_LABELS_I18N = {
    idle: t('states.idle'),
    listening: t('states.listening'),
    processing: t('states.processing'),
    speaking: t('states.speaking'),
    error: t('states.error')
  };

  // Re-render current state
  if (systemStateEl) {
    const currentState = systemStateEl.className.match(/state-(\w+)/)?.[1] || 'idle';
    if (stateLabelEl) stateLabelEl.textContent = STATE_LABELS_I18N[currentState] || currentState;
  }

  // Update document title
  document.title = t('appTitle');

  // Update header title if exists
  const h1 = document.querySelector('h1');
  if (h1) h1.textContent = t('appTitle');

  // Update subtitle
  const subtitle = document.querySelector('.subtitle');
  if (subtitle) subtitle.textContent = t('subtitle');

  // Update hero section
  const heroKicker = document.querySelector('.hero-kicker');
  const heroTitle = document.querySelector('.hero h2');
  const heroBody = document.querySelector('.hero-body');
  if (heroKicker) heroKicker.textContent = t('hero.kicker');
  if (heroTitle) heroTitle.textContent = t('hero.title');
  if (heroBody) heroBody.textContent = t('hero.body');
  renderRoleContext();
  renderScenarioGuide(scenarioSelect.value);
  renderElderlyVisitPlaybook();
  resetVisitTranslationOutput();

  // Update badges
  const badges = document.querySelectorAll('.badges .pill');
  const badgeKeys = ['badges.aiTutor', 'badges.voiceChat', 'badges.realFeedback'];
  badges.forEach((badge, idx) => {
    if (badgeKeys[idx]) badge.textContent = t(badgeKeys[idx]);
  });

  // Update mode descriptions
  if (modeFreeTalkBtn) {
    const label = modeFreeTalkBtn.querySelector('.mode-label');
    const desc = modeFreeTalkBtn.querySelector('.mode-desc');
    if (label) label.textContent = t('modes.freeChat');
    if (desc) desc.textContent = t('modes.freeChatDesc');
  }
  if (modeTeachingBtn) {
    const label = modeTeachingBtn.querySelector('.mode-label');
    const desc = modeTeachingBtn.querySelector('.mode-desc');
    if (label) label.textContent = t('modes.teaching');
    if (desc) desc.textContent = t('modes.teachingDesc');
  }

  updateTtsPill(currentTtsProvider);
  resetVisitPhrase();
}

// Note: STATE_LABELS_I18N is defined at top of file (line ~93)

// Listen for language changes from i18n module
window.addEventListener('languageChanged', () => {
  updateUILanguage();
});

(async function init() {
  // P3-1: Initialize i18n first
  initI18n();
  if (uiLangSelect) uiLangSelect.value = getLanguage();
  updateUILanguage();
  initUserMode();
  renderElderlyVisitPlaybook();

  setSystemState(STATES.IDLE);
  setActiveMode(currentMode); // Initialize mode UI

  try {
    const health = await fetchJSON('/health');
    setStatus(t('status.connected') || '連線成功');
    currentAsrProvider = health.asrProvider || currentAsrProvider;
    currentAsrLanguage = health.asrLanguage || currentAsrLanguage;
    currentTtsProvider = health.ttsProvider || currentTtsProvider;
    currentTtsVoice = health.ttsVoice || currentTtsVoice;
    updateTtsPill(currentTtsProvider);
    setNotice(`${t('status.connected')} API：${API_BASE}`, 'info');
    setControlsEnabled(true);
  } catch {
    setStatus(t('status.disconnected') || '後端未連線');
    setNotice(`${t('status.disconnected') || '後端未連線'}，3 秒後重試...`, 'error');
    setSystemState(STATES.ERROR);
    setControlsEnabled(false);
    setTimeout(init, 3000);
    return;
  }
  await loadTtsVoices();
  await loadScenarios();
  await startSession();
  textInput?.focus();
})();
