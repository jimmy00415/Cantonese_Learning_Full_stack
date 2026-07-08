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
