import { readFile } from 'node:fs/promises';

const APPROVED_HOSTS = new Set([
  'ar.hkbu.edu.hk',
  'eo.hkbu.edu.hk',
  'ito.hkbu.edu.hk',
  'library.hkbu.edu.hk',
  'sa.hkbu.edu.hk',
]);

const HKT_RFC3339 = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<millisecond>\d{1,3}))?\+08:00$/;
const ID_PATTERN = /^[a-z][a-z0-9.-]+$/;
const VERIFICATION_STATUSES = new Set(['official_verified', 'conflicted', 'unverified']);
const FORBIDDEN_DATA_KEYS = new Set(['apikey', 'password', 'passcode', 'secret', 'token']);
const REQUIRED_INTENT_GROUPS = Object.freeze([
  'student_card', 'account_password', 'duo', 'it_help', 'residence_check_in',
  'campus_ar_navigation', 'library', 'dining', 'medical', 'osa_counselling',
  'transport', 'emergency', 'hall_facilities', 'hall_maintenance',
  'international_support', 'orientation', 'dining_inventory', 'language_learning',
  'living_supplies',
]);
const OPERATIONAL_QUALIFIERS = Object.freeze([
  'inventoryOnly', 'listedHoursOnly', 'scopeOnly', 'mustNotPromote',
]);
const REVIEW_WINDOW_DAYS = Object.freeze({
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 31,
  quarterly: 92,
});
const APPROVED_SOURCE_LANGUAGES = new Set(['en', 'zhHant', 'zhHans']);
const APPROVED_OWNER_OFFICES = new Set([
  'HKBU Academic Registry',
  'HKBU Office of Information Technology',
  'HKBU Office of Student Affairs',
  'HKBU Office of Student Affairs / Accommodation and Campus Management (ACCM)',
  'HKBU Office of Student Affairs / First Year Experience (FYE)',
  'HKBU Office of Student Affairs / Campus Life & Amenities',
  'HKBU Estates Office',
  'HKBU Library',
]);
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

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
  const match = HKT_RFC3339.exec(value);
  if (!match) throw new Error(`${field} must be RFC3339 with +08:00 semantics`);
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  const second = Number(match.groups.second);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`${field} is not a valid calendar instant`);
  }
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
  if (attestation.captureMethod !== 'manual_review') {
    throw new Error(`${field}.reviewAttestation.captureMethod captured_fragment is unsupported until the stored normalized fragment can be recomputed`);
  }
  if (attestation.sourceHash !== null) {
    throw new Error(`${field}.reviewAttestation.sourceHash must be null for manual_review; an arbitrary SHA-256 is not evidence`);
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
  if (claim.facts !== undefined) {
    if (!claim.facts || typeof claim.facts !== 'object' || Array.isArray(claim.facts)) {
      throw new Error(`${field}.facts must be an object`);
    }
    for (const qualifier of OPERATIONAL_QUALIFIERS) {
      if (claim.facts[qualifier] !== undefined && typeof claim.facts[qualifier] !== 'boolean') {
        throw new Error(`${field}.facts.${qualifier} must be boolean`);
      }
    }
    if (claim.facts.mustNotPromote === true && claim.verificationStatus === 'official_verified') {
      throw new Error(`${field}.facts.mustNotPromote cannot be official_verified`);
    }
  }
  if (!Object.hasOwn(REVIEW_WINDOW_DAYS, claim.volatility)) {
    throw new Error(`${field}.volatility is unsupported`);
  }
  validateReviewAttestation(claim, field);
}

function validateSourceGovernance(source, field) {
  const governance = source.sourceGovernance;
  if (!governance || typeof governance !== 'object' || Array.isArray(governance)) {
    throw new Error(`${field}.sourceGovernance is required`);
  }
  requiredString(governance.ownerOffice, `${field}.sourceGovernance.ownerOffice`);
  if (!APPROVED_OWNER_OFFICES.has(governance.ownerOffice)) {
    throw new Error(`${field}.sourceGovernance.ownerOffice is not a reviewed HKBU owner office`);
  }
  if (!Array.isArray(governance.categories) || governance.categories.length === 0) {
    throw new Error(`${field}.sourceGovernance.categories is required`);
  }
  const expectedCategories = [...new Set(source.intentGroups)].sort();
  const actualCategories = [...new Set(governance.categories)].sort();
  if (actualCategories.length !== governance.categories.length
    || actualCategories.length !== expectedCategories.length
    || actualCategories.some((category, index) => category !== expectedCategories[index])) {
    throw new Error(`${field}.sourceGovernance.categories must exactly cover intentGroups`);
  }
  if (!Array.isArray(governance.languages) || governance.languages.length === 0
    || new Set(governance.languages).size !== governance.languages.length
    || governance.languages.some((language) => !APPROVED_SOURCE_LANGUAGES.has(language))) {
    throw new Error(`${field}.sourceGovernance.languages must identify unique reviewed source languages`);
  }
  requiredString(governance.volatility, `${field}.sourceGovernance.volatility`);
  requiredString(governance.reviewCadence, `${field}.sourceGovernance.reviewCadence`);
  if (!Object.hasOwn(REVIEW_WINDOW_DAYS, governance.volatility)) {
    throw new Error(`${field}.sourceGovernance.volatility is unsupported`);
  }
  if (!Object.hasOwn(REVIEW_WINDOW_DAYS, governance.reviewCadence)) {
    throw new Error(`${field}.sourceGovernance.reviewCadence is unsupported`);
  }
  const strictestClaimWindowDays = Math.min(
    ...source.claims.map((claim) => REVIEW_WINDOW_DAYS[claim.volatility]),
  );
  const strictestActualReviewHorizonDays = Math.min(...source.claims.map((claim) => (
    Math.max(1, Math.ceil(
      (new Date(claim.reviewAfter).getTime() - new Date(claim.verifiedAt).getTime())
      / MILLISECONDS_PER_DAY,
    ))
  )));
  if (REVIEW_WINDOW_DAYS[governance.volatility] > strictestClaimWindowDays) {
    throw new Error(`${field}.sourceGovernance.volatility cannot be looser than its claims`);
  }
  if (REVIEW_WINDOW_DAYS[governance.reviewCadence] > strictestClaimWindowDays) {
    throw new Error(`${field}.sourceGovernance.reviewCadence cannot be looser than its claims`);
  }
  if (REVIEW_WINDOW_DAYS[governance.volatility] > strictestActualReviewHorizonDays) {
    throw new Error(`${field}.sourceGovernance.volatility cannot exceed the actual claim review horizon`);
  }
  if (REVIEW_WINDOW_DAYS[governance.reviewCadence] > strictestActualReviewHorizonDays) {
    throw new Error(`${field}.sourceGovernance.reviewCadence cannot exceed the actual claim review horizon`);
  }
  if (!Number.isInteger(governance.evidenceWindowDays)
    || governance.evidenceWindowDays < 1
    || governance.evidenceWindowDays > 92) {
    throw new Error(`${field}.sourceGovernance.evidenceWindowDays must be a positive bounded integer`);
  }
  if (governance.evidenceWindowDays > strictestClaimWindowDays) {
    throw new Error(`${field}.sourceGovernance.evidenceWindowDays cannot be looser than its claims`);
  }
  if (governance.evidenceWindowDays > strictestActualReviewHorizonDays) {
    throw new Error(`${field}.sourceGovernance.evidenceWindowDays cannot exceed the actual claim review horizon`);
  }
  const attestation = governance.reviewAttestation;
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error(`${field}.sourceGovernance.reviewAttestation is required`);
  }
  requiredString(attestation.reviewer, `${field}.sourceGovernance.reviewAttestation.reviewer`);
  parseHktInstant(attestation.reviewedAt, `${field}.sourceGovernance.reviewAttestation.reviewedAt`);
  if (attestation.reviewedAt !== source.verifiedAt) {
    throw new Error(`${field}.sourceGovernance.reviewAttestation.reviewedAt must equal source verifiedAt`);
  }
  if (attestation.captureMethod !== 'manual_review') {
    throw new Error(`${field}.sourceGovernance.reviewAttestation.captureMethod must be manual_review`);
  }
  if (attestation.sourceHash !== null) {
    throw new Error(`${field}.sourceGovernance.reviewAttestation.sourceHash must be null for manual_review`);
  }
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
    validateSourceGovernance(source, field);
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
