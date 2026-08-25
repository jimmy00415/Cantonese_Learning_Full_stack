import assert from 'node:assert/strict';
import test from 'node:test';

import * as timelineView from '../public/timeline-view.js';

const { assistantVoiceMessagesToPrepare, currentReplyTupleIsFixed, reconcileMessageFeed } = timelineView;

class FakeNode {
  constructor(label) {
    this.label = label;
    this.dataset = {};
  }
}

class FakeContainer {
  constructor() { this.children = []; }

  insertBefore(node, reference) {
    const oldIndex = this.children.indexOf(node);
    if (oldIndex >= 0) this.children.splice(oldIndex, 1);
    const referenceIndex = reference ? this.children.indexOf(reference) : -1;
    if (referenceIndex >= 0) this.children.splice(referenceIndex, 0, node);
    else this.children.push(node);
    return node;
  }

  replaceChild(node, previous) {
    const index = this.children.indexOf(previous);
    this.children[index] = node;
    return previous;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    return node;
  }
}

function message(overrides = {}) {
  return {
    id: 'message-1', clientMessageId: null, role: 'assistant', status: 'delivered',
    text: 'Hello', citations: [], cards: [], suggestedReplies: [], ...overrides,
  };
}

test('timeline reconciliation preserves unchanged message nodes and appends only additions', () => {
  const container = new FakeContainer();
  const created = [];
  const create = (item, options) => {
    const node = new FakeNode(`${item.id}:${options.isLatestAssistant}`);
    created.push(node);
    return node;
  };
  const firstMessage = message();

  reconcileMessageFeed(container, [firstMessage], create);
  const stableFirstNode = container.children[0];
  reconcileMessageFeed(container, [firstMessage], create);
  assert.equal(container.children[0], stableFirstNode);
  assert.equal(created.length, 1);

  const secondMessage = message({ id: 'message-2', role: 'user', text: 'Question' });
  reconcileMessageFeed(container, [firstMessage, secondMessage], create);
  assert.equal(container.children[0], stableFirstNode);
  assert.equal(container.children.length, 2);
  assert.equal(created.length, 2);
});

test('timeline reconciliation replaces only a changed row and keeps unrelated focused controls mounted', () => {
  const container = new FakeContainer();
  const create = (item) => new FakeNode(item.id);
  const first = message({ id: 'message-1', role: 'user', sendState: 'unconfirmed' });
  const second = message({ id: 'message-2', role: 'assistant' });
  reconcileMessageFeed(container, [first, second], create);
  const focusedUnchangedRow = container.children[0];
  const changingRow = container.children[1];

  reconcileMessageFeed(container, [first, { ...second, status: 'failed' }], create);

  assert.equal(container.children[0], focusedUnchangedRow);
  assert.notEqual(container.children[1], changingRow);
});

test('timeline selects only delivered voice replies that still need status hydration', () => {
  assert.equal(typeof assistantVoiceMessagesToPrepare, 'function');
  const voice = message({
    id: '11111111-1111-4111-8111-111111111111', replyMode: 'voice', mediaId: null,
  });
  const alreadyTracked = message({
    id: '22222222-2222-4222-8222-222222222222', replyMode: 'voice', mediaId: null,
  });
  const ready = message({
    id: '33333333-3333-4333-8333-333333333333', replyMode: 'voice',
    mediaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  const text = message({ id: '44444444-4444-4444-8444-444444444444', replyMode: 'text' });
  const user = message({ id: '55555555-5555-4555-8555-555555555555', role: 'user', replyMode: 'voice' });
  const invalid = message({ id: 'not-a-public-id', replyMode: 'voice' });

  assert.deepEqual(
    assistantVoiceMessagesToPrepare(
      [voice, alreadyTracked, ready, text, user, invalid],
      { [alreadyTracked.id]: { state: 'generating' } },
    ).map((item) => item.id),
    [voice.id],
  );
});

test('reply preference presentation treats the deferred voice binding phase as already fixed', () => {
  assert.equal(typeof currentReplyTupleIsFixed, 'function');
  assert.equal(currentReplyTupleIsFixed({
    voiceSnapshot: { phase: 'binding', binding: null },
    messages: [],
  }), true);
  assert.equal(currentReplyTupleIsFixed({
    voiceSnapshot: { phase: 'send-unconfirmed', binding: { replyLanguage: 'en', replyMode: 'text' } },
    messages: [],
  }), true);
  assert.equal(currentReplyTupleIsFixed({
    voiceSnapshot: { phase: 'draft-ready', binding: null },
    messages: [],
  }), false);
  assert.equal(currentReplyTupleIsFixed({
    voiceSnapshot: null,
    messages: [{ optimistic: true, sendState: 'sending' }],
  }), true);
});
