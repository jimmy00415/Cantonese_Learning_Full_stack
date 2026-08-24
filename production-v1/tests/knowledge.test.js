import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateClaimFreshness,
  loadDefaultCorpus,
  validateCorpus,
} from '../src/knowledge/corpus.js';
import { createRetriever, normalizeKnowledgeQuery } from '../src/knowledge/retriever.js';
import { routeSafety } from '../src/knowledge/safety.js';

const FIXED_NOW = '2026-08-25T12:00:00+08:00';
const corpus = await loadDefaultCorpus();
const retrieve = createRetriever({ corpus, now: () => new Date(FIXED_NOW) }).retrieve;

function copy(value) {
  return structuredClone(value);
}

function firstClaim(candidate = corpus) {
  return candidate.sources[0].claims[0];
}

test('knowledge corpus validates the reviewed official source and evidence contract', () => {
  const validated = validateCorpus(copy(corpus));
  const intentGroups = new Set(validated.sources.flatMap((source) => source.intentGroups));

  assert.equal(validated.governance.owner, 'Hong Kong Buddy knowledge owner');
  assert.equal(validated.governance.timeZone, 'Asia/Hong_Kong');
  assert.deepEqual(
    [...intentGroups].sort(),
    [
      'account_password', 'campus_ar_navigation', 'dining', 'duo', 'emergency', 'it_help',
      'library', 'medical', 'osa_counselling', 'residence_check_in', 'student_card', 'transport',
    ],
  );

  for (const source of validated.sources) {
    const url = new URL(source.canonicalUrl);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    for (const claim of source.claims) {
      assert.deepEqual(Object.keys(claim.text).sort(), ['en', 'zhHans', 'zhHant']);
      assert.equal(claim.reviewAttestation.sourceLocator, claim.sourceLocator);
      assert.ok(claim.evidenceNote.length > 0);
    }
  }
});

test('knowledge corpus rejects unsafe or polluted canonical URLs', () => {
  const cases = [
    ['http://ito.hkbu.edu.hk/services/it-security/mfa.html', /HTTPS/],
    ['https://ito.hkbu.edu.hk.evil.example/services/it-security/mfa.html', /approved HKBU host/],
    ['https://evil-hkbu.edu.hk/services/it-security/mfa.html', /approved HKBU host/],
    ['https://user:pass@ito.hkbu.edu.hk/services/it-security/mfa.html', /credentials/],
    ['https://ito.hkbu.edu.hk/services/it-security/mfa.html?next=https://evil.example', /query or fragment/],
    ['https://ito.hkbu.edu.hk/services/it-security/mfa.html#spoofed', /query or fragment/],
  ];

  for (const [canonicalUrl, expected] of cases) {
    const invalid = copy(corpus);
    invalid.sources[0].canonicalUrl = canonicalUrl;
    assert.throws(() => validateCorpus(invalid), expected, canonicalUrl);
  }
});

test('knowledge corpus rejects incomplete evidence, invalid HKT windows, and fake hashes', () => {
  const mutations = [
    [(claim) => { claim.sourceLocator = ''; }, /sourceLocator/],
    [(claim) => { delete claim.reviewAttestation; }, /reviewAttestation/],
    [(claim) => { claim.reviewAttestation.sourceLocator = 'different section'; }, /attestation locator/],
    [(claim) => { claim.reviewAttestation.captureMethod = ''; }, /captureMethod/],
    [(claim) => { claim.reviewAttestation.sourceHash = 'placeholder'; }, /SHA-256/],
    [(claim) => { claim.reviewAttestation.sourceHash = '0'.repeat(64); }, /SHA-256/],
    [(claim) => { claim.verifiedAt = '2026-08-25T04:00:00Z'; }, /\+08:00/],
    [(claim) => { claim.reviewAfter = '2026-08-20T12:00:00+08:00'; }, /reviewAfter/],
    [(claim) => {
      claim.validFrom = '2026-09-02T00:00:00+08:00';
      claim.validUntil = '2026-09-01T00:00:00+08:00';
    }, /validity window/],
  ];

  for (const [mutate, expected] of mutations) {
    const invalid = copy(corpus);
    mutate(firstClaim(invalid));
    assert.throws(() => validateCorpus(invalid), expected);
  }
});

test('knowledge corpus enforces one global source, claim, and action ID namespace', () => {
  const sourceClaimCollision = copy(corpus);
  sourceClaimCollision.sources[1].id = firstClaim(sourceClaimCollision).id;
  assert.throws(() => validateCorpus(sourceClaimCollision), /duplicate ID/);

  const actionSourceCollision = copy(corpus);
  const sourceWithAction = actionSourceCollision.sources.find((source) => source.actions?.length);
  sourceWithAction.actions[0].id = actionSourceCollision.sources[0].id;
  assert.throws(() => validateCorpus(actionSourceCollision), /duplicate ID/);
});

test('knowledge corpus fails closed when a required campus intent group is missing', () => {
  const incomplete = copy(corpus);
  for (const source of incomplete.sources) {
    source.intentGroups = source.intentGroups.filter((intent) => intent !== 'transport');
  }
  assert.throws(() => validateCorpus(incomplete), /missing required intent group: transport/);
});

test('knowledge freshness is claim-level and only current official evidence is supportable', () => {
  const base = copy(firstClaim());
  assert.equal(evaluateClaimFreshness(base, new Date(FIXED_NOW)), 'verified');

  const cases = [
    [{ ...base, reviewAfter: '2026-08-25T11:59:59+08:00' }, 'review_overdue'],
    [{ ...base, validUntil: '2026-08-25T11:59:59+08:00' }, 'expired'],
    [{ ...base, validFrom: '2026-08-25T12:00:01+08:00' }, 'not_yet_valid'],
    [{ ...base, verificationStatus: 'conflicted' }, 'conflicted'],
    [{ ...base, verificationStatus: 'unverified' }, 'unverified'],
  ];
  for (const [claim, status] of cases) {
    assert.equal(evaluateClaimFreshness(claim, new Date(FIXED_NOW)), status);
  }

  const library = retrieve('Main Library opening hours');
  assert.equal(library.supportableClaims.every((claim) => claim.status === 'verified'), true);
  assert.equal(library.staleClaims.some((claim) => claim.status === 'not_yet_valid'), true);
  assert.equal(library.evidenceIds.every((id) => id.startsWith('evidence.')), true);
  assert.equal(library.evidenceIds.includes(library.topSourceId), false);

  const expiredCorpus = copy(corpus);
  const closure = expiredCorpus.sources.find((source) => source.id === 'hkbu.eo.dining.bu-fiesta').claims[0];
  closure.validUntil = '2026-08-25T11:59:59+08:00';
  const expired = createRetriever({ corpus: expiredCorpus, now: () => new Date(FIXED_NOW) }).retrieve('BU Fiesta open');
  assert.equal(expired.supportableClaims.some((claim) => claim.id === closure.id), false);
  assert.equal(expired.staleClaims.find((claim) => claim.id === closure.id).status, 'expired');
});

test('knowledge retrieval returns reviewed Duo and BU Fiesta facts deterministically', () => {
  const duo = retrieve('Duo 换手机怎么办');
  const fiesta = retrieve('BU Fiesta 今日开吗');

  assert.equal(duo.topSourceId, 'hkbu.ito.duo');
  assert.equal(duo.supportableClaims.some((claim) => claim.facts.issue === 'new_phone'), true);
  assert.equal(fiesta.topSourceId, 'hkbu.eo.dining.bu-fiesta');
  assert.equal(fiesta.claims[0].status, 'verified');
  assert.equal(fiesta.claims[0].facts.open, false);
  assert.match(fiesta.claims[0].text.en, /closed for renovation until further notice/i);
  assert.deepEqual(retrieve('BU Fiesta 今日开吗').evidenceIds, fiesta.evidenceIds);
});

test('knowledge residence evidence keeps 2026 schedules separate from stale 2025/26 reminders', () => {
  const village = retrieve('Village CARE non-local freshman check-in 2026');
  const halls = retrieve('Student Residence Halls local freshman check-in 2026');

  for (const result of [village, halls]) {
    assert.equal(result.supportableClaims.some((claim) => claim.facts.academicYear === '2026/27'), true);
    assert.equal(result.supportableClaims.some((claim) => JSON.stringify(claim).includes('2025/26')), false);
    assert.equal(result.staleClaims.some((claim) => claim.status === 'conflicted'), true);
  }
});

test('knowledge retrieval asks for branch, cohort, or current special-hours detail instead of guessing', () => {
  const library = retrieve('图书馆今天几点关门');
  const residence = retrieve('宿舍什么时候 check in');
  const catering = retrieve('Main Canteen 今日开到几点');

  assert.equal(library.needsClarification, true);
  assert.ok(library.ambiguityCodes.includes('LIBRARY_BRANCH_REQUIRED'));
  assert.equal(residence.needsClarification, true);
  assert.ok(residence.ambiguityCodes.includes('RESIDENCE_COHORT_REQUIRED'));
  assert.equal(catering.needsClarification, true);
  assert.ok(catering.ambiguityCodes.includes('CATERING_SPECIAL_HOURS_REQUIRED'));
});

test('knowledge retrieval normalizes bilingual aliases without Latin substring false positives', () => {
  assert.equal(normalizeKnowledgeQuery('  JC³\u200b， Room 201　'), 'jc3 room 201');
  assert.equal(retrieve('JC3 Room 201 在哪').topSourceId, 'hkbu.eo.campus-map');
  assert.notEqual(retrieve('library').topSourceId, 'hkbu.ar.contact');
  assert.equal(retrieve('雙重認證換咗電話').topSourceId, 'hkbu.ito.duo');
  assert.equal(retrieve('双重认证换了手机').topSourceId, 'hkbu.ito.duo');
  assert.equal(retrieve('點樣搵學生事務處').topSourceId, 'hkbu.sa.contact');
});

test('knowledge retrieval is stable for empty, long, punctuation, and emoji-only inputs', () => {
  for (const input of ['', ' '.repeat(40), '🔥🙂', '，。！？', `Duo ${'x'.repeat(20_000)}`]) {
    const result = retrieve(input);
    assert.equal(typeof result.needsClarification, 'boolean');
    assert.ok(Array.isArray(result.supportableClaims));
    assert.ok(Array.isArray(result.sources));
  }
});

test('knowledge corpus keeps time-sensitive replacement, dental, MTR, and catering facts honest', () => {
  const replacement = retrieve('student card replacement fee');
  const dental = retrieve('student dental scheme fee');
  const transport = retrieve('MTR student travel scheme 2025/26');

  assert.equal(replacement.supportableClaims.some((claim) => claim.facts.feeHkd === 100), true);
  assert.equal(dental.supportableClaims.some((claim) => claim.sourceLocator.toLowerCase().includes('dental')), false);
  assert.equal(dental.staleClaims.some((claim) => claim.status === 'conflicted'), true);
  assert.equal(transport.supportableClaims.some((claim) => JSON.stringify(claim).includes('2025/26')), false);
});

test('knowledge safety bypasses retrieval for immediate danger in English, Traditional, and Simplified Chinese', () => {
  const emergencies = [
    ['Someone is badly injured and bleeding heavily now', 'injury'],
    ['My roommate is unconscious and not breathing', 'injury'],
    ['有人受傷，流好多血', 'injury'],
    ['有人受伤流很多血', 'injury'],
    ['The building is on fire right now', 'fire'],
    ['宿舍而家火警', 'fire'],
    ['宿舍现在着火了', 'fire'],
    ['I am going to kill myself now', 'self_harm'],
    ['I want to kill myself right now', 'self_harm'],
    ['My roommate wants to kill herself now', 'self_harm'],
    ['我而家想自殺', 'self_harm'],
    ['我朋友现在要自杀', 'self_harm'],
    ['佢而家想自殺', 'self_harm'],
    ['他现在要自杀', 'self_harm'],
    ['Someone has a knife and is attacking people', 'violence'],
    ['有人持刀傷人', 'violence'],
    ['有人持刀伤人', 'violence'],
  ];

  for (const [input, category] of emergencies) {
    const routed = routeSafety(input, { emergencyNumber: '000', securityNumber: '0000' });
    assert.equal(routed.kind, 'emergency', input);
    assert.equal(routed.category, category, input);
    assert.deepEqual(routed.contacts.map((contact) => contact.phone), ['999', '3411 7777']);
    assert.equal(routed.bypassRetrieval, true);
  }

  const bypassed = retrieve('宿舍现在着火了');
  assert.equal(bypassed.kind, 'emergency');
  assert.equal(bypassed.supportableClaims.length, 0);
});

test('knowledge safety does not misroute drills, account help, figures of speech, or non-urgent care', () => {
  const nearMisses = [
    'Duo emergency access code',
    'firewall login problem',
    'There is a scheduled fire drill tomorrow',
    'I am dying to know the library hours',
    'Where is the non-urgent Health Centre?',
    'violence prevention workshop',
    'self-harm research resources',
    '冇火警，只係演習',
    '没有火灾，只是演习',
  ];

  for (const input of nearMisses) {
    assert.equal(routeSafety(input).kind, 'normal', input);
  }

  assert.equal(routeSafety('This is not a drill: the building is on fire').kind, 'emergency');
  assert.equal(routeSafety('A fire drill is planned, but a room is on fire now').kind, 'emergency');
  assert.equal(routeSafety('I am not joking, I will kill myself now').kind, 'emergency');
  assert.equal(routeSafety('I was reading self-harm research, but my friend is trying to kill himself now').kind, 'emergency');
  assert.equal(routeSafety('At a violence prevention workshop, someone has a knife and is attacking people').kind, 'emergency');
});
