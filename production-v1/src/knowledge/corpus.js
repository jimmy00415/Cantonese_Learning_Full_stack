import { readFile } from 'node:fs/promises';

const APPROVED_HOSTS = new Set([
  'ar.hkbu.edu.hk',
  'eo.hkbu.edu.hk',
  'ito.hkbu.edu.hk',
  'library.hkbu.edu.hk',
  'sa.hkbu.edu.hk',
]);

const HKT_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\+08:00$/;
const ID_PATTERN = /^[a-z][a-z0-9.-]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VERIFICATION_STATUSES = new Set(['official_verified', 'conflicted', 'unverified']);
const FORBIDDEN_DATA_KEYS = new Set(['apikey', 'password', 'passcode', 'secret', 'token']);
const REQUIRED_INTENT_GROUPS = Object.freeze([
  'student_card', 'account_password', 'duo', 'it_help', 'residence_check_in',
  'campus_ar_navigation', 'library', 'dining', 'medical', 'osa_counselling',
  'transport', 'emergency',
]);

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertId(id, field, seen) {
  requiredString(id, field);
  if (!ID_PATTERN.test(id)) throw new Error(`${field} is not a canonical ID`);
  if (seen.has(id)) throw new Error(`duplicate ID across source, claim, and action namespaces: ${id}`);
  seen.add(id);
}

function parseHktInstant(value, field, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  requiredString(value, field);
  if (!HKT_RFC3339.test(value)) throw new Error(`${field} must be RFC3339 with +08:00 semantics`);
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error(`${field} is not a valid instant`);
  return instant;
}

function validateCanonicalUrl(value, field) {
  requiredString(value, field);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid canonical URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${field} must use HTTPS`);
  if (!APPROVED_HOSTS.has(url.hostname)) throw new Error(`${field} must use an approved HKBU host`);
  if (url.username || url.password) throw new Error(`${field} must not contain credentials`);
  if (url.port) throw new Error(`${field} must not contain a port`);
  if (url.search || url.hash) throw new Error(`${field} must not contain a query or fragment`);
  if (value.includes('\\') || /%(?:2e|2f|5c)/i.test(value)) {
    throw new Error(`${field} contains path pollution`);
  }
  if (url.href !== value) throw new Error(`${field} must be canonical without URL normalization changes`);
}

function rejectCredentialFields(value, path = 'corpus') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DATA_KEYS.has(key.toLowerCase())) {
      throw new Error(`${path}.${key} must not store credentials or passcodes`);
    }
    rejectCredentialFields(child, `${path}.${key}`);
  }
}

function validateText(text, field) {
  if (!text || typeof text !== 'object' || Array.isArray(text)) {
    throw new Error(`${field} must contain en, zhHant, and zhHans`);
  }
  for (const language of ['en', 'zhHant', 'zhHans']) requiredString(text[language], `${field}.${language}`);
}

function validateReviewAttestation(claim, field) {
  const attestation = claim.reviewAttestation;
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error(`${field}.reviewAttestation is required`);
  }
  requiredString(attestation.reviewer, `${field}.reviewAttestation.reviewer`);
  parseHktInstant(attestation.reviewedAt, `${field}.reviewAttestation.reviewedAt`);
  requiredString(attestation.sourceLocator, `${field}.reviewAttestation.sourceLocator`);
  if (attestation.sourceLocator !== claim.sourceLocator) {
    throw new Error(`${field} attestation locator must equal claim sourceLocator`);
  }
  requiredString(attestation.captureMethod, `${field}.reviewAttestation.captureMethod`);
  if (!['manual_review', 'captured_fragment'].includes(attestation.captureMethod)) {
    throw new Error(`${field}.reviewAttestation.captureMethod is unsupported`);
  }
  if (attestation.sourceHash === null) {
    if (attestation.captureMethod !== 'manual_review') {
      throw new Error(`${field}.reviewAttestation.sourceHash is required for captured fragments`);
    }
    return;
  }
  if (typeof attestation.sourceHash !== 'string'
    || !HASH_PATTERN.test(attestation.sourceHash)
    || /^([a-f0-9])\1{63}$/.test(attestation.sourceHash)) {
    throw new Error(`${field}.reviewAttestation.sourceHash must be a real-looking SHA-256`);
  }
}

function validateClaim(claim, source, field, seen) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error(`${field} must be an object`);
  assertId(claim.id, `${field}.id`, seen);
  if (claim.sourceId !== source.id) throw new Error(`${field}.sourceId must reference its page source`);
  validateText(claim.text, `${field}.text`);
  requiredString(claim.sourceLocator, `${field}.sourceLocator`);
  requiredString(claim.evidenceNote, `${field}.evidenceNote`);
  const verifiedAt = parseHktInstant(claim.verifiedAt, `${field}.verifiedAt`);
  const validFrom = parseHktInstant(claim.validFrom, `${field}.validFrom`, { nullable: true });
  const validUntil = parseHktInstant(claim.validUntil, `${field}.validUntil`, { nullable: true });
  const reviewAfter = parseHktInstant(claim.reviewAfter, `${field}.reviewAfter`);
  if (validFrom && validUntil && validFrom >= validUntil) throw new Error(`${field} has an invalid validity window`);
  if (reviewAfter < verifiedAt) throw new Error(`${field}.reviewAfter cannot predate verifiedAt`);
  requiredString(claim.volatility, `${field}.volatility`);
  if (!VERIFICATION_STATUSES.has(claim.verificationStatus)) {
    throw new Error(`${field}.verificationStatus is unsupported`);
  }
  validateReviewAttestation(claim, field);
}

export function validateCorpus(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('corpus must be an object');
  requiredString(input.schemaVersion, 'schemaVersion');
  parseHktInstant(input.snapshotAt, 'snapshotAt');
  if (!input.governance || typeof input.governance !== 'object') throw new Error('governance is required');
  requiredString(input.governance.owner, 'governance.owner');
  requiredString(input.governance.reviewCadence, 'governance.reviewCadence');
  if (input.governance.timeZone !== 'Asia/Hong_Kong') throw new Error('governance.timeZone must be Asia/Hong_Kong');
  if (!Array.isArray(input.sources) || input.sources.length === 0) throw new Error('sources must be a non-empty array');

  rejectCredentialFields(input);
  const seen = new Set();
  const coveredIntentGroups = new Set();
  for (const [sourceIndex, source] of input.sources.entries()) {
    const field = `sources[${sourceIndex}]`;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(`${field} must be an object`);
    assertId(source.id, `${field}.id`, seen);
    requiredString(source.title, `${field}.title`);
    requiredString(source.publisher, `${field}.publisher`);
    validateCanonicalUrl(source.canonicalUrl, `${field}.canonicalUrl`);
    parseHktInstant(source.verifiedAt, `${field}.verifiedAt`);
    if (!['normal', 'time_sensitive', 'high_stakes'].includes(source.risk)) throw new Error(`${field}.risk is unsupported`);
    if (!Array.isArray(source.intentGroups) || source.intentGroups.length === 0) throw new Error(`${field}.intentGroups is required`);
    for (const intentGroup of source.intentGroups) {
      if (!REQUIRED_INTENT_GROUPS.includes(intentGroup)) throw new Error(`${field} has an unsupported intent group: ${intentGroup}`);
      coveredIntentGroups.add(intentGroup);
    }
    if (!Array.isArray(source.tags)) throw new Error(`${field}.tags must be an array`);
    if (!Array.isArray(source.exampleQuestions)) throw new Error(`${field}.exampleQuestions must be an array`);
    if (!Array.isArray(source.claims) || source.claims.length === 0) throw new Error(`${field}.claims must be a non-empty array`);
    for (const [claimIndex, claim] of source.claims.entries()) {
      validateClaim(claim, source, `${field}.claims[${claimIndex}]`, seen);
    }
    if (source.actions !== undefined) {
      if (!Array.isArray(source.actions)) throw new Error(`${field}.actions must be an array`);
      for (const [actionIndex, action] of source.actions.entries()) {
        const actionField = `${field}.actions[${actionIndex}]`;
        assertId(action.id, `${actionField}.id`, seen);
        if (action.kind !== 'open_source' || action.sourceId !== source.id) {
          throw new Error(`${actionField} must be an allowlisted open_source action`);
        }
        validateText(action.label, `${actionField}.label`);
      }
    }
  }
  for (const intentGroup of REQUIRED_INTENT_GROUPS) {
    if (!coveredIntentGroups.has(intentGroup)) throw new Error(`missing required intent group: ${intentGroup}`);
  }
  return input;
}

export function evaluateClaimFreshness(claim, now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) throw new Error('now must be a valid instant');
  if (claim.verificationStatus === 'conflicted') return 'conflicted';
  if (claim.verificationStatus !== 'official_verified') return 'unverified';
  const verifiedAt = new Date(claim.verifiedAt);
  const validFrom = claim.validFrom ? new Date(claim.validFrom) : null;
  const validUntil = claim.validUntil ? new Date(claim.validUntil) : null;
  const reviewAfter = new Date(claim.reviewAfter);
  if (instant < verifiedAt || (validFrom && instant < validFrom)) return 'not_yet_valid';
  if (validUntil && instant > validUntil) return 'expired';
  if (instant > reviewAfter) return 'review_overdue';
  return 'verified';
}

export async function loadDefaultCorpus() {
  const data = await readFile(new URL('../../data/knowledge/hkbu-v1.json', import.meta.url), 'utf8');
  return validateCorpus(JSON.parse(data));
}

export const approvedKnowledgeHosts = Object.freeze([...APPROVED_HOSTS].sort());
