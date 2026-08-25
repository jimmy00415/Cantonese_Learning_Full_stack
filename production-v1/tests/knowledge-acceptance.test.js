import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDefaultCorpus } from '../src/knowledge/corpus.js';
import { createRetriever } from '../src/knowledge/retriever.js';
import { createAnswerService } from '../src/services/answer.js';

const REVIEW_INSTANT = new Date('2026-08-26T12:00:00+08:00');
const LOCALES = Object.freeze([
  ['en', 'en'],
  ['yue-Hant-HK', 'zhHant'],
  ['cmn-Hans-CN', 'zhHans'],
]);

const corpus = await loadDefaultCorpus();
const retriever = createRetriever({ corpus, now: () => REVIEW_INSTANT });
const provider = {
  provider: 'acceptance-failure',
  async generate() {
    throw Object.assign(new Error('deterministic provider outage'), { code: 'PROVIDER_UNAVAILABLE' });
  },
};
const answerService = createAnswerService({
  corpus,
  retriever,
  llmProvider: provider,
  now: () => REVIEW_INSTANT,
});

const cases = [
  {
    id: 1, intent: 'student_card',
    queries: { en: 'Non-JUPAS photo uploaded by 2 August 2026: when do I collect my student card?', zhHant: 'Non-JUPAS 已於 2026 年 8 月 2 日上載相片，幾時領學生證？', zhHans: 'Non-JUPAS 已于 2026 年 8 月 2 日上传照片，什么时候领学生证？' },
    evidence: ['evidence.ar.student-card-collection.non-jupas-photo-by-2026-08-02'], sources: ['hkbu.ar.student-card-collection'], preserve: ['Non-JUPAS'],
  },
  {
    id: 2, intent: 'student_card',
    queries: { en: 'When can I collect my student card?', zhHant: '我幾時可以領學生證？', zhHans: '我什么时候可以领学生证？' },
    evidence: [], sources: ['hkbu.ar.student-card-collection'], qualifiers: ['STUDENT_CARD_ADMISSION_ROUTE_REQUIRED', 'STUDENT_CARD_PHOTO_UPLOAD_ROUTE_REQUIRED'], handoff: 'hkbu.ar.contact', clarify: true,
  },
  {
    id: 3, intent: 'account_password',
    queries: { en: 'I forgot my SSOid password', zhHant: '我忘記咗 SSOid 密碼', zhHans: '我忘记了 SSOid 密码' },
    evidence: ['evidence.ito.account.self-service-reset'], sources: ['hkbu.ito.account'], preserve: ['SSOid'],
  },
  {
    id: 4, intent: 'duo',
    queries: { en: 'Duo changed phone', zhHant: 'Duo 換咗電話', zhHans: 'Duo 换了手机' },
    evidence: ['evidence.ito.duo.new-phone'], sources: ['hkbu.ito.duo'], preserve: ['Duo'],
  },
  {
    id: 5, intent: 'it_help',
    queries: { en: 'Where is the ITO Service Call Centre?', zhHant: 'ITO Service Call Centre 喺邊？', zhHans: 'ITO Service Call Centre 在哪里？' },
    evidence: ['evidence.ito.contact.service-centre'], sources: ['hkbu.ito.contact'], preserve: ['RRS303'],
  },
  {
    id: 6, intent: 'residence_check_in',
    queries: { en: 'Village CARE exchange student check-in 2026', zhHant: 'Village CARE 2026 交換生入住安排', zhHans: 'Village CARE 2026 交换生入住安排' },
    evidence: ['evidence.sa.village-care-check-in.exchange-students-2026'], sources: ['hkbu.sa.village-care-check-in'], stale: ['evidence.sa.village-care-check-in.stale-reminder-2025'], preserve: ['Village CARE'],
  },
  {
    id: 7, intent: 'residence_check_in',
    queries: { en: 'When can I check into the hostel?', zhHant: '宿舍幾時可以入住？', zhHans: '宿舍什么时候可以入住？' },
    evidence: [], sources: ['hkbu.sa.residence-halls-check-in', 'hkbu.sa.village-care-check-in'], stale: ['evidence.sa.residence-halls-check-in.stale-reminder-2025', 'evidence.sa.village-care-check-in.stale-reminder-2025'], qualifiers: ['RESIDENCE_TYPE_REQUIRED', 'RESIDENCE_COHORT_REQUIRED'], handoff: 'hkbu.sa.accm-contact', clarify: true,
  },
  {
    id: 8, intent: 'campus_ar_navigation',
    queries: { en: 'Where is Academic Registry?', zhHant: '教務處喺邊？', zhHans: '教务处在哪里？' },
    evidence: ['evidence.ar.contact.location'], sources: ['hkbu.ar.contact'], preserve: ['SCE301'],
  },
  {
    id: 9, intent: 'library',
    queries: { en: 'When does the library close today?', zhHant: '圖書館今日幾點關門？', zhHans: '图书馆今天几点关门？' },
    evidence: [], sources: ['hkbu.library.hours'], qualifiers: ['LIBRARY_BRANCH_REQUIRED'], handoff: 'hkbu.library.hours', clarify: true,
  },
  {
    id: 10, intent: 'dining',
    queries: { en: 'Which canteen is open now?', zhHant: '而家邊間飯堂開門？', zhHans: '现在哪间食堂开门？' },
    evidence: ['evidence.eo.dining-overview.special-hours'], sources: ['hkbu.eo.dining-overview'], qualifiers: ['CATERING_SPECIAL_HOURS_REQUIRED'], clarify: true,
  },
  {
    id: 11, intent: 'medical',
    queries: { en: 'How do I book the Health Centre?', zhHant: '點樣預約健康中心？', zhHans: '怎么预约健康中心？' },
    evidence: ['evidence.eo.medical.health-centre'], sources: ['hkbu.eo.medical'], stale: ['evidence.eo.medical.dental-2025-26-stale'], preserve: ['3411 2011'],
  },
  {
    id: 12, intent: 'osa_counselling',
    queries: { en: 'I need counselling', zhHant: '我需要輔導服務', zhHans: '我需要辅导服务' },
    evidence: ['evidence.sa.counselling.official-service'], sources: ['hkbu.sa.counselling'], preserve: ['CDC'],
  },
  {
    id: 13, intent: 'emergency', emergency: true,
    queries: { en: 'Someone is badly injured now', zhHant: '有人而家受咗重傷', zhHans: '有人现在受了重伤' },
    evidence: ['evidence.eo.security.hotline'], sources: [], preserve: ['999', '3411 7777'],
  },
  {
    id: 14, intent: 'hall_facilities',
    queries: { en: 'Can a Student Residence Halls resident use common facilities?', zhHant: '學生宿舍住客可唔可以用公共設施？', zhHans: '学生宿舍住客可以使用公共设施吗？' },
    evidence: ['evidence.sa.hall-facilities.user-guide'], sources: ['hkbu.sa.hall-facilities'], preserve: ['Facilities User Guide'],
  },
  {
    id: 15, intent: 'hall_facilities',
    queries: { en: 'Is Music Practice Room 106A available at 22:00 today?', zhHant: '音樂練習室 106A 今日 22:00 有冇得用？', zhHans: '音乐练习室 106A 今天 22:00 可以用吗？' },
    evidence: [], sources: ['hkbu.sa.hall-facilities'], qualifiers: ['CURRENT_AVAILABILITY_REQUIRED'], handoff: 'hkbu.sa.hall-facilities', clarify: true, preserve: ['106A'],
  },
  {
    id: 16, intent: 'hall_facilities',
    queries: { en: 'What is in the Student Residence Halls laundry?', zhHant: '學生宿舍洗衣房有咩設施？', zhHans: '学生宿舍洗衣房有什么设施？' },
    evidence: ['evidence.sa.hall-facilities.laundry'], sources: ['hkbu.sa.hall-facilities'], preserve: ['111', '113'],
  },
  {
    id: 17, intent: 'hall_facilities',
    queries: { en: 'How do I pay for SRH laundry?', zhHant: 'SRH 洗衣點樣畀錢？', zhHans: 'SRH 洗衣怎么付款？' },
    evidence: ['evidence.sa.residence-halls.laundry-payment'], sources: ['hkbu.sa.residence-halls-check-in'], stale: ['evidence.sa.residence-halls-check-in.stale-reminder-2025'], preserve: ['HKBU Mobile App'],
  },
  {
    id: 18, intent: 'hall_maintenance',
    queries: { en: 'My Student Residence Halls room has a defect', zhHant: '我間學生宿舍房有故障', zhHans: '我的学生宿舍房间有故障' },
    evidence: ['evidence.sa.residence-halls.defect-route'], sources: ['hkbu.sa.residence-halls-check-in'], stale: ['evidence.sa.residence-halls-check-in.stale-reminder-2025'], preserve: ['Student Residence Online System'],
    preserveByLocale: {
      en: ['ACCM General Office', 'after office hours', 'North Tower security counter'],
      'yue-Hant-HK': ['ACCM 總辦事處', '辦公時間外', '北座保安櫃檯'],
      'cmn-Hans-CN': ['ACCM 总办事处', '办公时间外', '北座保安柜台'],
    },
  },
  {
    id: 19, intent: 'emergency', emergency: true,
    queries: { en: 'My hall room is on fire now', zhHant: '我間宿舍房而家着火', zhHans: '我的宿舍房间现在着火了' },
    evidence: ['evidence.eo.security.hotline'], sources: [], preserve: ['999', '3411 7777'],
  },
  {
    id: 20, intent: 'hall_facilities',
    queries: { en: 'Is NTTIH for full-time non-local students?', zhHant: 'NTTIH 係咪畀全日制非本地學生住？', zhHans: 'NTTIH 是给全日制非本地学生住的吗？' },
    evidence: ['evidence.sa.nttih.scope'], sources: ['hkbu.sa.nttih-overview'], preserve: ['NTTIH'],
  },
  {
    id: 21, intent: 'hall_facilities',
    queries: { en: 'What should I bring to NTTIH?', zhHant: '入住 NTTIH 要自備啲咩？', zhHans: '入住 NTTIH 要自带什么？' },
    evidence: ['evidence.sa.nttih.room-inclusions'], sources: ['hkbu.sa.nttih-facilities'], preserve: ['NTTIH'],
  },
  {
    id: 22, intent: 'hall_facilities',
    queries: { en: 'Is NTTIH reception open right now?', zhHant: 'NTTIH 接待處而家開唔開？', zhHans: 'NTTIH 接待处现在开门吗？' },
    evidence: [], sources: ['hkbu.sa.nttih-facilities'], qualifiers: ['CURRENT_AVAILABILITY_REQUIRED'], handoff: 'hkbu.sa.nttih-facilities', clarify: true, preserve: ['NTTIH'],
  },
  {
    id: 23, intent: 'transport',
    queries: { en: 'How do I get from Kowloon Tong to Village CARE?', zhHant: '由九龍塘點去 Village CARE？', zhHans: '从九龙塘怎么去 Village CARE？' },
    evidence: ['evidence.sa.accm-contact.village-care-minibus'], sources: ['hkbu.sa.accm-contact'], preserve: ['25M', 'Village CARE'],
  },
  {
    id: 24, intent: 'orientation',
    queries: { en: 'Where are orientation resources for international students?', zhHant: '國際學生去邊度搵迎新資源？', zhHans: '国际学生去哪里找迎新资源？' },
    evidence: ['evidence.sa.fye.orientation-directory'], sources: ['hkbu.sa.fye'], preserve: ['First Year Experience'],
  },
  {
    id: 25, intent: 'international_support',
    queries: { en: 'Can I join the HKBU International Association?', zhHant: '我可唔可以加入 HKBU International Association？', zhHans: '我可以加入 HKBU International Association 吗？' },
    evidence: ['evidence.sa.international.association'], sources: ['hkbu.sa.international-support'], preserve: ['HKBU International Association'],
  },
  {
    id: 26, intent: 'international_support',
    queries: { en: 'Can I get a Cultural Ambassador today?', zhHant: '我今日可唔可以申請 Cultural Ambassador？', zhHans: '我今天可以申请 Cultural Ambassador 吗？' },
    evidence: [], sources: ['hkbu.sa.international-support'], qualifiers: ['CURRENT_AVAILABILITY_REQUIRED'], handoff: 'hkbu.sa.international-support', clarify: true, preserve: ['Cultural Ambassador'],
  },
  {
    id: 27, intent: 'orientation',
    queries: { en: 'When are UOW workshops normally held?', zhHant: 'UOW 工作坊通常幾時舉行？', zhHans: 'UOW 工作坊通常什么时候举行？' },
    evidence: ['evidence.sa.u-life.uow-timing'], sources: ['hkbu.sa.u-life'], preserve: ['UOW'],
  },
  {
    id: 28, intent: 'orientation',
    queries: { en: 'Where do I see my UOW schedule?', zhHant: '去邊度睇我嘅 UOW 時間表？', zhHans: '去哪里看我的 UOW 时间表？' },
    evidence: ['evidence.sa.u-life.uow-schedule-route'], sources: ['hkbu.sa.u-life'], preserve: ['UOW', 'BUniPort'],
  },
  {
    id: 29, intent: 'orientation',
    queries: { en: 'I missed UOW. What should I do?', zhHant: '我錯過咗 UOW，應該點做？', zhHans: '我错过了 UOW，应该怎么办？' },
    evidence: ['evidence.sa.u-life.uow-makeup-route'], sources: ['hkbu.sa.u-life'], preserve: ['UOW'],
  },
  {
    id: 30, intent: 'dining_inventory',
    queries: { en: 'What food outlets are at JC³?', zhHant: 'JC³ 有咩餐飲店？', zhHans: 'JC³ 有哪些餐饮店？' },
    evidence: ['evidence.eo.dining-inventory.jc3'], sources: ['hkbu.eo.dining-overview'], preserve: ['JC³', 'UG/F Cafe', 'G/F Cafe'],
  },
  {
    id: 31, intent: 'dining_inventory',
    queries: { en: 'What food outlets are at Ho Sin Hang Campus?', zhHant: '善衡校園有咩餐飲店？', zhHans: '善衡校园有哪些餐饮店？' },
    evidence: ['evidence.eo.dining-inventory.ho-sin-hang'], sources: ['hkbu.eo.dining-overview'], preserve: ['Harmony'],
  },
  {
    id: 32, intent: 'dining_inventory',
    queries: { en: 'What outlets are at Baptist University Road Campus?', zhHant: '浸會大學道校園有咩餐飲店？', zhHans: '浸会大学道校园有哪些餐饮店？' },
    evidence: ['evidence.eo.dining-inventory.burc'], sources: ['hkbu.eo.dining-overview'], preserve: ["Books 'n Bites", 'Main Canteen', 'Cafe@CVA Commons', 'BU Fiesta', 'Bistro NTT', 'Deli'],
  },
  {
    id: 33, intent: 'dining',
    queries: { en: 'Is Nan Yuan open today?', zhHant: 'Nan Yuan 今日開唔開？', zhHans: 'Nan Yuan 今天开门吗？' },
    evidence: [], sources: ['hkbu.eo.dining.shaw-closure-conflict'], stale: ['evidence.eo.dining.shaw-closure-conflict'], qualifiers: ['CONFLICTED_LIVE_STATUS'], handoff: 'hkbu.eo.dining-overview', clarify: true, preserve: ['Nan Yuan'],
  },
  {
    id: 34, intent: 'dining',
    queries: { en: 'Is H.F.C.@Scholars Court open today?', zhHant: 'H.F.C.@Scholars Court 今日開唔開？', zhHans: 'H.F.C.@Scholars Court 今天开门吗？' },
    evidence: [], sources: ['hkbu.eo.dining.shaw-closure-conflict'], stale: ['evidence.eo.dining.shaw-closure-conflict'], qualifiers: ['CONFLICTED_LIVE_STATUS'], handoff: 'hkbu.eo.dining-overview', clarify: true, preserve: ['H.F.C.@Scholars Court'],
  },
  {
    id: 35, intent: 'dining',
    queries: { en: 'Is Main Canteen open now?', zhHant: 'Main Canteen 而家開唔開？', zhHans: 'Main Canteen 现在开门吗？' },
    evidence: ['evidence.eo.dining-overview.special-hours'], sources: ['hkbu.eo.dining.main-canteen', 'hkbu.eo.dining-overview'], qualifiers: ['CATERING_SPECIAL_HOURS_REQUIRED'], clarify: true,
  },
  {
    id: 36, intent: 'transport',
    queries: { en: 'How far is Kowloon Tong MTR from campus?', zhHant: '由九龍塘港鐵站行去校園要幾耐？', zhHans: '从九龙塘地铁站走到校园要多久？' },
    evidence: ['evidence.eo.campus-map.kowloon-tong-route'], sources: ['hkbu.eo.campus-map'], preserve: ['A2', '10'],
  },
  {
    id: 37, intent: 'language_learning',
    queries: { en: 'Can a Mainland student join Cantonese Peer Tutoring this semester?', zhHant: '內地生今個學期可唔可以參加粵語學習夥伴計劃？', zhHans: '内地生这学期可以参加粤语学习伙伴计划吗？' },
    evidence: [], sources: ['hkbu.ar.exchange-language-courses'], qualifiers: ['NO_CURRENT_PROGRAMME_EVIDENCE'], handoff: 'hkbu.ar.exchange-language-courses', clarify: true,
  },
  {
    id: 38, intent: 'language_learning',
    queries: { en: 'Do you offer Cantonese speaking coaching?', zhHant: '學校有冇粵語口語輔導？', zhHans: '学校有没有粤语口语辅导？' },
    evidence: [], sources: ['hkbu.ar.exchange-language-courses'], qualifiers: ['NO_CURRENT_PROGRAMME_EVIDENCE'], handoff: 'hkbu.ar.exchange-language-courses', clarify: true,
  },
  {
    id: 39, intent: 'language_learning',
    queries: { en: 'Which Cantonese courses are on the Fall 2026/27 physical exchange list?', zhHant: '2026/27 秋季實體交換生課程表有邊啲粵語課？', zhHans: '2026/27 秋季实体交换生课程表有哪些粤语课？' },
    evidence: ['evidence.ar.exchange-language-courses.cantonese'], sources: ['hkbu.ar.exchange-language-courses'], preserve: ['LANG1035', 'LANG1036', 'LANG1107'],
  },
  {
    id: 40, intent: 'living_supplies',
    queries: { en: 'Where should I buy bedding, groceries, or a SIM card?', zhHant: '我應該去邊度買床品、雜貨或者 SIM 卡？', zhHans: '我应该去哪里买床品、杂货或者 SIM 卡？' },
    evidence: [], sources: ['hkbu.sa.student-welfare-shop'], qualifiers: ['NO_MATCHING_OFFICIAL_EVIDENCE'], handoff: 'hkbu.sa.accm-contact', clarify: true, preserve: ['SIM'],
  },
];

function assertLocale(text, locale, label) {
  if (locale === 'en') {
    assert.doesNotMatch(text, /\p{Script=Han}/u, `${label}: English response must not switch to Chinese`);
    return;
  }
  assert.match(text, /\p{Script=Han}/u, `${label}: Chinese response must contain Han text`);
  if (locale === 'yue-Hant-HK') {
    assert.doesNotMatch(text, /[这为门吗个里么后须开发关间学医证应联]/u, `${label}: Cantonese response must not switch to Simplified Chinese`);
  } else {
    assert.doesNotMatch(text, /[這為門嗎個裡麼後須開發關間學醫證應聯]/u, `${label}: Mandarin response must not switch to Traditional Chinese`);
  }
}

test('40-case governed HKBU acceptance matrix holds across all three reply locales', async (t) => {
  assert.equal(cases.length, 40);
  let localeAssertions = 0;

  for (const candidate of cases) {
    for (const [replyLanguage, queryKey] of LOCALES) {
      const label = `case ${candidate.id} / ${replyLanguage}`;
      await t.test(label, async () => {
        localeAssertions += 1;
        const query = candidate.queries[queryKey];
        const retrieval = retriever.retrieve(query);

        assert.equal(retrieval.kind, candidate.emergency ? 'emergency' : 'knowledge', label);
        assert.equal(retrieval.intent, candidate.intent, label);
        assert.deepEqual(retrieval.evidenceIds, candidate.emergency ? [] : candidate.evidence, label);
        assert.deepEqual(retrieval.sources.map((source) => source.id), candidate.sources, label);
        assert.deepEqual(
          retrieval.staleClaims.map((claim) => claim.id),
          candidate.stale ?? [],
          label,
        );
        assert.deepEqual(
          [...retrieval.ambiguityCodes].sort(),
          [...(candidate.qualifiers ?? [])].sort(),
          `${label}: exact qualifiers`,
        );
        assert.equal(retrieval.needsClarification, Boolean(candidate.clarify), label);
        assert.equal(retrieval.handoffSourceId ?? null, candidate.handoff ?? null, label);

        const answer = await answerService.answer({
          turnId: `acceptance-${candidate.id}-${replyLanguage}`,
          text: query,
          replyLanguage,
          context: [],
          beforeProvider: async () => {},
        });
        assert.equal(
          answer.groundingStatus,
          candidate.evidence.length > 0 || candidate.emergency ? 'verified' : 'unverified',
          label,
        );
        assert.equal(answer.needsClarification, Boolean(candidate.clarify), label);
        assert.deepEqual(
          answer.citations.map((citation) => citation.evidenceId),
          candidate.emergency ? candidate.evidence : candidate.evidence,
          label,
        );

        const handoffCards = answer.cards.filter((card) => card.kind === 'handoff');
        assert.deepEqual(handoffCards.map((card) => card.sourceId), candidate.handoff ? [candidate.handoff] : [], label);
        assert.equal(answer.citations.some((citation) => citation.sourceId === candidate.handoff && citation.evidenceId === null), false, label);
        for (const identifier of candidate.preserve ?? []) assert.ok(answer.text.includes(identifier), `${label}: missing ${identifier}`);
        for (const phrase of candidate.preserveByLocale?.[replyLanguage] ?? []) {
          assert.ok(answer.text.includes(phrase), `${label}: missing ${phrase}`);
        }
        assertLocale(answer.text, replyLanguage, label);
      });
    }
  }

  assert.equal(localeAssertions, 120);
});
