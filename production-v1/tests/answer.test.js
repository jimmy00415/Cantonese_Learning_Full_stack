import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDefaultCorpus } from '../src/knowledge/corpus.js';
import { createRetriever } from '../src/knowledge/retriever.js';
import { createAnswerService, parseModelDraft } from '../src/services/answer.js';

const FIXED_NOW = new Date('2026-08-25T12:00:00+08:00');
const corpus = await loadDefaultCorpus();
const retriever = createRetriever({ corpus, now: () => FIXED_NOW });

function validDraft(overrides = {}) {
  return {
    replyText: 'Use the official Duo guidance for a changed phone.',
    evidenceIds: ['evidence.ito.duo.new-phone'],
    actionIds: ['action.ito.duo.open'],
    suggestedReplies: ['Where is ITO?'],
    needsClarification: false,
    groundingStatus: 'verified',
    ...overrides,
  };
}

test('answer parser accepts one fenced object and handles braces inside JSON strings', () => {
  const retrieval = retriever.retrieve('Duo 换手机怎么办');
  const draft = validDraft({ replyText: 'Open {Duo} guidance without guessing.' });
  const parsed = parseModelDraft(`Here is the result:\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``, { retrieval, corpus });
  assert.equal(parsed.replyText, draft.replyText);
  assert.deepEqual(parsed.evidenceIds, draft.evidenceIds);
  assert.equal(parsed.groundingStatus, 'verified');
});

test('answer parser rejects multiple, truncated, oversized, legacy, arbitrary-card, and extra-property output', () => {
  const retrieval = retriever.retrieve('Duo 换手机怎么办');
  const invalid = [
    `${JSON.stringify(validDraft())}\n${JSON.stringify(validDraft())}`,
    JSON.stringify(validDraft()).slice(0, -1),
    JSON.stringify({ ...validDraft(), citationIds: ['legacy'] }),
    JSON.stringify({ ...validDraft(), cards: [{ url: 'https://evil.example' }] }),
    JSON.stringify({ ...validDraft(), arbitrary: true }),
    JSON.stringify(validDraft({ replyText: 'x'.repeat(4001) })),
    JSON.stringify(validDraft({ evidenceIds: Array.from({ length: 9 }, (_, index) => `evidence.${index}`) })),
    JSON.stringify(validDraft({ suggestedReplies: ['x'.repeat(161)] })),
  ];
  for (const rawText of invalid) {
    assert.throws(() => parseModelDraft(rawText, { retrieval, corpus }), /MODEL_DRAFT_INVALID|MODEL_DRAFT_TOO_LARGE/);
  }
});

test('answer parser rejects unknown or stale evidence and non-allowlisted actions', () => {
  const retrieval = retriever.retrieve('Duo 换手机怎么办');
  for (const overrides of [
    { evidenceIds: ['evidence.unknown'] },
    { evidenceIds: ['evidence.library.main.from-september-2026'] },
    { actionIds: ['action.unknown'] },
  ]) {
    assert.throws(() => parseModelDraft(JSON.stringify(validDraft(overrides)), { retrieval, corpus }), /MODEL_DRAFT_INVALID/);
  }
});

test('answer parser downgrades unsupported verified status instead of promoting an uncited claim', () => {
  const retrieval = retriever.retrieve('Duo 换手机怎么办');
  const parsed = parseModelDraft(JSON.stringify(validDraft({ evidenceIds: [], actionIds: [], groundingStatus: 'verified' })), { retrieval, corpus });
  assert.equal(parsed.groundingStatus, 'unverified');
});

test('answer service maps only corpus evidence/actions into citations and cards', async () => {
  const provider = {
    provider: 'hkbu',
    async generate() {
      return { rawText: JSON.stringify(validDraft()), provider: 'hkbu', latencyMs: 12, usage: {}, finishReason: 'stop', providerRequestId: 'request-1' };
    },
  };
  const service = createAnswerService({ corpus, retriever, llmProvider: provider, now: () => FIXED_NOW });
  let generatingCalls = 0;
  const answer = await service.answer({ turnId: 'turn-1', text: 'Duo 换手机怎么办', context: [], beforeProvider: async () => { generatingCalls += 1; } });
  assert.equal(generatingCalls, 1);
  assert.equal(answer.text, validDraft().replyText);
  assert.equal(answer.groundingStatus, 'verified');
  assert.deepEqual(answer.citations.map((citation) => citation.evidenceId), ['evidence.ito.duo.new-phone']);
  assert.equal(answer.citations[0].url, 'https://ito.hkbu.edu.hk/services/it-security/mfa.html');
  assert.deepEqual(answer.cards.map((card) => card.actionId), ['action.ito.duo.open']);
  assert.equal(answer.cards[0].url, 'https://ito.hkbu.edu.hk/services/it-security/mfa.html');
});

test('answer service falls back deterministically to selected evidence and source metadata on provider failure', async () => {
  const provider = { provider: 'hkbu', async generate() { throw Object.assign(new Error('private provider body'), { code: 'PROVIDER_UNAVAILABLE' }); } };
  const service = createAnswerService({ corpus, retriever, llmProvider: provider, now: () => FIXED_NOW });
  const first = await service.answer({ turnId: 'turn-1', text: 'Duo 换手机怎么办', context: [], beforeProvider: async () => {} });
  const second = await service.answer({ turnId: 'turn-1', text: 'Duo 换手机怎么办', context: [], beforeProvider: async () => {} });
  const selected = retriever.retrieve('Duo 换手机怎么办').supportableClaims.flatMap((claim) => [claim.text.zhHant, claim.text.zhHans]);
  assert.deepEqual(first, second);
  assert.equal(first.fallback, true);
  assert.equal(first.groundingStatus, 'verified');
  assert.equal(selected.some((text) => first.text.includes(text)), true);
  assert.equal(first.text.includes('private provider body'), false);
  assert.equal(first.citations.every((citation) => citation.url.endsWith('.hkbu.edu.hk/services/it-security/mfa.html')), true);
});

test('answer service is honestly unverified when retrieval is insufficient and still offers an official directory source', async () => {
  let providerCalls = 0;
  const provider = { provider: 'hkbu', async generate() { providerCalls += 1; throw new Error('must not be called'); } };
  const service = createAnswerService({ corpus, retriever, llmProvider: provider, now: () => FIXED_NOW });
  const answer = await service.answer({ turnId: 'turn-unknown', text: 'Where can I rent a purple submarine on campus?', context: [] });
  assert.equal(providerCalls, 0);
  assert.equal(answer.groundingStatus, 'unverified');
  assert.equal(answer.needsClarification, true);
  assert.match(answer.text, /could not confirm|未能確認|未能确认/i);
  assert.equal(answer.citations.every((citation) => citation.url.startsWith('https://') && citation.url.includes('hkbu.edu.hk')), true);
});

test('answer service safety bypass is deterministic, multilingual, and never calls the model', async () => {
  let providerCalls = 0;
  const provider = { provider: 'hkbu', async generate() { providerCalls += 1; throw new Error('must not be called'); } };
  const service = createAnswerService({ corpus, retriever, llmProvider: provider, now: () => FIXED_NOW });
  const answer = await service.answer({ turnId: 'turn-danger', text: '宿舍现在着火了', context: [] });
  assert.equal(providerCalls, 0);
  assert.equal(answer.safety, true);
  assert.match(answer.text, /999/);
  assert.match(answer.text, /3411 7777/);
  assert.equal(answer.citations.some((citation) => citation.url.includes('Security-Control-Rooms-and-Security-Hotline')), true);
});
