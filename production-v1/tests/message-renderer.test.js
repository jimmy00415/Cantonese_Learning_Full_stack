import assert from 'node:assert/strict';
import test from 'node:test';

import { createMessageElement } from '../public/message-renderer.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
  }

  set innerHTML(value) { throw new Error(`Unsafe innerHTML write: ${value}`); }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
}

const fakeDocument = { createElement: (tagName) => new FakeElement(tagName) };

function all(root) {
  return [root, ...root.children.flatMap((child) => all(child))];
}

test('message renderer uses textContent for untrusted model copy and drops unsafe citation and card URLs', () => {
  const element = createMessageElement(fakeDocument, {
    id: 'assistant-1', sequence: 1, role: 'assistant', status: 'delivered',
    text: '<img src=x onerror=alert(1)>', createdAt: '2026-08-25T08:00:00.000Z',
    citations: [
      { title: '<script>alert(1)</script>', publisher: 'HKBU', url: 'https://evil.example/', verifiedAt: '2026-08-25T04:00:00+08:00', status: 'verified' },
      { title: 'Credential URL', publisher: 'HKBU', url: 'https://user:pass@www.hkbu.edu.hk/', verifiedAt: '2026-08-25T04:00:00+08:00', status: 'verified' },
      { title: 'Wrong port', publisher: 'HKBU', url: 'https://www.hkbu.edu.hk:8443/', verifiedAt: '2026-08-25T04:00:00+08:00', status: 'verified' },
    ],
    cards: [
      { title: '<b>Fake card</b>', label: 'Open', url: 'javascript:alert(1)' },
      { title: 'Wrong port', label: 'Open', url: 'https://ito.hkbu.edu.hk:9443/services/mfa' },
    ],
    suggestedReplies: ['<b>Try this</b>'],
  }, { isLatestAssistant: true });

  const nodes = all(element);
  assert.equal(nodes.find((node) => node.className === 'message-text').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(nodes.some((node) => node.className === 'source-card'), false);
  assert.equal(nodes.some((node) => node.className === 'action-card'), false);
  assert.equal(nodes.find((node) => node.className === 'suggested-reply').textContent, '<b>Try this</b>');
});

test('message renderer calls the official URL allowlist and renders safe source metadata', () => {
  const element = createMessageElement(fakeDocument, {
    id: 'assistant-1', sequence: 1, role: 'assistant', status: 'delivered', text: 'Use the official guide.',
    createdAt: '2026-08-25T08:00:00.000Z', groundingStatus: 'verified',
    citations: [{ title: 'HKBU Duo guide', publisher: 'HKBU ITO', url: 'https://ito.hkbu.edu.hk/services/mfa', verifiedAt: '2026-08-25T04:00:00+08:00', status: 'verified' }],
    cards: [{ title: 'Duo guide', label: 'Open official guide', url: 'https://ito.hkbu.edu.hk/services/mfa' }],
    suggestedReplies: [],
  });

  const nodes = all(element);
  const source = nodes.find((node) => node.className === 'source-card');
  const card = nodes.find((node) => node.className === 'action-card');
  assert.equal(source.href, 'https://ito.hkbu.edu.hk/services/mfa');
  assert.equal(source.rel, 'noopener noreferrer');
  assert.equal(nodes.find((node) => node.className === 'source-title').textContent, 'HKBU Duo guide');
  assert.equal(nodes.find((node) => node.className === 'source-freshness').textContent, 'Checked 25 Aug 2026');
  assert.equal(card.href, 'https://ito.hkbu.edu.hk/services/mfa');
});

test('message renderer sets the answer language and collapses multiple unique official sources', () => {
  const assistant = createMessageElement(fakeDocument, {
    id: 'assistant-2', role: 'assistant', status: 'delivered', text: '已核實的答案',
    replyLanguage: 'yue-Hant-HK', createdAt: '2026-08-25T08:00:00.000Z',
    citations: [
      { title: 'Duo guide', publisher: 'HKBU ITO', url: 'https://ito.hkbu.edu.hk/services/mfa', verifiedAt: '2026-08-25T04:00:00+08:00', status: 'verified' },
      { title: 'Duo duplicate', publisher: 'HKBU ITO', url: 'https://ito.hkbu.edu.hk/services/mfa', verifiedAt: '2026-08-25T04:00:00+08:00', status: 'verified' },
      { title: 'Student guide', publisher: 'HKBU', url: 'https://sa.hkbu.edu.hk/student-guide', verifiedAt: '2026-08-24T04:00:00+08:00', status: 'verified' },
      { title: 'Unsafe', publisher: 'Elsewhere', url: 'https://example.com/', verifiedAt: '2026-08-24T04:00:00+08:00', status: 'verified' },
    ],
  });
  const nodes = all(assistant);
  assert.equal(nodes.find((node) => node.className === 'message-text').attributes.lang, 'zh-HK');
  assert.equal(nodes.filter((node) => node.className === 'source-card').length, 2);
  assert.equal(nodes.find((node) => node.className === 'sources-disclosure').tagName, 'details');
  assert.equal(nodes.find((node) => node.className === 'sources-summary').tagName, 'summary');
  assert.equal(nodes.find((node) => node.className === 'sources-summary').textContent, 'Sources (2)');

  const mandarin = createMessageElement(fakeDocument, {
    id: 'assistant-3', role: 'assistant', status: 'delivered', text: '答案',
    replyLanguage: 'cmn-Hans-CN', citations: [], createdAt: '2026-08-25T08:00:00.000Z',
  });
  assert.equal(all(mandarin).find((node) => node.className === 'message-text').attributes.lang, 'zh-CN');
});

test('message renderer shows an Official next step only for a supplied safe handoff', () => {
  const withoutHandoff = createMessageElement(fakeDocument, {
    id: 'assistant-4', role: 'assistant', status: 'delivered', text: 'I could not confirm that.',
    groundingStatus: 'unverified', cards: [], citations: [], createdAt: '2026-08-25T08:00:00.000Z',
  });
  assert.equal(all(withoutHandoff).some((node) => node.className === 'official-next-step-label'), false);

  const suppliedHandoff = createMessageElement(fakeDocument, {
    id: 'assistant-5', role: 'assistant', status: 'delivered', text: 'I could not confirm that.',
    groundingStatus: 'unverified', citations: [], createdAt: '2026-08-25T08:00:00.000Z',
    cards: [{ title: 'HKBU student guide', label: 'Open official guide', url: 'https://sa.hkbu.edu.hk/student-guide' }],
  });
  const nodes = all(suppliedHandoff);
  assert.equal(nodes.find((node) => node.className === 'official-next-step-label').textContent, 'Official next step');
  assert.equal(nodes.find((node) => node.className === 'action-card').href, 'https://sa.hkbu.edu.hk/student-guide');
});

test('message renderer distinguishes an unconfirmed send from an accepted answer failure', () => {
  const unconfirmed = createMessageElement(fakeDocument, {
    id: 'optimistic:1', clientMessageId: 'client-1', role: 'user', text: 'Question',
    optimistic: true, sendState: 'unconfirmed', createdAt: '2026-08-25T08:00:00.000Z',
  }, { onRetry: () => undefined });
  const acceptedFailure = createMessageElement(fakeDocument, {
    id: 'user-1', clientMessageId: 'client-1', sequence: 1, role: 'user', text: 'Question',
    status: 'failed', failureCode: 'PROVIDER_TIMEOUT', createdAt: '2026-08-25T08:00:00.000Z',
  }, { onRetry: () => undefined });

  const unconfirmedNodes = all(unconfirmed);
  const failedNodes = all(acceptedFailure);
  assert.equal(unconfirmedNodes.find((node) => node.className === 'message-state').textContent, 'Send not confirmed');
  assert.equal(unconfirmedNodes.find((node) => node.className === 'retry-message').hidden, false);
  assert.equal(failedNodes.find((node) => node.className === 'message-state').textContent, 'Reply could not be completed');
  assert.equal(failedNodes.find((node) => node.className === 'retry-message').hidden, true);
});

test('message renderer labels an explicit rejection without offering ambiguous retry', () => {
  const rejected = createMessageElement(fakeDocument, {
    id: 'optimistic:2', clientMessageId: 'client-2', role: 'user', text: 'Question',
    optimistic: true, sendState: 'rejected', failureCode: 'RATE_LIMITED', retryAfter: '10',
    createdAt: '2026-08-25T08:00:00.000Z',
  }, { onRetry: () => undefined });

  const nodes = all(rejected);
  assert.equal(nodes.find((node) => node.className === 'message-state').textContent, 'Not sent · rate limit');
  assert.equal(nodes.find((node) => node.className === 'retry-message').hidden, true);
  assert.equal(nodes.find((node) => node.className.includes('message-avatar')).src, '/assets/ai-senior-avatar-128.png');
});

test('message renderer labels a retryable rate-limit rejection honestly and keeps exact-ID Retry available', () => {
  const retryable = createMessageElement(fakeDocument, {
    id: 'optimistic:3', clientMessageId: 'client-3', role: 'user', text: 'Question',
    optimistic: true, sendState: 'retryable-rejection', failureCode: 'RATE_LIMITED', retryAfter: '10',
    createdAt: '2026-08-25T08:00:00.000Z',
  }, { onRetry: () => undefined });

  const nodes = all(retryable);
  assert.equal(nodes.find((node) => node.className === 'message-state').textContent, 'Not sent · wait to retry');
  assert.equal(nodes.find((node) => node.className === 'retry-message').hidden, false);
});

test('assistant answers expose a hidden text-primary AI voice control without audio or autoplay', () => {
  const assistant = createMessageElement(fakeDocument, {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'assistant', status: 'delivered', text: 'The text answer stays primary.',
    mediaId: '22222222-2222-4222-8222-222222222222',
    createdAt: '2026-08-25T08:00:00.000Z',
  });
  const user = createMessageElement(fakeDocument, {
    id: '33333333-3333-4333-8333-333333333333',
    role: 'user', status: 'accepted', text: 'Question',
    createdAt: '2026-08-25T08:00:00.000Z',
  });

  const assistantNodes = all(assistant);
  const control = assistantNodes.find((node) => node.className === 'assistant-audio');
  const button = assistantNodes.find((node) => node.className === 'assistant-audio-button');
  assert.equal(control.hidden, true);
  assert.equal(control.dataset.messageId, '11111111-1111-4111-8111-111111111111');
  assert.equal(control.dataset.mediaId, '22222222-2222-4222-8222-222222222222');
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, 'Generate voice');
  assert.equal(assistantNodes.find((node) => node.className === 'assistant-audio-disclosure').textContent, 'Optional AI-generated voice');
  assert.equal(assistantNodes.some((node) => node.tagName === 'audio'), false);
  assert.equal(all(user).some((node) => node.className === 'assistant-audio'), false);
});
