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

    guide: {
      nav: {
        guide: '使用指引',
        about: '關於',
        privacy: '私隱'
      },
      eyebrow: '使用指引',
      title: '點樣喺活動入面使用 Hong Kong Buddy',
      body: '探訪或廣東話練習前、中、後，都可以跟住呢個流程使用。',
      before: {
        title: '探訪前',
        body: '先揀角色，學禮貌問候，練發音，並睇清楚私隱提醒。',
        step1: '選擇國際學生或探訪翻譯模式。',
        step2: '用粵拼同意思練習短問候句。',
        step3: '唔好記錄私人或敏感資料。'
      },
      during: {
        title: '探訪期間',
        body: '用短句、確認意思，需要時顯示大字，並請 AI 講簡單啲。',
        step1: '由一句問候或關心短句開始。',
        step2: '環境嘈或唔適合用咪時，可以改用打字。',
        step3: '重要意思要同真人義工再確認。'
      },
      after: {
        title: '探訪後',
        body: '重溫有用短句、回報令人混亂嘅 AI 回答，必要時清除本地練習記錄。',
        step1: '只儲存之後想練、而且唔敏感嘅短句。',
        step2: '用「Correct Me」重溫自己講過嘅廣東話。',
        step3: '如果答案錯、唔安全或文化上唔清楚，要同職員講。'
      },
      about: {
        title: '關於呢個 App',
        body: 'Hong Kong Buddy 係 AI 廣東話練習助手，用於學生生活同受監督嘅 HKBU 活動支援。佢係學習同翻譯輔助工具，唔可以取代職員判斷。'
      },
      privacy: {
        title: '私隱同 AI 限制',
        body: '麥克風係自選使用。打字或語音練習可能會送去已設定嘅 AI 供應商產生回應。請避免輸入姓名、地址、醫療資料、學生編號同其他敏感資料。'
      }
    },

    simplify: {
      actions: {
        practice: {
          title: '開始練習',
          body: '直接講或打一句。'
        },
        guide: {
          title: '探訪指引',
          body: '睇探訪前、中、後步驟。'
        },
        playbook: {
          title: '常用短句',
          body: '打開長者探訪 phrasebook。'
        },
        privacy: {
          title: '私隱優先',
          body: '查看 AI 同麥克風限制。'
        }
      }
    },

    playbook: {
      eyebrow: '長者探訪 Playbook',
      title: '探訪長者前、中、後點做',
      body: '英文優先短句配廣東話、粵拼、意思，並可快速進入探訪翻譯。',
      phases: {
        before: '探訪前',
        during: '探訪期間',
        after: '探訪後'
      },
      categories: {
        greeting: '問候',
        comfort: '關心',
        closing: '告別'
      },
      actions: {
        startTranslation: '開始探訪翻譯',
        clearPhrase: '清除已選短句',
        usePhrase: '使用呢句'
      },
      largeText: {
        title: '大字顯示',
        empty: '選擇一句常用短句，會顯示喺呢度。'
      },
      safety: {
        title: '安全提醒',
        body: '唔好將 AI 當成醫療、法律或社工權威；唔肯定時要問職員。'
      },
      notices: {
        phraseLoaded: '已載入探訪短句，可送出練習或俾對方睇。'
      }
    },

    visitTranslate: {
      title: '探訪翻譯',
      hint: '大字輔助',
      directionLabel: '翻譯方向',
      translateButton: '翻譯目前文字',
      outputTitle: '翻譯結果',
      outputEmpty: '喺下面輸入一句，然後按翻譯。',
      sourceLabel: '原文',
      greeting: '探訪翻譯已準備好。輸入或講一句短句，然後按翻譯。',
      confirmationWarning: 'AI 可能唔準，重要意思請同真人義工或職員確認。',
      directions: {
        en_to_yue: '英文 → 廣東話',
        yue_to_en: '廣東話 → 英文',
        yue_to_zh: '廣東話 → 中文',
        zh_to_yue: '中文 → 廣東話'
      },
      notices: {
        emptyInput: '請先輸入要翻譯嘅句子。',
        translating: '翻譯中...',
        done: '翻譯完成。',
        failed: '翻譯失敗，請重試或改用短句。',
        confirmWithStaff: '翻譯已完成；請同職員確認重要意思。'
      }
    },

    reliability: {
      confirmTutorOutput: 'AI 正使用模擬或低信心回應；重要內容請同真人確認。'
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
        visitGuideComingSoon: '探訪前指引會喺下一步加入。',
        visitGuideReady: '已打開探訪使用指引。'
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
      details: 'Deep Dive',
      deepPrompt: '保持頁面簡潔，需要時再打開詳細說明。',
      openDetails: '查看練習細節',
      viewTranslation: '查看英文翻譯',
      latestLine: '最新一句',
      empty: '好開始。先用一句短而真實嘅生活句子繼續練習。',
      translationEyebrow: '英文支援',
      translationTitle: '對話英文翻譯',
      translationLoading: '正在整理英文翻譯…',
      translationSummaryFallback: '以下係目前對話嘅英文意思。',
      translationWarning: '翻譯由 AI 產生；重要意思請同真人確認。',
      translationFailed: '暫時未能取得英文翻譯，請稍後再試。',
      noConversation: '請先開始一段對話。',
      tutorRole: '導師',
      learnerRole: '學生',
      detailsEyebrow: '練習細節',
      detailsTitle: 'Coach note 詳細說明',
      yourLine: '你講嘅句子',
      coachNote: 'Coach note',
      why: '原因',
      tryAgain: '再試一次',
      close: '關閉'
    },
    
    // Dialogs
    dialogs: {
      micPermission: {
        title: '麥克風權限',
        body: '我哋需要您嘅麥克風權限，先可以聽到您嘅廣東話發音並提供反饋。',
        privacyLink: '查看私隱同 AI 限制',
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

    guide: {
      nav: {
        guide: '使用指引',
        about: '关于',
        privacy: '隐私'
      },
      eyebrow: '使用指引',
      title: '如何在活动中使用 Hong Kong Buddy',
      body: '探访或粤语练习前、中、后，都可以跟着这个流程使用。',
      before: {
        title: '探访前',
        body: '先选择角色，学习礼貌问候，练习发音，并看清楚隐私提醒。',
        step1: '选择国际学生或探访翻译模式。',
        step2: '用粤拼和意思练习短问候句。',
        step3: '不要记录私人或敏感资料。'
      },
      during: {
        title: '探访期间',
        body: '用短句、确认意思，需要时显示大字，并请 AI 说简单一点。',
        step1: '由一句问候或关心短句开始。',
        step2: '环境嘈杂或不适合用麦克风时，可以改用打字。',
        step3: '重要意思要和真人义工再确认。'
      },
      after: {
        title: '探访后',
        body: '重温有用短句、回报令人混乱的 AI 回答，必要时清除本地练习记录。',
        step1: '只保存之后想练、而且不敏感的短句。',
        step2: '用“Correct Me”重温自己讲过的粤语。',
        step3: '如果答案错误、不安全或文化上不清楚，要告诉工作人员。'
      },
      about: {
        title: '关于这个 App',
        body: 'Hong Kong Buddy 是 AI 粤语练习助手，用于学生生活和受监督的 HKBU 活动支援。它是学习和翻译辅助工具，不能取代工作人员判断。'
      },
      privacy: {
        title: '隐私和 AI 限制',
        body: '麦克风是自选使用。打字或语音练习可能会发送给已设置的 AI 供应商生成回应。请避免输入姓名、地址、医疗资料、学生编号和其他敏感资料。'
      }
    },

    simplify: {
      actions: {
        practice: {
          title: '开始练习',
          body: '直接说或打一短句。'
        },
        guide: {
          title: '探访指引',
          body: '查看探访前、中、后步骤。'
        },
        playbook: {
          title: '常用短句',
          body: '打开长者探访 phrasebook。'
        },
        privacy: {
          title: '隐私优先',
          body: '查看 AI 和麦克风限制。'
        }
      }
    },

    playbook: {
      eyebrow: '长者探访 Playbook',
      title: '探访长者前、中、后怎么做',
      body: '英文优先短句配粤语、粤拼、意思，并可快速进入探访翻译。',
      phases: {
        before: '探访前',
        during: '探访期间',
        after: '探访后'
      },
      categories: {
        greeting: '问候',
        comfort: '关心',
        closing: '告别'
      },
      actions: {
        startTranslation: '开始探访翻译',
        clearPhrase: '清除已选短句',
        usePhrase: '使用这句'
      },
      largeText: {
        title: '大字显示',
        empty: '选择一句常用短句，会显示在这里。'
      },
      safety: {
        title: '安全提醒',
        body: '不要把 AI 当成医疗、法律或社工权威；不确定时要询问工作人员。'
      },
      notices: {
        phraseLoaded: '已载入探访短句，可发送练习或给对方看。'
      }
    },

    visitTranslate: {
      title: '探访翻译',
      hint: '大字辅助',
      directionLabel: '翻译方向',
      translateButton: '翻译当前文字',
      outputTitle: '翻译结果',
      outputEmpty: '在下面输入一句，然后按翻译。',
      sourceLabel: '原文',
      greeting: '探访翻译已准备好。输入或说一句短句，然后按翻译。',
      confirmationWarning: 'AI 可能不准确，重要意思请和真人义工或工作人员确认。',
      directions: {
        en_to_yue: '英文 → 粤语',
        yue_to_en: '粤语 → 英文',
        yue_to_zh: '粤语 → 中文',
        zh_to_yue: '中文 → 粤语'
      },
      notices: {
        emptyInput: '请先输入要翻译的句子。',
        translating: '翻译中...',
        done: '翻译完成。',
        failed: '翻译失败，请重试或改用短句。',
        confirmWithStaff: '翻译已完成；请和工作人员确认重要意思。'
      }
    },

    reliability: {
      confirmTutorOutput: 'AI 正在使用模拟或低信心回应；重要内容请和真人确认。'
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
        visitGuideComingSoon: '探访前指引会在下一步加入。',
        visitGuideReady: '已打开探访使用指引。'
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
      details: 'Deep Dive',
      deepPrompt: '保持页面简洁，需要时再打开详细说明。',
      openDetails: '查看练习细节',
      viewTranslation: '查看英文翻译',
      latestLine: '最新一句',
      empty: '很好的开始。先用一句短而真实的生活句子继续练习。',
      translationEyebrow: '英文支援',
      translationTitle: '对话英文翻译',
      translationLoading: '正在整理英文翻译…',
      translationSummaryFallback: '以下是目前对话的英文意思。',
      translationWarning: '翻译由 AI 生成；重要意思请和真人确认。',
      translationFailed: '暂时未能取得英文翻译，请稍后再试。',
      noConversation: '请先开始一段对话。',
      tutorRole: '导师',
      learnerRole: '学生',
      detailsEyebrow: '练习细节',
      detailsTitle: 'Coach note 详细说明',
      yourLine: '你说的句子',
      coachNote: 'Coach note',
      why: '原因',
      tryAgain: '再试一次',
      close: '关闭'
    },
    
    // Dialogs
    dialogs: {
      micPermission: {
        title: '麦克风权限',
        body: '我们需要您的麦克风权限，才可以听到您的粤语发音并提供反馈。',
        privacyLink: '查看隐私和 AI 限制',
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

    guide: {
      nav: {
        guide: 'Guide',
        about: 'About',
        privacy: 'Privacy'
      },
      eyebrow: 'User guide',
      title: 'How to use Hong Kong Buddy in an activity',
      body: 'Use this guide before, during, and after a Cantonese practice or HKBU visit activity.',
      before: {
        title: 'Before the visit',
        body: 'Choose your role, learn polite greetings, practise pronunciation, and check the privacy reminder.',
        step1: 'Pick International Student or Visit Translation mode.',
        step2: 'Practise short greetings with Jyutping and meaning.',
        step3: 'Do not record private or sensitive information.'
      },
      during: {
        title: 'During the visit',
        body: 'Use short sentences, confirm meaning, show large text when helpful, and ask the AI to simplify.',
        step1: 'Start with one greeting or comfort-check phrase.',
        step2: 'Type if the room is noisy or microphone use is not appropriate.',
        step3: 'Confirm important meanings with a human volunteer.'
      },
      after: {
        title: 'After the visit',
        body: 'Review useful phrases, report confusing AI output, and clear local practice notes when needed.',
        step1: 'Save only non-sensitive phrases you want to practise again.',
        step2: 'Use Correct Me to review your own Cantonese line.',
        step3: 'Tell staff if an answer felt wrong, unsafe, or culturally unclear.'
      },
      about: {
        title: 'About this app',
        body: 'Hong Kong Buddy is an AI Cantonese practice assistant for student life and supervised HKBU activity support. It is a learning and translation aid, not a replacement for staff judgement.'
      },
      privacy: {
        title: 'Privacy and AI limits',
        body: 'Microphone access is optional. Typed and spoken practice may be sent to configured AI providers to generate responses. Avoid names, addresses, medical details, student IDs, and other sensitive information.'
      }
    },

    simplify: {
      actions: {
        practice: {
          title: 'Start practice',
          body: 'Go straight to speaking or typing.'
        },
        guide: {
          title: 'Visit guide',
          body: 'Before, during, and after steps.'
        },
        playbook: {
          title: 'Phrasebook',
          body: 'Open elderly-visit quick phrases.'
        },
        privacy: {
          title: 'Privacy first',
          body: 'Check AI and microphone limits.'
        }
      }
    },

    playbook: {
      eyebrow: 'Elderly visit playbook',
      title: 'Before, during, and after an elderly home visit',
      body: 'English-first phrases with Cantonese, Jyutping, meaning, and a quick path into visit translation.',
      phases: {
        before: 'Before',
        during: 'During',
        after: 'After'
      },
      categories: {
        greeting: 'Greeting',
        comfort: 'Comfort check',
        closing: 'Closing'
      },
      actions: {
        startTranslation: 'Start Visit Translation',
        clearPhrase: 'Clear selected phrase',
        usePhrase: 'Use this phrase'
      },
      largeText: {
        title: 'Large-text display',
        empty: 'Choose a quick phrase to show it here.'
      },
      safety: {
        title: 'Safety note',
        body: 'Do not use AI as medical, legal, or social-work authority. Ask staff when unsure.'
      },
      notices: {
        phraseLoaded: 'Visit phrase loaded. You can send it for practice or show it to the resident.'
      }
    },

    visitTranslate: {
      title: 'Visit translation',
      hint: 'Large-text helper',
      directionLabel: 'Direction',
      translateButton: 'Translate current text',
      outputTitle: 'Translated text',
      outputEmpty: 'Type a sentence below, then translate.',
      sourceLabel: 'Source',
      greeting: 'Visit translation is ready. Type or speak one short sentence, then translate.',
      confirmationWarning: 'AI may be inaccurate. Confirm important meaning with a volunteer or staff member.',
      directions: {
        en_to_yue: 'English → Cantonese',
        yue_to_en: 'Cantonese → English',
        yue_to_zh: 'Cantonese → Chinese',
        zh_to_yue: 'Chinese → Cantonese'
      },
      notices: {
        emptyInput: 'Type a sentence to translate first.',
        translating: 'Translating...',
        done: 'Translation ready.',
        failed: 'Translation failed. Try again with a shorter sentence.',
        confirmWithStaff: 'Translation ready; confirm important meaning with staff.'
      }
    },

    reliability: {
      confirmTutorOutput: 'AI is using mock or lower-confidence output. Confirm important meaning with a person.'
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
        visitGuideComingSoon: 'The before-visit guide will be added next.',
        visitGuideReady: 'Visit guide opened.'
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
      details: 'Deep Dive',
      deepPrompt: 'Keep the page focused. Open details only when you need them.',
      openDetails: 'Open practice details',
      viewTranslation: 'View English translation',
      latestLine: 'Latest line',
      empty: 'Nice start. Keep going with one short, real-life sentence.',
      translationEyebrow: 'English support',
      translationTitle: 'Conversation translation',
      translationLoading: 'Preparing the English translation…',
      translationSummaryFallback: 'Here is the English meaning of the current conversation.',
      translationWarning: 'Translation is AI-generated. Confirm important meaning with a person.',
      translationFailed: 'English translation is unavailable right now. Please try again.',
      noConversation: 'Start a conversation first.',
      tutorRole: 'Tutor',
      learnerRole: 'Learner',
      detailsEyebrow: 'Practice details',
      detailsTitle: 'Coach note details',
      yourLine: 'Your line',
      coachNote: 'Coach note',
      why: 'Why',
      tryAgain: 'Try again',
      close: 'Close'
    },
    
    // Dialogs
    dialogs: {
      micPermission: {
        title: 'Microphone Access',
        body: 'We need microphone access to hear your Cantonese pronunciation and provide feedback.',
        privacyLink: 'View privacy and AI limits',
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
