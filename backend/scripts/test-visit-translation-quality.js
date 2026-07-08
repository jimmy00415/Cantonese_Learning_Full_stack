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

const waterEnglish = createDailyLifeVisitTranslation('唔該，我想飲水。', 'yue_to_en');
assert.ok(waterEnglish, 'expected a first-person resident water request fallback');
assert.equal(waterEnglish.displayText, 'I would like some water, please.');
assert.equal(waterEnglish.needsConfirmation, false);

const waterMandarin = createDailyLifeVisitTranslation('唔該，我想飲水。', 'yue_to_zh');
assert.ok(waterMandarin, 'expected a Mandarin first-person resident water request fallback');
assert.equal(waterMandarin.displayText, '我想喝点水，谢谢。');

const originCantonese = createDailyLifeVisitTranslation('你喺邊度嚟㗎？', 'yue_to_en');
assert.ok(originCantonese, 'expected a known resident origin question fallback');
assert.equal(originCantonese.displayText, 'Where are you from?');

const volunteerOrigin = createDailyLifeVisitTranslation('Where are you from?', 'en_to_yue');
assert.ok(volunteerOrigin, 'expected a known English volunteer question fallback');
assert.equal(volunteerOrigin.displayText, '你喺邊度嚟㗎？');
assert.equal(volunteerOrigin.speakableText, '你喺邊度嚟㗎？');
assert.equal(volunteerOrigin.romanization.text, 'nei5 hai2 bin1 dou6 lai4 gaa3?');

const weeklyActivityEnglish = createDailyLifeVisitTranslation('呢個星期有冇活動安排呀？', 'yue_to_en');
assert.ok(weeklyActivityEnglish, 'expected a local fallback for weekly activity schedule questions');
assert.equal(weeklyActivityEnglish.displayText, 'Are there any activities planned this week?');
assert.equal(weeklyActivityEnglish.speakableText, '');
assert.equal(weeklyActivityEnglish.romanization, null);

const weeklyActivityCantonese = createDailyLifeVisitTranslation('Are there any activities planned this week?', 'en_to_yue');
assert.ok(weeklyActivityCantonese, 'expected an English-to-Cantonese fallback for weekly activity schedule questions');
assert.equal(weeklyActivityCantonese.displayText, '今個星期有冇活動安排呀？');
assert.equal(weeklyActivityCantonese.speakableText, '今個星期有冇活動安排呀？');
assert.equal(weeklyActivityCantonese.romanization.text, 'gam1 go3 sing1 kei4 jau5 mou5 wut6 dung6 on1 paai4 aa3?');

const massageOffer = createDailyLifeVisitTranslation('Do you want to do massaging?', 'en_to_yue');
assert.ok(massageOffer, 'expected a natural Cantonese fallback for common massage offers');
assert.equal(massageOffer.displayText, '你想唔想我幫你按摩一下？');
assert.equal(massageOffer.speakableText, '你想唔想我幫你按摩一下？');
assert.equal(massageOffer.romanization.text, 'nei5 soeng2 m4 soeng2 ngo5 bong1 nei5 on3 mo1 jat1 haa5?');
assert.equal(massageOffer.needsConfirmation, false);
assert.equal(isGenericVisitTranslation(massageOffer.displayText), false);

const politeMassageOffer = createDailyLifeVisitTranslation('Would you like a massage?', 'en_to_yue');
assert.ok(politeMassageOffer, 'expected a natural Cantonese fallback for polite massage offers');
assert.equal(politeMassageOffer.displayText, '你想唔想我幫你按摩一下？');

const handStretchOffer = createDailyLifeVisitTranslation('Can I help you stretch your hands?', 'en_to_yue');
assert.ok(handStretchOffer, 'expected a natural Cantonese fallback for gentle hand-stretch offers');
assert.equal(handStretchOffer.displayText, '我可唔可以幫你伸展一下雙手？');
assert.equal(handStretchOffer.speakableText, '我可唔可以幫你伸展一下雙手？');
assert.equal(handStretchOffer.romanization.text, 'ngo5 ho2 m4 ho2 ji5 bong1 nei5 san1 zin2 jat1 haa5 soeng1 sau2?');
assert.equal(handStretchOffer.needsConfirmation, false);

assert.equal(
  isGenericVisitTranslation('The resident said something in Cantonese. Please ask staff to confirm the exact meaning.'),
  true
);
assert.equal(isGenericVisitTranslation(english.displayText), false);
assert.equal(isGenericVisitTranslation(helpEnglish.displayText), false);

console.log('visit translation quality regressions passed');
