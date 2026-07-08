/**
 * i18n - Multi-language Interface Support for Cantonese Tutor
 * Phase 3-1: UI Language Toggle
 * Supports: Traditional Chinese (zh-TW), Simplified Chinese (zh-CN), English (en)
 */

export const locales = {
  'zh-TW': {
    // App Title & Header
    appTitle: 'Hong Kong Buddy',
    subtitle: 'HKBU 同學廣東話實戰練習',
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

    pilot: {
      kicker: 'External Pilot',
      title: '一分鐘內開始廣東話探訪支援',
      body: '揀角色、翻譯探訪對話，或者用 MiniMax 廣東話聲線練一句真正用得着嘅短句。',
      actions: {
        visit: '開始探訪翻譯',
        practice: '開始廣東話練習',
        privacy: '私隱同 AI 限制'
      },
      status: {
        voice: {
          label: '聲線',
          pending: '檢查 MiniMax 中...',
          ready: 'MiniMax 廣東話聲線已準備',
          azureFallback: '使用 Azure 語音 fallback',
          mock: '語音暫時使用模擬模式'
        },
        fallback: {
          label: 'Fallback',
          ready: '唔開咪都可以打字使用'
        },
        safety: {
          label: '安全',
          ready: '重要意思請同職員確認'
        }
      },
      notices: {
        visitReady: '探訪翻譯已準備好，可以打字或按住咪高峰。',
        practiceReady: '廣東話練習已準備好，試講一句短句。'
      }
    },

    v2: {
      nav: {
        today: 'Today',
        practice: 'Practice',
        translate: 'Translate',
        phrasebook: 'Phrasebook',
        privacy: 'Privacy'
      },
      today: {
        eyebrow: 'Today',
        title: '今日先練一句廣東話',
        body: '先建立細小而穩定嘅每日習慣；需要即時幫助時再用翻譯。',
        quickStart: '開始今日練習',
        translateShortcut: '打開翻譯器',
        habitLabel: '習慣',
        habitEmpty: '今日未練習',
        habitDone: '今日已練習',
        taskLabel: '推薦',
        taskDefault: '請對方講慢少少',
        voiceLabel: '語音',
        voiceChecking: '檢查語音中...',
        voiceReady: '語音輸入已準備',
        voiceTyping: '以打字為先'
      },
      practice: {
        eyebrow: 'Practice',
        taskTitle: "Today's Cantonese line",
        taskBody: 'Practise asking someone to speak a little slower.',
        coachEyebrow: 'Coach',
        coachTitle: 'One useful note',
        coachEmpty: 'Send one line to get a focused note.',
        modeHabit: 'Daily practice',
        modeTeaching: 'Correction practice',
        modeFree: 'Free talk',
        startFailed: 'Practice could not start. Please try again.'
      },
      translate: {
        eyebrow: 'Translate',
        title: '日常探訪翻譯器',
        body: '當住戶、義工或學生需要快速理解意思時，用呢個功能。',
        inputLabel: '輸入',
        inputEmpty: '未有輸入內容',
        inputHint: '輸入或錄低要翻譯嘅句子。',
        inputSpeech: '語音',
        inputTyped: '打字',
        outputLabel: '輸出',
        confirmLabel: '請同職員確認',
        failedLabel: '翻譯失敗',
        failedBody: '今次請求未完成，但你啱啱輸入嘅內容仲喺度。',
        retryTranslation: '重新翻譯'
      },
      review: {
        label: 'Review',
        empty: 'Complete one line to unlock review.',
        done: 'Today practised. Replay or save one phrase.'
      },
      phrasebook: {
        eyebrow: 'Phrasebook',
        title: 'Useful Cantonese lines',
        body: 'Pick a safe line for practice or visit support.',
        practiceAction: 'Practise this',
        translateAction: 'Use in translator'
      },
      privacy: {
        eyebrow: 'Privacy',
        title: '私隱同 AI 限制',
        body: '避免輸入敏感個人、醫療、法律或可識別學生身份嘅資料。'
      }
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
        body: 'Hong Kong Buddy 由一個好真實嘅需要開始：好多同學想參與香港生活、探訪長者、認識本地朋友，但第一句廣東話往往最難開口。呢個 App 幫你用短句、即時回饋同英文 Coach Notes，將尷尬嘅第一步變成可以練習、可以理解、可以放心嘗試嘅交流。',
        insightTitle: 'User insight',
        insightBody: '同學唔係一開始就需要完美廣東話；佢哋需要一條安全、自然、有人情味嘅開場線。',
        missionTitle: 'Mission',
        missionBody: '幫國際生同新來港同學由「聽唔明、唔敢講」走向「敢打招呼、敢參與、慢慢融入香港」。',
        safetyTitle: 'Human first',
        safetyBody: 'AI 只係練習同翻譯輔助；探訪、文化理解同重要意思，仍然要同職員或本地義工確認。'
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
      hint: '即時口譯',
      liveBadge: '探訪即時口譯',
      consoleTitle: '社區探訪口譯台',
      helper: '只做兩件事：長者講廣東話時譯成英文或普通話；義工講英文或普通話時譯成廣東話。可用咪高峰即時翻譯，嘈雜環境就用打字。',
      speakerPrompt: '揀翻譯方向',
      directionLabel: '翻譯方向',
      translateButton: '翻譯目前文字',
      outputReady: '準備好',
      outputTitle: '先揀上面其中一個任務',
      outputEmpty: '然後喺下面打字，或者按住咪高峰即時翻譯。',
      sourceLabel: '原文',
      autoRouted: '已偵測到英文義工句子，改用「義工英文 → 廣東話」。',
      romanizationLabel: '粵拼發音提示',
      romanizationHelper: '數字代表廣東話聲調，只作閱讀提示。',
      greeting: '探訪口譯台已準備好。先揀「長者講廣東話」或「義工講英文／普通話」，再打字或按住咪高峰。',
      confirmationWarning: 'AI 可能唔準，重要意思請同真人義工或職員確認。',
      tasks: {
        resident: {
          title: '長者講廣東話',
          body: '即時譯成英文或普通話，方便義工讀懂。'
        },
        volunteer: {
          title: '義工講英文或普通話',
          body: '即時譯成禮貌廣東話，方便同長者溝通。'
        }
      },
      groups: {
        resident: '將長者回答譯成',
        volunteer: '將義工說話由呢種語言譯出'
      },
      quickDirections: {
        residentEnglish: {
          title: '英文',
          body: '俾國際義工睇'
        },
        residentMandarin: {
          title: '普通話',
          body: '俾普通話義工睇'
        },
        volunteerEnglish: {
          title: '英文',
          body: '英文問題譯成廣東話'
        },
        volunteerMandarin: {
          title: '普通話',
          body: '普通話問題譯成廣東話'
        }
      },
      directions: {
        en_to_yue: '英文 → 廣東話',
        yue_to_en: '廣東話 → 英文',
        yue_to_zh: '廣東話 → 普通話',
        zh_to_yue: '普通話 → 廣東話'
      },
      placeholders: {
        residentToEnglish: '輸入長者講嘅廣東話，例如：我想飲水。',
        residentToMandarin: '輸入長者講嘅廣東話，例如：今日好開心。',
        volunteerEnglish: 'Type the volunteer’s English line, e.g. Would you like some water?',
        volunteerMandarin: '輸入義工嘅普通話，例如：您想喝水嗎？'
      },
      actions: {
        translateResident: '翻譯長者說話',
        translateVolunteer: '翻譯義工說話',
        translateResidentShort: '翻譯長者',
        translateVolunteerShort: '翻譯義工',
        holdToTranslate: '按住即時翻譯',
        voiceUnavailable: '語音暫不可用',
        recording: '錄音中… 放開即翻譯',
        processingSpeech: '處理語音中…',
        recognizing: '識別中',
        recognized: '已識別'
      },
      routes: {
        residentEnglish: '長者廣東話 → 英文',
        residentMandarin: '長者廣東話 → 普通話',
        volunteerEnglish: '義工英文 → 廣東話',
        volunteerMandarin: '義工普通話 → 廣東話'
      },
      results: {
        residentEnglish: '長者意思（英文）',
        residentMandarin: '長者意思（普通話）',
        volunteerEnglish: '俾長者睇／聽嘅廣東話',
        volunteerMandarin: '俾長者睇／聽嘅廣東話'
      },
      emptyState: {
        title: '準備即時口譯',
        body: '左邊只保留兩個功能：長者廣東話譯成英文／普通話，或義工英文／普通話譯成廣東話。'
      },
      history: {
        inputBadge: '輸入',
        outputBadge: '譯文'
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
      confirmTutorOutput: 'AI 正使用模擬或低信心回應；重要內容請同真人確認。',
      ttsRomanizationSkipped: '呢段似係粵拼發音提示，已避免朗讀聲調數字。請睇廣東話文字或重新輸入。'
    },

    onboarding: {
      changeMode: '轉換模式',
      eyebrow: '由呢度開始',
      title: '你今日想做咩？',
      body: '先揀一條路，Hong Kong Buddy 會優先顯示合適語言、指引同工具。',
      cards: {
        chineseReader: {
          title: '我想練習廣東話',
          body: '適合識普通話、想改善廣東話發音、語氣助詞同自然講法嘅同學。'
        },
        international: {
          title: '我係國際學生',
          body: '英文優先指引，配廣東話音頻、意思同逐步練習。'
        },
        visit: {
          title: '我參與社區探訪活動需要翻譯',
          body: '兩個即時工具：長者廣東話譯成英文或普通話；義工英文或普通話譯成廣東話。'
        }
      },
      selected: {
        eyebrow: '已選模式',
        chineseReader: {
          title: '廣東話練習模式',
          body: '會優先顯示發音、語氣助詞、探訪短句同老師式糾正。'
        },
        international: {
          title: '國際學生模式',
          body: '會用英文解釋先，再配廣東話例句、音頻同練習步驟。'
        },
        visit: {
          title: '探訪翻譯模式',
          body: '只保留兩個探訪口譯功能：長者廣東話 → 英文／普通話，以及義工英文／普通話 → 廣東話。'
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
        visitTranslationComingSoon: '探訪口譯台已準備好；請揀長者說話或義工說話。',
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
      eyebrow: '即時記錄',
      title: '口譯歷史',
      scenarioPrefix: '情景：',
      freeChat: '自由對話',
      sessionNotStarted: '未開始',
      voiceDetecting: '語音：偵測中'
    },
    
    // Input Panel
    input: {
      holdToSpeak: '按住說話',
      voiceUnavailable: '語音暫不可用',
      voiceUnavailableHint: '語音輸入暫時未能使用，請先用打字翻譯。',
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
      currentTutorReply: '最新導師回覆',
      realtimeEnglish: '即時英文翻譯',
      empty: '導師回覆嘅英文翻譯會即時顯示喺呢度。',
      translationLoading: '正在翻譯最新導師回覆…',
      translationSummaryFallback: '暫時未有英文翻譯。',
      translationWarning: '翻譯由 AI 產生；重要意思請同真人確認。',
      translationFailed: '暫時未能取得英文翻譯，請稍後再試。'
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
    subtitle: 'HKBU 同学粤语实战练习',
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

    pilot: {
      kicker: 'External Pilot',
      title: '一分钟内开始粤语探访支援',
      body: '选择角色、翻译探访对话，或者用 MiniMax 粤语声线练一句真正用得上的短句。',
      actions: {
        visit: '开始探访翻译',
        practice: '开始粤语练习',
        privacy: '隐私和 AI 限制'
      },
      status: {
        voice: {
          label: '声线',
          pending: '正在检查 MiniMax...',
          ready: 'MiniMax 粤语声线已准备',
          azureFallback: '使用 Azure 语音 fallback',
          mock: '语音暂时使用模拟模式'
        },
        fallback: {
          label: 'Fallback',
          ready: '不开麦也可以打字使用'
        },
        safety: {
          label: '安全',
          ready: '重要意思请和职员确认'
        }
      },
      notices: {
        visitReady: '探访翻译已准备好，可以打字或按住麦克风。',
        practiceReady: '粤语练习已准备好，试讲一句短句。'
      }
    },

    v2: {
      nav: {
        today: 'Today',
        practice: 'Practice',
        translate: 'Translate',
        phrasebook: 'Phrasebook',
        privacy: 'Privacy'
      },
      today: {
        eyebrow: 'Today',
        title: '今天先练一句粤语',
        body: '先建立一个小而稳的每日习惯；需要即时帮助时再使用翻译。',
        quickStart: '开始今天练习',
        translateShortcut: '打开翻译器',
        habitLabel: '习惯',
        habitEmpty: '今天还没练习',
        habitDone: '今天已练习',
        taskLabel: '推荐',
        taskDefault: '请对方说慢一点',
        voiceLabel: '语音',
        voiceChecking: '正在检查语音...',
        voiceReady: '语音输入已就绪',
        voiceTyping: '以打字为先'
      },
      practice: {
        eyebrow: 'Practice',
        taskTitle: "Today's Cantonese line",
        taskBody: 'Practise asking someone to speak a little slower.',
        coachEyebrow: 'Coach',
        coachTitle: 'One useful note',
        coachEmpty: 'Send one line to get a focused note.',
        modeHabit: 'Daily practice',
        modeTeaching: 'Correction practice',
        modeFree: 'Free talk',
        startFailed: 'Practice could not start. Please try again.'
      },
      translate: {
        eyebrow: 'Translate',
        title: '日常探访翻译器',
        body: '当住户、义工或学生需要快速理解意思时，使用这个功能。',
        inputLabel: '输入',
        inputEmpty: '还没有输入内容',
        inputHint: '输入或录下要翻译的句子。',
        inputSpeech: '语音',
        inputTyped: '打字',
        outputLabel: '输出',
        confirmLabel: '请和职员确认',
        failedLabel: '翻译失败',
        failedBody: '这次请求没有完成，但你刚才输入的内容还在这里。',
        retryTranslation: '重新翻译'
      },
      review: {
        label: 'Review',
        empty: 'Complete one line to unlock review.',
        done: 'Today practised. Replay or save one phrase.'
      },
      phrasebook: {
        eyebrow: 'Phrasebook',
        title: 'Useful Cantonese lines',
        body: 'Pick a safe line for practice or visit support.',
        practiceAction: 'Practise this',
        translateAction: 'Use in translator'
      },
      privacy: {
        eyebrow: 'Privacy',
        title: '隐私和 AI 限制',
        body: '避免输入敏感个人、医疗、法律或可识别学生身份的信息。'
      }
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
        body: 'Hong Kong Buddy 来自一个真实需求：很多同学想参与香港生活、探访长者、认识本地朋友，但第一句广东话往往最难开口。这个 App 通过短句、即时反馈和英文 Coach Notes，把尴尬的第一步变成可以练习、可以理解、可以安心尝试的交流。',
        insightTitle: 'User insight',
        insightBody: '同学一开始不需要完美广东话；他们更需要一句安全、自然、有人情味的开场白。',
        missionTitle: 'Mission',
        missionBody: '帮助国际生和新来港同学从“听不懂、不敢说”走向“敢打招呼、敢参与、慢慢融入香港”。',
        safetyTitle: 'Human first',
        safetyBody: 'AI 只是练习和翻译辅助；探访、文化理解和重要意思，仍然要和工作人员或本地义工确认。'
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
      hint: '实时口译',
      liveBadge: '探访实时口译',
      consoleTitle: '社区探访口译台',
      helper: '只做两件事：长者讲粤语时译成英文或普通话；义工讲英文或普通话时译成粤语。可用麦克风实时翻译，嘈杂环境就用打字。',
      speakerPrompt: '选择翻译方向',
      directionLabel: '翻译方向',
      translateButton: '翻译当前文字',
      outputReady: '准备好',
      outputTitle: '先选择上面其中一个任务',
      outputEmpty: '然后在下面打字，或者按住麦克风实时翻译。',
      sourceLabel: '原文',
      autoRouted: '已检测到英文义工句子，改用“义工英文 → 粤语”。',
      romanizationLabel: '粤拼发音提示',
      romanizationHelper: '数字代表粤语声调，只作阅读提示。',
      greeting: '探访口译台已准备好。先选“长者讲粤语”或“义工讲英文/普通话”，再打字或按住麦克风。',
      confirmationWarning: 'AI 可能不准确，重要意思请和真人义工或工作人员确认。',
      tasks: {
        resident: {
          title: '长者讲粤语',
          body: '实时译成英文或普通话，方便义工读懂。'
        },
        volunteer: {
          title: '义工讲英文或普通话',
          body: '实时译成礼貌粤语，方便和长者沟通。'
        }
      },
      groups: {
        resident: '把长者回答译成',
        volunteer: '把义工说话从这种语言译出'
      },
      quickDirections: {
        residentEnglish: {
          title: '英文',
          body: '给国际义工看'
        },
        residentMandarin: {
          title: '普通话',
          body: '给普通话义工看'
        },
        volunteerEnglish: {
          title: '英文',
          body: '英文问题译成粤语'
        },
        volunteerMandarin: {
          title: '普通话',
          body: '普通话问题译成粤语'
        }
      },
      directions: {
        en_to_yue: '英文 → 粤语',
        yue_to_en: '粤语 → 英文',
        yue_to_zh: '粤语 → 普通话',
        zh_to_yue: '普通话 → 粤语'
      },
      placeholders: {
        residentToEnglish: '输入长者讲的粤语，例如：我想饮水。',
        residentToMandarin: '输入长者讲的粤语，例如：今日好开心。',
        volunteerEnglish: 'Type the volunteer’s English line, e.g. Would you like some water?',
        volunteerMandarin: '输入义工的普通话，例如：您想喝水吗？'
      },
      actions: {
        translateResident: '翻译长者说话',
        translateVolunteer: '翻译义工说话',
        translateResidentShort: '翻译长者',
        translateVolunteerShort: '翻译义工',
        holdToTranslate: '按住实时翻译',
        voiceUnavailable: '语音暂不可用',
        recording: '录音中… 放开即翻译',
        processingSpeech: '处理语音中…',
        recognizing: '识别中',
        recognized: '已识别'
      },
      routes: {
        residentEnglish: '长者粤语 → 英文',
        residentMandarin: '长者粤语 → 普通话',
        volunteerEnglish: '义工英文 → 粤语',
        volunteerMandarin: '义工普通话 → 粤语'
      },
      results: {
        residentEnglish: '长者意思（英文）',
        residentMandarin: '长者意思（普通话）',
        volunteerEnglish: '给长者看/听的粤语',
        volunteerMandarin: '给长者看/听的粤语'
      },
      emptyState: {
        title: '准备实时口译',
        body: '左边只保留两个功能：长者粤语译成英文/普通话，或义工英文/普通话译成粤语。'
      },
      history: {
        inputBadge: '输入',
        outputBadge: '译文'
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
      confirmTutorOutput: 'AI 正在使用模拟或低信心回应；重要内容请和真人确认。',
      ttsRomanizationSkipped: '这段像粤拼发音提示，已避免朗读声调数字。请查看粤语文字或重新输入。'
    },

    onboarding: {
      changeMode: '切换模式',
      eyebrow: '从这里开始',
      title: '你今天想做什么？',
      body: '先选择一条路径，Hong Kong Buddy 会优先显示合适语言、指引和工具。',
      cards: {
        chineseReader: {
          title: '我想练习粤语',
          body: '适合会普通话、想改善粤语发音、语气助词和自然表达的同学。'
        },
        international: {
          title: '我是国际学生',
          body: '英文优先指引，配粤语音频、意思和逐步练习。'
        },
        visit: {
          title: '我参与社区探访活动需要翻译',
          body: '两个实时工具：长者粤语译成英文或普通话；义工英文或普通话译成粤语。'
        }
      },
      selected: {
        eyebrow: '已选模式',
        chineseReader: {
          title: '粤语练习模式',
          body: '会优先显示发音、语气助词、探访短句和老师式纠正。'
        },
        international: {
          title: '国际学生模式',
          body: '会先用英文解释，再配粤语例句、音频和练习步骤。'
        },
        visit: {
          title: '探访翻译模式',
          body: '只保留两个探访口译功能：长者粤语 → 英文/普通话，以及义工英文/普通话 → 粤语。'
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
        visitTranslationComingSoon: '探访口译台已准备好；请选择长者说话或义工说话。',
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
      eyebrow: '实时记录',
      title: '口译历史',
      scenarioPrefix: '情景：',
      freeChat: '自由对话',
      sessionNotStarted: '未开始',
      voiceDetecting: '语音：检测中'
    },
    
    // Input Panel
    input: {
      holdToSpeak: '按住说话',
      voiceUnavailable: '语音暂不可用',
      voiceUnavailableHint: '语音输入暂时不能使用，请先用打字翻译。',
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
      currentTutorReply: '最新导师回复',
      realtimeEnglish: '即时英文翻译',
      empty: '导师回复的英文翻译会即时显示在这里。',
      translationLoading: '正在翻译最新导师回复…',
      translationSummaryFallback: '暂时没有英文翻译。',
      translationWarning: '翻译由 AI 生成；重要意思请和真人确认。',
      translationFailed: '暂时未能取得英文翻译，请稍后再试。'
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
    subtitle: 'Campus Cantonese practice for HKBU students',
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

    pilot: {
      kicker: 'External Pilot',
      title: 'Start a Cantonese visit in under one minute',
      body: 'Choose a role, translate a visit exchange, or practise one useful Cantonese line with MiniMax voice support.',
      actions: {
        visit: 'Start visit translation',
        practice: 'Start Cantonese practice',
        privacy: 'Privacy and AI limits'
      },
      status: {
        voice: {
          label: 'Voice',
          pending: 'Checking MiniMax...',
          ready: 'MiniMax Cantonese voice ready',
          azureFallback: 'Using Azure voice fallback',
          mock: 'Voice is in mock mode'
        },
        fallback: {
          label: 'Fallback',
          ready: 'Typing works without microphone'
        },
        safety: {
          label: 'Safety',
          ready: 'Confirm important meaning with staff'
        }
      },
      notices: {
        visitReady: 'Visit Translation is ready. Type or hold the microphone.',
        practiceReady: 'Cantonese Practice is ready. Try one short line.'
      }
    },

    v2: {
      nav: {
        today: 'Today',
        practice: 'Practice',
        translate: 'Translate',
        phrasebook: 'Phrasebook',
        privacy: 'Privacy'
      },
      today: {
        eyebrow: 'Today',
        title: 'Practise one Cantonese line today',
        body: 'Build a small daily habit first. Translate when you need real-life help.',
        quickStart: "Start today's practice",
        translateShortcut: 'Open translator',
        habitLabel: 'Habit',
        habitEmpty: 'Not practised yet',
        habitDone: 'Practised today',
        taskLabel: 'Recommended',
        taskDefault: 'Ask someone to speak slower',
        voiceLabel: 'Voice',
        voiceChecking: 'Checking voice...',
        voiceReady: 'Voice input ready',
        voiceTyping: 'Typing-first mode'
      },
      practice: {
        eyebrow: 'Practice',
        taskTitle: "Today's Cantonese line",
        taskBody: 'Practise asking someone to speak a little slower.',
        coachEyebrow: 'Coach',
        coachTitle: 'One useful note',
        coachEmpty: 'Send one line to get a focused note.',
        modeHabit: 'Daily practice',
        modeTeaching: 'Correction practice',
        modeFree: 'Free talk',
        startFailed: 'Practice could not start. Please try again.'
      },
      translate: {
        eyebrow: 'Translate',
        title: 'Daily-life visit translator',
        body: 'Use this when a resident, volunteer, or student needs fast meaning support.',
        inputLabel: 'Input',
        inputEmpty: 'No input yet',
        inputHint: 'Type or record the sentence to translate.',
        inputSpeech: 'Speech',
        inputTyped: 'Typed',
        outputLabel: 'Output',
        confirmLabel: 'Confirm with staff',
        failedLabel: 'Translation failed',
        failedBody: 'The request did not complete. Your input is still here.',
        retryTranslation: 'Retry translation'
      },
      review: {
        label: 'Review',
        empty: 'Complete one line to unlock review.',
        done: 'Today practised. Replay or save one phrase.'
      },
      phrasebook: {
        eyebrow: 'Phrasebook',
        title: 'Useful Cantonese lines',
        body: 'Pick a safe line for practice or visit support.',
        practiceAction: 'Practise this',
        translateAction: 'Use in translator'
      },
      privacy: {
        eyebrow: 'Privacy',
        title: 'Privacy and AI limits',
        body: 'Avoid sensitive personal, medical, legal, or student-identifying information.'
      }
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
        body: 'Hong Kong Buddy starts from a real student moment: you want to join Hong Kong life, visit elders, or make local friends, but the first Cantonese sentence feels hard. The app turns that first step into something you can practise, understand, and try with confidence through short phrases, real-time feedback, and English Coach Notes.',
        insightTitle: 'User insight',
        insightBody: 'Students do not need perfect Cantonese on day one; they need one safe, natural, human line to begin.',
        missionTitle: 'Mission',
        missionBody: 'Help international and newly arrived students move from “I do not understand” to “I can greet, join in, and slowly belong in Hong Kong.”',
        safetyTitle: 'Human first',
        safetyBody: 'AI supports practice and translation. For visits, culture, and important meaning, confirm with staff or local volunteers.'
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
      hint: 'Live interpreter',
      liveBadge: 'Live visit interpreter',
      consoleTitle: 'Community visit interpreter',
      helper: 'Only two jobs: translate a resident’s Cantonese into English or Mandarin, or translate a volunteer’s English or Mandarin into Cantonese. Use the microphone for live speech or type when the room is noisy.',
      speakerPrompt: 'Choose translation direction',
      directionLabel: 'Direction',
      translateButton: 'Translate current text',
      outputReady: 'Ready',
      outputTitle: 'Choose one task above',
      outputEmpty: 'Then type below or hold the microphone to translate.',
      sourceLabel: 'Source',
      autoRouted: 'Detected an English volunteer line, switched to Volunteer English → Cantonese.',
      romanizationLabel: 'Jyutping pronunciation guide',
      romanizationHelper: 'Numbers show Cantonese tones and are for reading only.',
      greeting: 'The visit interpreter is ready. Choose “Resident speaks Cantonese” or “Volunteer speaks English or Mandarin”, then type or hold the microphone.',
      confirmationWarning: 'AI may be inaccurate. Confirm important meaning with a volunteer or staff member.',
      tasks: {
        resident: {
          title: 'Resident speaks Cantonese',
          body: 'Translate the resident’s Cantonese into English or Mandarin.'
        },
        volunteer: {
          title: 'Volunteer speaks English or Mandarin',
          body: 'Translate the volunteer’s line into polite Cantonese.'
        }
      },
      groups: {
        resident: 'Translate resident answer to',
        volunteer: 'Translate volunteer line from'
      },
      quickDirections: {
        residentEnglish: {
          title: 'English',
          body: 'For international volunteers'
        },
        residentMandarin: {
          title: 'Mandarin',
          body: 'For Mandarin-speaking volunteers'
        },
        volunteerEnglish: {
          title: 'English',
          body: 'English question to Cantonese'
        },
        volunteerMandarin: {
          title: 'Mandarin',
          body: 'Mandarin question to Cantonese'
        }
      },
      directions: {
        en_to_yue: 'English → Cantonese',
        yue_to_en: 'Cantonese → English',
        yue_to_zh: 'Cantonese → Mandarin',
        zh_to_yue: 'Mandarin → Cantonese'
      },
      placeholders: {
        residentToEnglish: 'Type what the resident said in Cantonese, e.g. 我想飲水。',
        residentToMandarin: 'Type what the resident said in Cantonese, e.g. 今日好開心。',
        volunteerEnglish: 'Type the volunteer’s English line, e.g. Would you like some water?',
        volunteerMandarin: 'Type the volunteer’s Mandarin line, e.g. 您想喝水吗？'
      },
      actions: {
        translateResident: 'Translate resident speech',
        translateVolunteer: 'Translate volunteer line',
        translateResidentShort: 'Translate resident',
        translateVolunteerShort: 'Translate volunteer',
        holdToTranslate: 'Hold to translate live',
        voiceUnavailable: 'Voice unavailable',
        recording: 'Recording… release to translate',
        processingSpeech: 'Processing speech…',
        recognizing: 'Recognizing',
        recognized: 'Recognized'
      },
      routes: {
        residentEnglish: 'Resident Cantonese → English',
        residentMandarin: 'Resident Cantonese → Mandarin',
        volunteerEnglish: 'Volunteer English → Cantonese',
        volunteerMandarin: 'Volunteer Mandarin → Cantonese'
      },
      results: {
        residentEnglish: 'Resident meaning in English',
        residentMandarin: 'Resident meaning in Mandarin',
        volunteerEnglish: 'Cantonese for the resident',
        volunteerMandarin: 'Cantonese for the resident'
      },
      emptyState: {
        title: 'Ready for live interpreting',
        body: 'The left panel now has only two jobs: resident Cantonese to English/Mandarin, or volunteer English/Mandarin to Cantonese.'
      },
      history: {
        inputBadge: 'Input',
        outputBadge: 'Translation'
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
      confirmTutorOutput: 'AI is using mock or lower-confidence output. Confirm important meaning with a person.',
      ttsRomanizationSkipped: 'This looks like a Jyutping pronunciation guide, so audio was skipped to avoid reading tone numbers aloud.'
    },

    onboarding: {
      changeMode: 'Change mode',
      eyebrow: 'Start here',
      title: 'What do you need today?',
      body: 'Choose one path so Hong Kong Buddy shows the right language, guidance, and tools first.',
      cards: {
        chineseReader: {
          title: 'I want to practise Cantonese',
          body: 'Best for Mandarin speakers who want better Cantonese pronunciation, particles, and natural phrasing.'
        },
        international: {
          title: 'I am an international student',
          body: 'English-first help with Cantonese audio, meaning, and practice steps.'
        },
        visit: {
          title: 'I need translation for a community visit',
          body: 'Two live tools for visits: resident Cantonese to English or Mandarin, and volunteer English or Mandarin to Cantonese.'
        }
      },
      selected: {
        eyebrow: 'Selected mode',
        chineseReader: {
          title: 'Cantonese Practice Mode',
          body: 'Pronunciation, particles, visit phrases, and teacher-style correction are prioritised.'
        },
        international: {
          title: 'International Student Mode',
          body: 'Guidance appears in English first, with Cantonese examples, audio, and practice steps.'
        },
        visit: {
          title: 'Visit Translation Mode',
          body: 'Only two live interpreting tools are shown: resident Cantonese to English/Mandarin, and volunteer English/Mandarin to Cantonese.'
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
        visitTranslationComingSoon: 'The visit interpreter is ready. Choose resident speech or volunteer speech.',
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
      eyebrow: 'Live log',
      title: 'Interpreter history',
      scenarioPrefix: 'Scenario: ',
      freeChat: 'Free Chat',
      sessionNotStarted: 'Not Started',
      voiceDetecting: 'Voice: Detecting'
    },
    
    // Input Panel
    input: {
      holdToSpeak: 'Hold to Speak',
      voiceUnavailable: 'Voice unavailable',
      voiceUnavailableHint: 'Voice input is temporarily unavailable. Please use typing for this pilot.',
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
      currentTutorReply: 'Latest tutor reply',
      realtimeEnglish: 'Real-time English translation',
      empty: 'The English translation of the tutor reply will appear here in real time.',
      translationLoading: 'Translating the latest tutor reply…',
      translationSummaryFallback: 'No English translation yet.',
      translationWarning: 'Translation is AI-generated. Confirm important meaning with a person.',
      translationFailed: 'English translation is unavailable right now. Please try again.'
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
