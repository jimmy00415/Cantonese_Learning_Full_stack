import assert from 'node:assert/strict';
import test from 'node:test';

import * as chatCopy from '../public/chat-copy.js';

const {
  chatExperienceCopy, clearErrorCopy, replyPreferenceLabel, sendErrorCopy, startErrorCopy,
} = chatCopy;

test('chat experience copy localizes the welcome, composer, and four useful starters', () => {
  assert.equal(typeof chatExperienceCopy, 'function');
  assert.deepEqual(chatExperienceCopy('en'), {
    documentLanguage: 'en',
    welcome: 'Hi — I’m Hong Kong Buddy, your HKBU AI senior. Ask me about registration, halls, food, campus services, transport, or settling into Hong Kong.',
    disclosure: 'Campus facts include official sources.',
    placeholder: 'Ask your AI senior…',
    starterPrompts: [
      'How do I activate my SSOid?',
      'What food options are available at HKBU?',
      'Where can I use my student e-Card?',
      'How do I set up Duo on a new phone?',
    ],
  });
  assert.deepEqual(chatExperienceCopy('yue-Hant-HK'), {
    documentLanguage: 'zh-HK',
    welcome: '你好，我係 Hong Kong Buddy，你嘅浸大 AI 學長。註冊、宿舍、飲食、校園服務、交通同香港生活，都可以問我。',
    disclosure: '校園資料會附上官方來源。',
    placeholder: '問你嘅浸大 AI 學長…',
    starterPrompts: [
      '點樣啟用 SSOid？',
      '浸大有咩食嘢選擇？',
      '學生電子證（Student e-Card）可以喺邊度用？',
      '換咗電話後點樣設定 Duo？',
    ],
  });
  assert.deepEqual(chatExperienceCopy('cmn-Hans-CN'), {
    documentLanguage: 'zh-CN',
    welcome: '你好，我是 Hong Kong Buddy，你的浸大 AI 学长。注册、宿舍、餐饮、校园服务、交通和香港生活，都可以问我。',
    disclosure: '校园信息会附上官方来源。',
    placeholder: '问你的浸大 AI 学长…',
    starterPrompts: [
      '怎么启用 SSOid？',
      '浸大有什么吃饭选择？',
      '学生电子证（Student e-Card）可以在哪里使用？',
      '换了手机后怎么设置 Duo？',
    ],
  });
});

test('reply preference labels distinguish assistant output from Hold to speak input', () => {
  assert.equal(typeof replyPreferenceLabel, 'function');
  assert.equal(replyPreferenceLabel({ replyLanguage: 'en', replyMode: 'text' }), 'English · Text');
  assert.equal(replyPreferenceLabel({ replyLanguage: 'yue-Hant-HK', replyMode: 'voice' }), '廣東話 · Voice reply');
  assert.equal(replyPreferenceLabel({ replyLanguage: 'cmn-Hans-CN', replyMode: 'voice' }), '普通話 · Voice reply');
  assert.throws(() => chatExperienceCopy('fr'), /reply language/i);
  assert.throws(() => replyPreferenceLabel({ replyLanguage: 'en', replyMode: 'audio' }), /reply mode/i);
});

test('chat copy keeps bootstrap failure separate from send ambiguity', () => {
  const copy = startErrorCopy({ code: 'NETWORK_UNAVAILABLE' });
  assert.match(copy, /chat could not start/i);
  assert.doesNotMatch(copy, /message|send not confirmed/i);
});

test('chat copy distinguishes ambiguous send, explicit rejection, and recovered session', () => {
  assert.match(sendErrorCopy({ code: 'NETWORK_UNAVAILABLE' }), /send not confirmed/i);
  assert.match(sendErrorCopy({ code: 'RATE_LIMITED', status: 429, retryAfter: '10' }), /not accepted.*wait/i);
  assert.match(sendErrorCopy({ code: 'UNAUTHORIZED', status: 401 }), /not accepted/i);
  assert.doesNotMatch(sendErrorCopy({ code: 'UNAUTHORIZED', status: 401 }), /retry send/i);
  assert.match(sendErrorCopy({ code: 'SESSION_RECOVERED' }), /new guest chat.*draft.*kept/i);
});

test('chat copy does not tell the user to retry while a clear or session transition blocks sending', () => {
  const copy = sendErrorCopy({ code: 'CHAT_NOT_READY' });
  assert.match(copy, /chat.*changing|conversation.*ready/i);
  assert.doesNotMatch(copy, /send not confirmed|use Retry send/i);
});

test('chat copy tells the truth when clear succeeded but guest restart failed', () => {
  const partial = clearErrorCopy({ code: 'CLEARED_RESTART_FAILED', deleted: true });
  assert.match(partial, /^Conversation cleared\./i);
  assert.doesNotMatch(partial, /was not cleared/i);
  assert.match(clearErrorCopy({ code: 'NETWORK_UNAVAILABLE' }), /was not cleared/i);
});

test('chat copy explains the non-ready state when clear and same-session recovery both fail', () => {
  const copy = clearErrorCopy({ code: 'CLEAR_FAILED_RECOVERY_PENDING', deleted: false });
  assert.match(copy, /was not cleared/i);
  assert.match(copy, /could not be reloaded/i);
  assert.match(copy, /refresh/i);
});

test('chat copy does not invent a clear outcome when DELETE and scope recovery are both ambiguous', () => {
  const copy = clearErrorCopy({ code: 'CLEAR_OUTCOME_UNKNOWN', deleted: null });
  assert.match(copy, /could not be confirmed/i);
  assert.match(copy, /refresh/i);
  assert.doesNotMatch(copy, /was not cleared|^Conversation cleared/i);
});
