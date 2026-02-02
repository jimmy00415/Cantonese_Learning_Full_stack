/**
 * i18n - Multi-language Interface Support for Cantonese Tutor
 * Phase 3-1: UI Language Toggle
 * Supports: Traditional Chinese (zh-TW), Simplified Chinese (zh-CN), English (en)
 */

export const locales = {
  'zh-TW': {
    // App Title & Header
    appTitle: '廣東話對話導師',
    subtitle: '桌面網頁體驗 · 模擬語音對話 · 立即練習',
    badges: {
      aiTutor: 'AI 導師',
      voiceChat: '語音對話',
      realFeedback: '實時反饋'
    },
    
    // System States
    states: {
      idle: '就緒',
      listening: '聽緊中…',
      processing: '處理中…',
      speaking: '播放中…',
      error: '出錯了'
    },
    
    // Connection Status
    status: {
      connecting: '連線中...',
      connected: '已連線',
      disconnected: '連線中斷',
      error: '連線錯誤'
    },
    
    // Hero Section
    hero: {
      kicker: '練口語 · 聽語感 · 改發音',
      title: '和 AI 對話，像真人陪練',
      body: '按住說話或輸入文字，獲取即時廣東話回應與語音播報，適合桌面麥克風場景。'
    },
    
    // Mode Toggle
    modes: {
      freeChat: 'Free Talk',
      freeChatDesc: '輕鬆傾計',
      teaching: 'Teaching',
      teachingDesc: '認真學習',
      modeLabel: '對話模式'
    },
    
    // Controls
    controls: {
      scenario: '情景：',
      newSession: '開始新對話',
      clearChat: '清除記錄'
    },
    
    // Starter Section
    starter: {
      header: '開場建議',
      hint: '點擊一句即填入'
    },
    
    // Transcript
    transcript: {
      scenarioPrefix: '情景：',
      freeChat: '自由對話',
      sessionNotStarted: '未開始',
      voiceDetecting: '語音：偵測中'
    },
    
    // Input Panel
    input: {
      holdToSpeak: '按住說話',
      stopSpeaking: '停止播放',
      textPlaceholder: '或輸入一句廣東話...',
      speed: '速度',
      replay: '重播',
      correctMe: '糾正我',
      send: '發送'
    },
    
    // Feedback
    feedback: {
      immediate: '即時反饋',
      details: '詳細分析'
    },
    
    // Dialogs
    dialogs: {
      micPermission: {
        title: '麥克風權限',
        body: '我哋需要您嘅麥克風權限，先可以聽到您嘅廣東話發音並提供反饋。',
        allow: '允許麥克風',
        deny: '使用打字代替'
      },
      micBlocked: {
        title: '麥克風被阻擋',
        body: '請喺瀏覽器設置中允許呢個網站使用麥克風：',
        steps: [
          '點擊地址欄左側嘅鎖形圖標',
          '揀「網站設置」或「權限」',
          '將麥克風設為「允許」'
        ],
        close: '知道了'
      }
    },
    
    // Scenarios
    scenarios: {
      default: '自由對話 (Free Chat)',
      restaurant: '餐廳點餐 (At the Restaurant)',
      newFriends: '認識新朋友 (Meeting New People)',
      travel: '去香港旅行 (Traveling in Hong Kong)',
      shopping: '購物閒聊 (Shopping Small Talk)',
      workplace: '工作寒暄 (Workplace Small Talk)'
    },
    
    // Settings
    settings: {
      uiLanguage: '界面語言',
      voiceSpeed: '語速',
      speedPresets: {
        slow: '慢',
        normal: '正常',
        fast: '快'
      }
    },
    
    // Recording
    recording: {
      countdown: '剩餘時間',
      maxDuration: '最長錄音'
    },
    
    // Error messages
    errors: {
      noMic: '無法存取麥克風',
      noSession: '請先開始新對話',
      networkError: '網路連線錯誤',
      ttsError: 'TTS 播放錯誤',
      correctionError: '無法獲取糾正建議'
    }
  },
  
  'zh-CN': {
    // App Title & Header
    appTitle: '粤语对话导师',
    subtitle: '桌面网页体验 · 模拟语音对话 · 立即练习',
    badges: {
      aiTutor: 'AI 导师',
      voiceChat: '语音对话',
      realFeedback: '实时反馈'
    },
    
    // System States
    states: {
      idle: '就绪',
      listening: '聆听中…',
      processing: '处理中…',
      speaking: '播放中…',
      error: '出错了'
    },
    
    // Connection Status
    status: {
      connecting: '连接中...',
      connected: '已连接',
      disconnected: '连接中断',
      error: '连接错误'
    },
    
    // Hero Section
    hero: {
      kicker: '练口语 · 听语感 · 改发音',
      title: '和 AI 对话，像真人陪练',
      body: '按住说话或输入文字，获取即时粤语回应与语音播报，适合桌面麦克风场景。'
    },
    
    // Mode Toggle
    modes: {
      freeChat: 'Free Talk',
      freeChatDesc: '轻松聊天',
      teaching: 'Teaching',
      teachingDesc: '认真学习',
      modeLabel: '对话模式'
    },
    
    // Controls
    controls: {
      scenario: '情景：',
      newSession: '开始新对话',
      clearChat: '清除记录'
    },
    
    // Starter Section
    starter: {
      header: '开场建议',
      hint: '点击一句即填入'
    },
    
    // Transcript
    transcript: {
      scenarioPrefix: '情景：',
      freeChat: '自由对话',
      sessionNotStarted: '未开始',
      voiceDetecting: '语音：检测中'
    },
    
    // Input Panel
    input: {
      holdToSpeak: '按住说话',
      stopSpeaking: '停止播放',
      textPlaceholder: '或输入一句粤语...',
      speed: '速度',
      replay: '重播',
      correctMe: '纠正我',
      send: '发送'
    },
    
    // Feedback
    feedback: {
      immediate: '即时反馈',
      details: '详细分析'
    },
    
    // Dialogs
    dialogs: {
      micPermission: {
        title: '麦克风权限',
        body: '我们需要您的麦克风权限，才可以听到您的粤语发音并提供反馈。',
        allow: '允许麦克风',
        deny: '使用打字代替'
      },
      micBlocked: {
        title: '麦克风被阻止',
        body: '请在浏览器设置中允许此网站使用麦克风：',
        steps: [
          '点击地址栏左侧的锁形图标',
          '选择「网站设置」或「权限」',
          '将麦克风设为「允许」'
        ],
        close: '知道了'
      }
    },
    
    // Scenarios
    scenarios: {
      default: '自由对话 (Free Chat)',
      restaurant: '餐厅点餐 (At the Restaurant)',
      newFriends: '认识新朋友 (Meeting New People)',
      travel: '去香港旅行 (Traveling in Hong Kong)',
      shopping: '购物闲聊 (Shopping Small Talk)',
      workplace: '工作寒暄 (Workplace Small Talk)'
    },
    
    // Settings
    settings: {
      uiLanguage: '界面语言',
      voiceSpeed: '语速',
      speedPresets: {
        slow: '慢',
        normal: '正常',
        fast: '快'
      }
    },
    
    // Recording
    recording: {
      countdown: '剩余时间',
      maxDuration: '最长录音'
    },
    
    // Error messages
    errors: {
      noMic: '无法访问麦克风',
      noSession: '请先开始新对话',
      networkError: '网络连接错误',
      ttsError: 'TTS 播放错误',
      correctionError: '无法获取纠正建议'
    }
  },
  
  'en': {
    // App Title & Header
    appTitle: 'Cantonese Conversation Tutor',
    subtitle: 'Desktop Experience · Voice Practice · Learn Now',
    badges: {
      aiTutor: 'AI Tutor',
      voiceChat: 'Voice Chat',
      realFeedback: 'Real-time Feedback'
    },
    
    // System States
    states: {
      idle: 'Ready',
      listening: 'Listening...',
      processing: 'Processing...',
      speaking: 'Playing...',
      error: 'Error'
    },
    
    // Connection Status
    status: {
      connecting: 'Connecting...',
      connected: 'Connected',
      disconnected: 'Disconnected',
      error: 'Connection Error'
    },
    
    // Hero Section
    hero: {
      kicker: 'Speak · Listen · Improve',
      title: 'Chat with AI, like a real tutor',
      body: 'Press and hold to speak or type, get instant Cantonese responses with voice playback, ideal for desktop microphone scenarios.'
    },
    
    // Mode Toggle
    modes: {
      freeChat: 'Free Talk',
      freeChatDesc: 'Casual Chat',
      teaching: 'Teaching',
      teachingDesc: 'Serious Learning',
      modeLabel: 'Conversation Mode'
    },
    
    // Controls
    controls: {
      scenario: 'Scenario:',
      newSession: 'New Conversation',
      clearChat: 'Clear History'
    },
    
    // Starter Section
    starter: {
      header: 'Conversation Starters',
      hint: 'Click to fill in'
    },
    
    // Transcript
    transcript: {
      scenarioPrefix: 'Scenario: ',
      freeChat: 'Free Chat',
      sessionNotStarted: 'Not Started',
      voiceDetecting: 'Voice: Detecting'
    },
    
    // Input Panel
    input: {
      holdToSpeak: 'Hold to Speak',
      stopSpeaking: 'Stop Playing',
      textPlaceholder: 'Or type in Cantonese...',
      speed: 'Speed',
      replay: 'Replay',
      correctMe: 'Correct Me',
      send: 'Send'
    },
    
    // Feedback
    feedback: {
      immediate: 'Immediate Feedback',
      details: 'Detailed Analysis'
    },
    
    // Dialogs
    dialogs: {
      micPermission: {
        title: 'Microphone Access',
        body: 'We need microphone access to hear your Cantonese pronunciation and provide feedback.',
        allow: 'Allow Microphone',
        deny: 'Use Typing Instead'
      },
      micBlocked: {
        title: 'Microphone Blocked',
        body: 'Please allow microphone access in your browser settings:',
        steps: [
          'Click the lock icon in the address bar',
          'Select "Site settings" or "Permissions"',
          'Set Microphone to "Allow"'
        ],
        close: 'Got it'
      }
    },
    
    // Scenarios
    scenarios: {
      default: 'Free Chat',
      restaurant: 'At the Restaurant',
      newFriends: 'Meeting New People',
      travel: 'Traveling in Hong Kong',
      shopping: 'Shopping Small Talk',
      workplace: 'Workplace Small Talk'
    },
    
    // Settings
    settings: {
      uiLanguage: 'Interface Language',
      voiceSpeed: 'Voice Speed',
      speedPresets: {
        slow: 'Slow',
        normal: 'Normal',
        fast: 'Fast'
      }
    },
    
    // Recording
    recording: {
      countdown: 'Time Left',
      maxDuration: 'Max Recording'
    },
    
    // Error messages
    errors: {
      noMic: 'Cannot access microphone',
      noSession: 'Please start a new conversation first',
      networkError: 'Network connection error',
      ttsError: 'TTS playback error',
      correctionError: 'Unable to get correction feedback'
    }
  }
};

// Default language
let currentLang = 'zh-TW';

/**
 * Get translation by dot-notation key path
 * @param {string} key - e.g., 'modes.freeChat' or 'input.holdToSpeak'
 * @returns {string} Translation string or the key if not found
 */
export function t(key) {
  const lang = currentLang;
  const value = key.split('.').reduce((obj, k) => obj?.[k], locales[lang]);
  if (value === undefined) {
    console.warn(`i18n: Missing translation for "${key}" in "${lang}"`);
    return key;
  }
  return value;
}

/**
 * Set current language
 * @param {string} lang - 'zh-TW', 'zh-CN', or 'en'
 */
export function setLanguage(lang) {
  if (!locales[lang]) {
    console.warn(`i18n: Unsupported language "${lang}", falling back to zh-TW`);
    lang = 'zh-TW';
  }
  currentLang = lang;
  localStorage.setItem('uiLang', lang);
  document.documentElement.lang = lang === 'zh-TW' ? 'zh-Hant' : lang === 'zh-CN' ? 'zh-Hans' : 'en';
  
  // Dispatch event for components to update
  window.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang } }));
}

/**
 * Get current language
 * @returns {string}
 */
export function getLanguage() {
  return currentLang;
}

/**
 * Initialize i18n from localStorage or browser preference
 */
export function initI18n() {
  const saved = localStorage.getItem('uiLang');
  if (saved && locales[saved]) {
    currentLang = saved;
  } else {
    // Auto-detect from browser
    const browserLang = navigator.language || navigator.userLanguage || 'zh-TW';
    if (browserLang.startsWith('zh-CN') || browserLang === 'zh-Hans') {
      currentLang = 'zh-CN';
    } else if (browserLang.startsWith('en')) {
      currentLang = 'en';
    } else {
      currentLang = 'zh-TW'; // Default to Traditional Chinese
    }
  }
  setLanguage(currentLang);
}

/**
 * Get available languages
 * @returns {Array<{code: string, name: string}>}
 */
export function getAvailableLanguages() {
  return [
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'zh-CN', name: '简体中文' },
    { code: 'en', name: 'English' }
  ];
}

// Export default for convenience
export default { t, setLanguage, getLanguage, initI18n, getAvailableLanguages, locales };
