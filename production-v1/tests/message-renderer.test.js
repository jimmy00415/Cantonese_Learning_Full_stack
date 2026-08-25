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
  assert.equal(nodes.find((node) => node.className === 'source-freshness').textContent, 'Verified 25 Aug 2026');
  assert.equal(card.href, 'https://ito.hkbu.edu.hk/services/mfa');
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
