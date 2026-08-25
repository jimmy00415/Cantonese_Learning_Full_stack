import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileMessageFeed } from '../public/timeline-view.js';

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
