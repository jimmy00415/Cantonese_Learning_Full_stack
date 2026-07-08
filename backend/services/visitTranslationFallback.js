const GENERIC_VISIT_TRANSLATION_PATTERNS = [
  /The resident said something in Cantonese/i,
  /Please ask staff to confirm the exact meaning/i,
  /长者.*粤语.*确认/,
  /長者.*粵語.*確認/,
  /請.*職員.*確認/,
  /请.*工作人员.*确认/
];

const FOOD_TERMS = [
  {
    pattern: /紅燒肉|红烧肉/,
    english: 'red-braised pork',
    mandarin: '紅燒肉'
  },
  {
    pattern: /叉燒|叉烧/,
    english: 'char siu',
    mandarin: '叉燒'
  },
  {
    pattern: /點心|点心/,
    english: 'dim sum',
    mandarin: '點心'
  },
  {
    pattern: /燒賣|烧卖/,
    english: 'siu mai',
    mandarin: '燒賣'
  },
  {
    pattern: /粥/,
    english: 'congee',
    mandarin: '粥'
  }
];

function normalizeVisitText(text) {
  return String(text || '')
    .replace(/\bmore\s*guy\b/gi, '唔該')
    .replace(/\bm4\s*goi(?:1)?\b/gi, '唔該')
    .replace(/[，。！？,.!?？]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function visitResult(displayText, options = {}) {
  const text = String(displayText || '').trim();
  return {
    translatedText: text,
    displayText: text,
    speakableText: options.speakableText || '',
    romanization: options.romanization || null,
    needsConfirmation: Boolean(options.needsConfirmation)
  };
}

function jyutping(text) {
  return { scheme: 'jyutping', text, toneNumbers: true };
}

const COMMON_VISIT_RULES = [
  {
    patterns: {
      cantonese: [/我.*(想|要|飲|喝).*水/, /我.*口渴/, /唔該.*水/],
      english: [/water|drink|thirsty/],
      mandarin: [/我.*(想|要|喝).*水/, /口渴/]
    },
    outputs: {
      yue_to_en: visitResult('I would like some water, please.'),
      yue_to_zh: visitResult('我想喝点水，谢谢。'),
      en_to_yue: visitResult('你想唔想飲啲水？', {
        speakableText: '你想唔想飲啲水？',
        romanization: jyutping('nei5 soeng2 m4 soeng2 jam2 di1 seoi2?')
      }),
      zh_to_yue: visitResult('你想唔想飲啲水？', {
        speakableText: '你想唔想飲啲水？',
        romanization: jyutping('nei5 soeng2 m4 soeng2 jam2 di1 seoi2?')
      })
    }
  },
  {
    patterns: {
      cantonese: [/邊度|边度|哪裡|哪里|乜地方|咩地方|邊度人|边度人/],
      english: [/where.*from|from.*where/],
      mandarin: [/哪里.*来|哪裡.*來|从哪里|從哪裡|哪里人|哪裡人/]
    },
    outputs: {
      yue_to_en: visitResult('Where are you from?'),
      yue_to_zh: visitResult('你从哪里来？'),
      en_to_yue: visitResult('你喺邊度嚟㗎？', {
        speakableText: '你喺邊度嚟㗎？',
        romanization: jyutping('nei5 hai2 bin1 dou6 lai4 gaa3?')
      }),
      zh_to_yue: visitResult('你喺邊度嚟㗎？', {
        speakableText: '你喺邊度嚟㗎？',
        romanization: jyutping('nei5 hai2 bin1 dou6 lai4 gaa3?')
      })
    }
  },
  {
    patterns: {
      cantonese: [/聽.*明|听.*懂|明唔明|明吾明|聽唔聽得明|聽得明|听得懂/],
      english: [/understand|hear.*me/],
      mandarin: [/听.*懂|明白|理解/]
    },
    outputs: {
      yue_to_en: visitResult('Can you understand what I am saying?'),
      yue_to_zh: visitResult('你听得懂我说的话吗？'),
      en_to_yue: visitResult('你聽唔聽得明我講嘢呀？', {
        speakableText: '你聽唔聽得明我講嘢呀？',
        romanization: jyutping('nei5 teng1 m4 teng1 dak1 ming4 ngo5 gong2 je5 aa3?')
      }),
      zh_to_yue: visitResult('你聽唔聽得明我講嘢呀？', {
        speakableText: '你聽唔聽得明我講嘢呀？',
        romanization: jyutping('nei5 teng1 m4 teng1 dak1 ming4 ngo5 gong2 je5 aa3?')
      })
    }
  },
  {
    patterns: {
      cantonese: [/叫咩名|叫乜名|你叫咩|你叫乜|貴姓|贵姓|咩名|乜名/],
      english: [/name|what.*called/],
      mandarin: [/叫.*名字|贵姓|貴姓|什么名字/]
    },
    outputs: {
      yue_to_en: visitResult('What is your name?'),
      yue_to_zh: visitResult('你叫什么名字？'),
      en_to_yue: visitResult('你叫咩名呀？', {
        speakableText: '你叫咩名呀？',
        romanization: jyutping('nei5 giu3 me1 meng2 aa3?')
      }),
      zh_to_yue: visitResult('你叫咩名呀？', {
        speakableText: '你叫咩名呀？',
        romanization: jyutping('nei5 giu3 me1 meng2 aa3?')
      })
    }
  },
  {
    patterns: {
      cantonese: [/食咗飯|食左飯|食飯|吃飯|食饭|吃饭/],
      english: [/eat|meal|lunch|dinner/],
      mandarin: [/吃饭|吃飯|用餐/]
    },
    outputs: {
      yue_to_en: visitResult('Have you eaten yet?'),
      yue_to_zh: visitResult('你吃饭了吗？'),
      en_to_yue: visitResult('你食咗飯未呀？', {
        speakableText: '你食咗飯未呀？',
        romanization: jyutping('nei5 sik6 zo2 faan6 mei6 aa3?')
      }),
      zh_to_yue: visitResult('你食咗飯未呀？', {
        speakableText: '你食咗飯未呀？',
        romanization: jyutping('nei5 sik6 zo2 faan6 mei6 aa3?')
      })
    }
  },
  {
    patterns: {
      cantonese: [/住邊|住边|住喺邊|住哪里|住哪裡|住在哪里/],
      english: [/where.*live|live.*where/],
      mandarin: [/住哪里|住哪裡|住在哪里|住在哪裡/]
    },
    outputs: {
      yue_to_en: visitResult('Where do you live?'),
      yue_to_zh: visitResult('你住在哪里？'),
      en_to_yue: visitResult('你住喺邊度呀？', {
        speakableText: '你住喺邊度呀？',
        romanization: jyutping('nei5 zyu6 hai2 bin1 dou6 aa3?')
      }),
      zh_to_yue: visitResult('你住喺邊度呀？', {
        speakableText: '你住喺邊度呀？',
        romanization: jyutping('nei5 zyu6 hai2 bin1 dou6 aa3?')
      })
    }
  },
  {
    patterns: {
      cantonese: [/唔舒服|不舒服|痛|暈|晕|急|醫|医|救命|胸口/],
      english: [/pain|dizzy|unwell|doctor|help|emergency/],
      mandarin: [/不舒服|疼|痛|头晕|頭暈|医生|醫生|帮忙|幫忙/]
    },
    outputs: {
      yue_to_en: visitResult('The resident may need help or may not be feeling well. Please ask staff to check.', { needsConfirmation: true }),
      yue_to_zh: visitResult('长者可能需要帮助，或身体不舒服。请工作人员确认。', { needsConfirmation: true }),
      en_to_yue: visitResult('我搵職員過嚟幫你，好唔好？', {
        speakableText: '我搵職員過嚟幫你，好唔好？',
        romanization: jyutping('ngo5 wan2 zik1 jyun4 gwo3 lai4 bong1 nei5, hou2 m4 hou2?'),
        needsConfirmation: true
      }),
      zh_to_yue: visitResult('我搵職員過嚟幫你，好唔好？', {
        speakableText: '我搵職員過嚟幫你，好唔好？',
        romanization: jyutping('ngo5 wan2 zik1 jyun4 gwo3 lai4 bong1 nei5, hou2 m4 hou2?'),
        needsConfirmation: true
      })
    }
  },
  {
    patterns: {
      cantonese: [/發音|发音|讀音|读音/],
      english: [/pronunciation|pronounce|correct.*sound/],
      mandarin: [/发音|發音|读音|讀音/]
    },
    outputs: {
      yue_to_en: visitResult('Can you help me correct my pronunciation?'),
      yue_to_zh: visitResult('可以帮我纠正发音吗？'),
      en_to_yue: visitResult('可唔可以幫我糾正發音呀？', {
        speakableText: '可唔可以幫我糾正發音呀？',
        romanization: jyutping('ho2 m4 ho2 ji5 bong1 ngo5 gau2 zing3 faat3 jam1 aa3?')
      }),
      zh_to_yue: visitResult('可唔可以幫我糾正發音呀？', {
        speakableText: '可唔可以幫我糾正發音呀？',
        romanization: jyutping('ho2 m4 ho2 ji5 bong1 ngo5 gau2 zing3 faat3 jam1 aa3?')
      })
    }
  },
  {
    patterns: {
      cantonese: [/唔該|多謝|谢谢|謝謝/],
      english: [/thank/],
      mandarin: [/谢谢|謝謝|麻烦|麻煩/]
    },
    outputs: {
      yue_to_en: visitResult('Thank you.'),
      yue_to_zh: visitResult('谢谢。'),
      en_to_yue: visitResult('唔該晒。', {
        speakableText: '唔該晒。',
        romanization: jyutping('m4 goi1 saai3.')
      }),
      zh_to_yue: visitResult('唔該晒。', {
        speakableText: '唔該晒。',
        romanization: jyutping('m4 goi1 saai3.')
      })
    }
  },
  {
    patterns: {
      cantonese: [/^(你好|您好|早晨|午安|晚安|好高興見到你|好高兴见到你|見到你|见到你)+$/],
      english: [/hello|hi|nice.*meet/],
      mandarin: [/你好|您好|很高兴见到你|很高興見到你/]
    },
    outputs: {
      yue_to_en: visitResult('Hello, nice to meet you.'),
      yue_to_zh: visitResult('你好，很高兴见到你。'),
      en_to_yue: visitResult('你好，好高興見到你。', {
        speakableText: '你好，好高興見到你。',
        romanization: jyutping('nei5 hou2, hou2 gou1 hing3 gin3 dou3 nei5.')
      }),
      zh_to_yue: visitResult('你好，好高興見到你。', {
        speakableText: '你好，好高興見到你。',
        romanization: jyutping('nei5 hou2, hou2 gou1 hing3 gin3 dou3 nei5.')
      })
    }
  }
];

function sourceGroupForDirection(direction) {
  if (direction === 'en_to_yue') return 'english';
  if (direction === 'zh_to_yue') return 'mandarin';
  return 'cantonese';
}

function matchesRule(patterns, compactText, rawText) {
  return patterns.some((pattern) => pattern.test(compactText) || pattern.test(rawText));
}

function detectCommonVisitTranslation(sourceText, direction) {
  const compactText = normalizeVisitText(sourceText).toLowerCase();
  const rawText = String(sourceText || '').toLowerCase();
  const sourceGroup = sourceGroupForDirection(direction);

  for (const rule of COMMON_VISIT_RULES) {
    const patterns = rule.patterns[sourceGroup] || [];
    if (rule.outputs[direction] && matchesRule(patterns, compactText, rawText)) {
      return rule.outputs[direction];
    }
  }

  return null;
}

function detectFoodPreference(sourceText) {
  const text = normalizeVisitText(sourceText);
  if (!text) return null;

  const hasLike = /(我都|我也|我又)?(鐘意|鍾意|中意|喜歡|喜欢)/.test(text);
  const hasEat = /(食|吃)/.test(text);
  const asksBack = /(你哋|你地|你們|你们).*(乜嘢|乜野|咩|什麼|什么|呢|呀|吖|啦|喇)?/.test(text);
  const food = FOOD_TERMS.find((term) => term.pattern.test(text));

  if (!hasLike || !hasEat || !food) return null;

  const quantity = /(一點|一点|少少|少許|些少|啲|的)/.test(text);
  return {
    englishFood: food.english,
    mandarinFood: food.mandarin,
    quantity,
    asksBack
  };
}

function detectTranslationHelpRequest(sourceText) {
  const text = normalizeVisitText(sourceText);
  if (!text) return false;

  const asksPolitely = /(可唔可以|可不可以|可以|可否|麻煩|麻烦|唔該|唔该|請|请)/.test(text);
  const asksForHelp = /(幫|帮|協助|协助)/.test(text);
  const asksTranslation = /(翻譯|翻译|譯|译)/.test(text);
  const asksLightly = /(一下|一吓|吓|下|啦|喇|嗎|吗|呀|吖)/.test(text);

  return asksTranslation && ((asksPolitely && asksForHelp) || (asksPolitely && asksLightly));
}

function detectCantonesePracticeRequest(sourceText) {
  const text = normalizeVisitText(sourceText);
  if (!text) return null;

  const mentionsCantonese = /(廣東話|广东话|粵語|粤语)/.test(text);
  const asksForInteraction = /(可唔可以|可不可以|可以|好唔好|好吗|好嗎|同我|跟我|陪我|幫我|帮我)/.test(text);
  const asksToSpeak = /(講|讲|說|说|傾|倾).{0,8}(廣東話|广东话|粵語|粤语)|(廣東話|广东话|粵語|粤语).{0,8}(講|讲|說|说|傾|倾)/.test(text);
  const asksToListen = /(聽|听)/.test(text);

  if (!mentionsCantonese || !asksForInteraction || !asksToSpeak) return null;
  return { asksToListen };
}

export function createDailyLifeVisitTranslation(sourceText, direction) {
  const normalizedText = normalizeVisitText(sourceText).toLowerCase();

  if (detectTranslationHelpRequest(sourceText)) {
    if (direction === 'yue_to_en') {
      return {
        translatedText: 'Could you help me translate this, please?',
        displayText: 'Could you help me translate this, please?',
        speakableText: '',
        romanization: null
      };
    }

    if (direction === 'yue_to_zh') {
      return {
        translatedText: '可以幫我翻譯一下嗎？',
        displayText: '可以幫我翻譯一下嗎？',
        speakableText: '',
        romanization: null
      };
    }
  }

  const cantonesePractice = detectCantonesePracticeRequest(sourceText);
  if (cantonesePractice) {
    if (direction === 'yue_to_en') {
      const displayText = cantonesePractice.asksToListen
        ? 'Could you speak Cantonese with me and listen to me for a bit?'
        : 'Could you speak Cantonese with me for a bit?';
      return {
        translatedText: displayText,
        displayText,
        speakableText: '',
        romanization: null
      };
    }

    if (direction === 'yue_to_zh') {
      const displayText = cantonesePractice.asksToListen
        ? '可以和我讲一会儿粤语，也听我说一下吗？'
        : '可以和我讲一会儿粤语吗？';
      return {
        translatedText: displayText,
        displayText,
        speakableText: '',
        romanization: null
      };
    }
  }

  const commonTranslation = detectCommonVisitTranslation(sourceText, direction);
  if (commonTranslation) return commonTranslation;

  if (direction === 'en_to_yue' && /speak.*english|english.*for\s*me|english/.test(normalizedText)) {
    const displayText = '可唔可以同我講少少英文呀？';
    return {
      translatedText: displayText,
      displayText,
      speakableText: displayText,
      romanization: {
        scheme: 'jyutping',
        text: 'ho2 m4 ho2 ji5 tung4 ngo5 gong2 siu2 siu2 jing1 man2 aa3?',
        toneNumbers: true
      }
    };
  }

  const foodPreference = detectFoodPreference(sourceText);
  if (!foodPreference) return null;

  const englishQuantity = foodPreference.quantity ? 'a little ' : '';
  const englishTail = foodPreference.asksBack ? ' What about you?' : '';
  const mandarinQuantity = foodPreference.quantity ? '一點' : '';
  const mandarinTail = foodPreference.asksBack ? '，你們呢？' : '。';

  if (direction === 'yue_to_en') {
    const displayText = `I also like eating ${englishQuantity}${foodPreference.englishFood}.${englishTail}`.replace('. What', '. What');
    return {
      translatedText: displayText,
      displayText,
      speakableText: '',
      romanization: null
    };
  }

  if (direction === 'yue_to_zh') {
    const displayText = `我也喜歡吃${mandarinQuantity}${foodPreference.mandarinFood}${mandarinTail}`;
    return {
      translatedText: displayText,
      displayText,
      speakableText: '',
      romanization: null
    };
  }

  return null;
}

export function isGenericVisitTranslation(text) {
  const value = String(text || '').trim();
  return GENERIC_VISIT_TRANSLATION_PATTERNS.some((pattern) => pattern.test(value));
}
