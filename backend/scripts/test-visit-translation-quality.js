import assert from 'node:assert/strict';

import {
  createDailyLifeVisitTranslation,
  isGenericVisitTranslation
} from '../services/visitTranslationFallback.js';

const source = '我都鐘意食一點紅燒肉啦，你哋乜嘢呀？';

const english = createDailyLifeVisitTranslation(source, 'yue_to_en');
assert.ok(english, 'expected a daily-life fallback for the Cantonese food-preference sentence');
assert.equal(english.displayText, 'I also like eating a little red-braised pork. What about you?');
assert.equal(english.speakableText, '');
assert.equal(english.romanization, null);

const mandarin = createDailyLifeVisitTranslation(source, 'yue_to_zh');
assert.ok(mandarin, 'expected a Mandarin fallback for the Cantonese food-preference sentence');
assert.equal(mandarin.displayText, '我也喜歡吃一點紅燒肉，你們呢？');

const noisyHelpRequest = '可唔可以幫我翻譯一下啦？ More guy可唔可以幫我翻譯一下啦？';
const helpEnglish = createDailyLifeVisitTranslation(noisyHelpRequest, 'yue_to_en');
assert.ok(helpEnglish, 'expected a fallback for a mixed Cantonese/ASR-noise translation help request');
assert.equal(helpEnglish.displayText, 'Could you help me translate this, please?');
assert.equal(helpEnglish.speakableText, '');
assert.equal(helpEnglish.romanization, null);

const helpMandarin = createDailyLifeVisitTranslation(noisyHelpRequest, 'yue_to_zh');
assert.ok(helpMandarin, 'expected a Mandarin fallback for a mixed Cantonese/ASR-noise translation help request');
assert.equal(helpMandarin.displayText, '可以幫我翻譯一下嗎？');

const englishRequest = createDailyLifeVisitTranslation('Could you speak some English for me ?', 'en_to_yue');
assert.ok(englishRequest, 'expected a rule fallback for a common English volunteer request');
assert.equal(englishRequest.displayText, '可唔可以同我講少少英文呀？');
assert.equal(englishRequest.speakableText, '可唔可以同我講少少英文呀？');

const noisyCantonesePracticeRequest = '咁我可以同我講講廣東話啦。咁啊佢同我講講廣東話啦，同我聽嘛啲啦好唔好？破天下夜啦，好唔好？';
const practiceEnglish = createDailyLifeVisitTranslation(noisyCantonesePracticeRequest, 'yue_to_en');
assert.ok(practiceEnglish, 'expected a fallback for a noisy Cantonese request to speak/listen in Cantonese');
assert.equal(practiceEnglish.displayText, 'Could you speak Cantonese with me and listen to me for a bit?');
assert.equal(practiceEnglish.speakableText, '');
assert.equal(practiceEnglish.romanization, null);

const practiceMandarin = createDailyLifeVisitTranslation(noisyCantonesePracticeRequest, 'yue_to_zh');
assert.ok(practiceMandarin, 'expected a Mandarin fallback for a noisy Cantonese request to speak/listen in Cantonese');
assert.equal(practiceMandarin.displayText, '可以和我讲一会儿粤语，也听我说一下吗？');

assert.equal(
  isGenericVisitTranslation('The resident said something in Cantonese. Please ask staff to confirm the exact meaning.'),
  true
);
assert.equal(isGenericVisitTranslation(english.displayText), false);
assert.equal(isGenericVisitTranslation(helpEnglish.displayText), false);

console.log('visit translation quality regressions passed');
