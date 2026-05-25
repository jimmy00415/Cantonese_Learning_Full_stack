/**
 * i18n - Multi-language Interface Support for Cantonese Tutor
 * Phase 3-1: UI Language Toggle
 * Supports: Traditional Chinese (zh-TW), Simplified Chinese (zh-CN), English (en)
 */

export const locales = {
  'zh-TW': {
    // App Title & Header
    appTitle: 'Hong Kong Buddy',
    subtitle: '國際學生廣東話實戰練習',
    badges: {
      aiTutor: '校園廣東話',
      voiceChat: '語音教練',
      realFeedback: '文化提示'
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
      kicker: 'Campus Cantonese Sprint',
      title: '學會真正用得到嘅香港生活廣東話',
      body: '練習飯堂、港鐵、小組功課、識新朋友同本地文化語感，由 AI 教練用廣東話即時回應。'
    },

    onboarding: {
      changeMode: '轉換模式',
      eyebrow: '由呢度開始',
      title: '你今日想做咩？',
      body: '先揀一條路，Hong Kong Buddy 會優先顯示合適語言、指引同工具。',
      cards: {
        mainland: {
          title: '我想練習廣東話',
          body: '適合識中文、想改善廣東話發音、語氣助詞同自然講法嘅內地學生。'
        },
        international: {
          title: '我係國際學生',
          body: '英文優先指引，配廣東話音頻、意思同逐步練習。'
        },
        visit: {
          title: '我探訪期間需要翻譯',
          body: '為 HKBU 探訪活動而設嘅簡化路徑，支援大字、常用短句同音頻。'
        }
      },
      selected: {
        eyebrow: '已選模式',
        mainland: {
          title: '廣東話練習模式',
          body: '會優先顯示發音、語氣助詞、探訪短句同老師式糾正。'
        },
        international: {
          title: '國際學生模式',
          body: '會用英文解釋先，再配廣東話例句、音頻同練習步驟。'
        },
        visit: {
          title: '探訪翻譯模式',
          body: '先保留一個主要行動：開始探訪翻譯。完整翻譯介面會喺下一個任務補上。'
        }
      },
      actions: {
        pronunciation: '開始發音練習',
        particles: '練習語氣助詞',
        prepareVisit: '睇探訪前指引',
        survivalCantonese: '學基本廣東話',
        startVisitTranslation: '開始探訪翻譯',
        readVisitGuide: '睇探訪指引',
        changeMode: '重新選擇模式'
      },
      notices: {
        visitTranslationComingSoon: '探訪翻譯入口已準備好；完整翻譯功能會喺下一步加入。',
        visitGuideComingSoon: '探訪前指引會喺下一步加入。'
      }
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
      newSession: '開始任務',
      clearChat: '清除記錄'
    },
    
    // Starter Section
    starter: {
      header: '開場建議',
      hint: '智能句子卡'
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
      textPlaceholder: '試下：唔該，我想練習廣東話...',
      voice: '聲線',
      speed: '速度',
      replay: '重播',
      correctMe: 'Correct Me',
      send: '發送'
    },
    
    // Feedback
    feedback: {
      immediate: 'Coach Notes',
      details: 'Deep Dive'
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
    appTitle: 'Hong Kong Buddy',
    subtitle: '国际学生粤语实战练习',
    badges: {
      aiTutor: '校园粤语',
      voiceChat: '语音教练',
      realFeedback: '文化提示'
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
      kicker: 'Campus Cantonese Sprint',
      title: '学会真正用得到的香港生活粤语',
      body: '练习饭堂、港铁、小组作业、认识新朋友和本地文化语感，由 AI 教练用粤语即时回应。'
    },

    onboarding: {
      changeMode: '切换模式',
      eyebrow: '从这里开始',
      title: '你今天想做什么？',
      body: '先选择一条路径，Hong Kong Buddy 会优先显示合适语言、指引和工具。',
      cards: {
        mainland: {
          title: '我想练习粤语',
          body: '适合会读中文、想改善粤语发音、语气助词和自然表达的内地学生。'
        },
        international: {
          title: '我是国际学生',
          body: '英文优先指引，配粤语音频、意思和逐步练习。'
        },
        visit: {
          title: '我探访期间需要翻译',
          body: '为 HKBU 探访活动而设的简化路径，支持大字、常用短句和音频。'
        }
      },
      selected: {
        eyebrow: '已选模式',
        mainland: {
          title: '粤语练习模式',
          body: '会优先显示发音、语气助词、探访短句和老师式纠正。'
        },
        international: {
          title: '国际学生模式',
          body: '会先用英文解释，再配粤语例句、音频和练习步骤。'
        },
        visit: {
          title: '探访翻译模式',
          body: '先保留一个主要行动：开始探访翻译。完整翻译界面会在下一项任务补上。'
        }
      },
      actions: {
        pronunciation: '开始发音练习',
        particles: '练习语气助词',
        prepareVisit: '查看探访前指引',
        survivalCantonese: '学习基本粤语',
        startVisitTranslation: '开始探访翻译',
        readVisitGuide: '查看探访指引',
        changeMode: '重新选择模式'
      },
      notices: {
        visitTranslationComingSoon: '探访翻译入口已准备好；完整翻译功能会在下一步加入。',
        visitGuideComingSoon: '探访前指引会在下一步加入。'
      }
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
      newSession: '开始任务',
      clearChat: '清除记录'
    },
    
    // Starter Section
    starter: {
      header: '开场建议',
      hint: '智能句子卡'
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
      textPlaceholder: '试试：唔该，我想练习粤语...',
      voice: '声线',
      speed: '速度',
      replay: '重播',
      correctMe: 'Correct Me',
      send: '发送'
    },
    
    // Feedback
    feedback: {
      immediate: 'Coach Notes',
      details: 'Deep Dive'
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
    appTitle: 'Hong Kong Buddy',
    subtitle: 'Campus Cantonese practice for international students',
    badges: {
      aiTutor: 'Campus-ready',
      voiceChat: 'Voice coach',
      realFeedback: 'Culture signals'
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
      kicker: 'Campus Cantonese Sprint',
      title: 'Speak Cantonese for real Hong Kong student life',
      body: 'Practice restaurant orders, MTR moments, group-project small talk, and culture cues with an AI coach that answers in Cantonese voice.'
    },

    onboarding: {
      changeMode: 'Change mode',
      eyebrow: 'Start here',
      title: 'What do you need today?',
      body: 'Choose one path so Hong Kong Buddy shows the right language, guidance, and tools first.',
      cards: {
        mainland: {
          title: 'I want to practise Cantonese',
          body: 'Best for Mainland students who read Chinese and want pronunciation, particles, and natural phrasing.'
        },
        international: {
          title: 'I am an international student',
          body: 'English-first help with Cantonese audio, meaning, and practice steps.'
        },
        visit: {
          title: 'I need translation during a visit',
          body: 'A simple path for HKBU activity visits with large text, quick phrases, and audio.'
        }
      },
      selected: {
        eyebrow: 'Selected mode',
        mainland: {
          title: 'Cantonese Practice Mode',
          body: 'Pronunciation, particles, visit phrases, and teacher-style correction are prioritised.'
        },
        international: {
          title: 'International Student Mode',
          body: 'Guidance appears in English first, with Cantonese examples, audio, and practice steps.'
        },
        visit: {
          title: 'Visit Translation Mode',
          body: 'One primary action is ready: Start Visit Translation. The full translation interface is the next implementation task.'
        }
      },
      actions: {
        pronunciation: 'Start pronunciation practice',
        particles: 'Practise Cantonese particles',
        prepareVisit: 'Read before-visit guide',
        survivalCantonese: 'Learn survival Cantonese',
        startVisitTranslation: 'Start Visit Translation',
        readVisitGuide: 'Read visit guide',
        changeMode: 'Choose another mode'
      },
      notices: {
        visitTranslationComingSoon: 'Visit Translation entry is ready; the full translation workflow will be added next.',
        visitGuideComingSoon: 'The before-visit guide will be added next.'
      }
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
      newSession: 'Start Mission',
      clearChat: 'Clear History'
    },
    
    // Starter Section
    starter: {
      header: 'Conversation Starters',
      hint: 'Smart phrase cards'
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
      textPlaceholder: 'Try: m4 goi1, ngo5 soeng2 lin6 zaap6 gwong2 dung1 waa2',
      voice: 'Voice',
      speed: 'Speed',
      replay: 'Replay',
      correctMe: 'Correct Me',
      send: 'Send'
    },
    
    // Feedback
    feedback: {
      immediate: 'Coach Notes',
      details: 'Deep Dive'
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
