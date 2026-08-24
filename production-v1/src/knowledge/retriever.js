import { evaluateClaimFreshness } from './corpus.js';
import { routeSafety } from './safety.js';

const INTENT_ALIASES = Object.freeze({
  student_card: ['student card', 'student e card', 'ecard', 'e card', '學生證', '学生证', '學生卡', '学生卡', '校卡', '補領學生證', '补领学生证'],
  account_password: ['ssoid', 'account password', 'forgot password', 'reset password', '帳戶密碼', '账户密码', '忘記密碼', '忘记密码', '學生帳戶', '学生账户'],
  duo: ['duo', 'mfa', 'multi factor authentication', 'two factor authentication', '雙重認證', '双重认证', '兩步驗證', '两步验证', '換咗電話', '换了手机'],
  it_help: ['ito', 'it help', 'it support', 'service call centre', '電腦支援', '电脑支援', '技術支援', '技术支持', 'rrs303'],
  residence_check_in: ['residence check in', 'residence hall', 'student residence', 'village care', 'hostel check in', 'hostel', 'residence', '宿舍', '住宿', '入住', '入宿', 'check in'],
  campus_ar_navigation: ['campus map', 'academic registry', 'ar office', 'ar', 'sce tower', 'jc3', 'jockey club campus of creativity', '校園地圖', '校园地图', '教務處', '教务处', '學術註冊處', '学术注册处'],
  library: ['library', 'main library', 'chinese medicine library', 'shek mun campus library', 'cml', 'smcl', '主館', '主馆', '圖書館', '图书馆', '書館', '书馆'],
  dining: ['canteen', 'catering', 'restaurant', 'food', 'bu fiesta', 'main canteen', '飯堂', '饭堂', '餐廳', '餐厅', '食堂', '食嘢', '吃饭'],
  medical: ['health centre', 'health center', 'medical', 'doctor', 'dental', 'clinic', '健康中心', '醫療', '医疗', '睇醫生', '看医生', '牙科'],
  osa_counselling: ['office of student affairs', 'osa', 'student affairs', 'counselling', 'counseling', 'cdc', '學生事務處', '学生事务处', '輔導', '辅导', '心理諮詢', '心理咨询'],
  transport: ['transport', 'mtr', 'minibus', 'bus', 'kowloon tong station', '交通', '港鐵', '港铁', '地鐵', '地铁', '小巴', '巴士'],
  emergency: ['emergency contacts', 'hkbu security', 'security hotline', '保安', '緊急聯絡', '紧急联络'],
});

const BRANCH_ALIASES = ['main library', '主館', '主馆', '主圖書館', '主图书馆', 'fong shu chuen library', 'cml', 'chinese medicine library', '中醫藥圖書館', '中医药图书馆', 'smcl', 'shek mun', '石門', '石门'];
const COHORT_ALIASES = ['non local freshman', 'non local freshmen', 'non-local freshman', 'local freshman', 'local freshmen', 'exchange student', 'exchange students', 'returning student', 'returning students', 'research postgraduate', 'research postgraduates', 'rpg', '非本地新生', '本地新生', '交換生', '交换生', '研究生', '舊生', '旧生'];
const STUDENT_ADMISSION_ALIASES = ['jupas', 'non jupas', 'non-jupas'];
const STUDENT_PHOTO_ROUTE_ALIASES = [
  'uploaded by', 'photo by', 'photo upload date', 'digital photo',
  '2 august', '7 august', '23 august', '1 september',
  '2026-08-02', '2026-08-07', '2026-08-23', '2026-09-01',
  '相片上載', '照片上传', '上載電子相片', '上传电子照片',
];
const CURRENT_HOURS_ALIASES = ['today', 'current', 'now', '今日', '今天', '而家', '現在', '现在', '幾點', '几点'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeKnowledgeQuery(value) {
  return String(value ?? '')
    .slice(0, 8192)
    .normalize('NFKC')
    .replace(/[\p{Cf}\u180E]/gu, '')
    .replace(/([a-zA-Z0-9])([\p{Script=Han}])/gu, '$1 $2')
    .replace(/([\p{Script=Han}])([a-zA-Z0-9])/gu, '$1 $2')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phraseMatches(query, rawPhrase) {
  const phrase = normalizeKnowledgeQuery(rawPhrase);
  if (!phrase) return false;
  if (/\p{Script=Han}/u.test(phrase)) return query.includes(phrase);
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}(?:$|[^\\p{L}\\p{N}])`, 'u').test(query);
}

function scoreClaim(claim, query) {
  let score = 0;
  for (const keyword of claim.keywords ?? []) {
    if (phraseMatches(query, keyword)) score += 100 + normalizeKnowledgeQuery(keyword).length;
  }
  return score;
}

function matchedIntents(query) {
  const matches = [];
  for (const [intent, aliases] of Object.entries(INTENT_ALIASES)) {
    let score = 0;
    for (const alias of aliases) {
      if (phraseMatches(query, alias)) score = Math.max(score, 1_000 + normalizeKnowledgeQuery(alias).length);
    }
    if (score > 0) matches.push({ intent, score });
  }
  return matches;
}

function sourceSpecificity(source, query) {
  let score = 0;
  if (phraseMatches(query, source.title)) score += 600 + normalizeKnowledgeQuery(source.title).length;
  for (const example of source.exampleQuestions) {
    if (phraseMatches(query, example)) score += 400 + normalizeKnowledgeQuery(example).length;
  }
  for (const tag of source.tags) {
    if (phraseMatches(query, tag)) score += 200 + normalizeKnowledgeQuery(tag).length;
  }
  const uniqueClaimKeywords = new Map();
  for (const claim of source.claims) {
    for (const keyword of claim.keywords ?? []) {
      uniqueClaimKeywords.set(normalizeKnowledgeQuery(keyword), keyword);
    }
  }
  for (const keyword of uniqueClaimKeywords.values()) {
    if (phraseMatches(query, keyword)) score += 120 + normalizeKnowledgeQuery(keyword).length;
  }
  return score;
}

function selectClaims(source, query) {
  const rows = source.claims.map((claim) => ({
    claim,
    source,
    claimScore: scoreClaim(claim, query),
  }));
  const maximum = Math.max(0, ...rows.map(({ claimScore }) => claimScore));
  if (maximum === 0) return rows;
  return rows.filter(({ claimScore }) => claimScore === maximum);
}

function hasAny(query, aliases) {
  return aliases.some((alias) => phraseMatches(query, alias));
}

function rankSources(corpus, query) {
  const selected = new Map();
  for (const { intent, score: intentScore } of matchedIntents(query)) {
    const candidates = corpus.sources
      .filter((source) => source.intentGroups.includes(intent))
      .map((source) => ({ source, specificity: sourceSpecificity(source, query) }));
    const maximum = Math.max(0, ...candidates.map(({ specificity }) => specificity));
    const gated = maximum > 0
      ? candidates.filter(({ specificity }) => specificity === maximum)
      : candidates;
    for (const { source, specificity } of gated) {
      const score = intentScore + specificity;
      const previous = selected.get(source.id);
      if (!previous || score > previous.score) selected.set(source.id, { source, score });
    }
  }

  const ranked = [...selected.values()]
    .sort((left, right) => right.score - left.score || left.source.id.localeCompare(right.source.id));
  const asksCurrentHours = hasAny(query, CURRENT_HOURS_ALIASES);
  const hasMainCanteen = ranked.some(({ source }) => source.id === 'hkbu.eo.dining.main-canteen');
  const hasDiningGuard = ranked.some(({ source }) => source.id === 'hkbu.eo.dining-overview');
  if (asksCurrentHours && hasMainCanteen && !hasDiningGuard) {
    const guard = corpus.sources.find((source) => source.id === 'hkbu.eo.dining-overview');
    if (guard) ranked.push({ source: guard, score: Math.max(1, (ranked[0]?.score ?? 2) - 1) });
  }
  return ranked.sort(
    (left, right) => right.score - left.score || left.source.id.localeCompare(right.source.id),
  );
}

function ambiguityFor(query, ranked, selectedClaims) {
  const codes = [];
  const relevantOfficialClaims = selectedClaims
    .map(({ claim }) => claim)
    .filter((claim) => claim.verificationStatus === 'official_verified');

  const hasLibrary = ranked.some(({ source }) => source.intentGroups.includes('library'));
  const libraryBranches = new Set(
    relevantOfficialClaims.map((claim) => claim.facts?.branch).filter(Boolean),
  );
  if (hasLibrary && (libraryBranches.size !== 1 || !hasAny(query, BRANCH_ALIASES))) {
    codes.push('LIBRARY_BRANCH_REQUIRED');
  }

  const residenceClaims = relevantOfficialClaims.filter((claim) => claim.facts?.residenceType);
  if (residenceClaims.length > 0) {
    const residenceTypes = new Set(residenceClaims.map((claim) => claim.facts.residenceType));
    const cohorts = new Set(residenceClaims.map((claim) => claim.facts.cohort));
    if (residenceTypes.size !== 1) codes.push('RESIDENCE_TYPE_REQUIRED');
    if (cohorts.size !== 1 || !hasAny(query, COHORT_ALIASES)) {
      codes.push('RESIDENCE_COHORT_REQUIRED');
    }
  }

  const collectionClaims = selectedClaims
    .filter(({ source }) => source.id === 'hkbu.ar.student-card-collection')
    .map(({ claim }) => claim);
  if (collectionClaims.length > 0) {
    const requiresAdmissionRoute = collectionClaims.some(
      (claim) => claim.facts?.requirements?.admissionRoute,
    );
    const requiresPhotoUploadRoute = collectionClaims.some(
      (claim) => claim.facts?.requirements?.photoUploadRoute,
    );
    if (requiresAdmissionRoute && !hasAny(query, STUDENT_ADMISSION_ALIASES)) {
      codes.push('STUDENT_CARD_ADMISSION_ROUTE_REQUIRED');
    }
    if (requiresPhotoUploadRoute && !hasAny(query, STUDENT_PHOTO_ROUTE_ALIASES)) {
      codes.push('STUDENT_CARD_PHOTO_UPLOAD_ROUTE_REQUIRED');
    }
  }

  const asksCurrentHours = hasAny(query, CURRENT_HOURS_ALIASES);
  const diningClaims = relevantOfficialClaims.filter((claim) => (
    claim.facts?.regularHoursOnly
    || claim.facts?.specialHoursOverrideRegular
    || claim.facts?.open === false
  ));
  const hasDefinitiveClosure = diningClaims.some(
    (claim) => claim.facts?.open === false && claim.facts?.until === 'further_notice',
  );
  if (asksCurrentHours && diningClaims.length > 0 && !hasDefinitiveClosure) {
    codes.push('CATERING_SPECIAL_HOURS_REQUIRED');
  }
  return [...new Set(codes)];
}

function isBlockedByClarification(claim, ambiguityCodes) {
  if (claim.sourceId === 'hkbu.ar.student-card-collection'
    && ambiguityCodes.some((code) => code.startsWith('STUDENT_CARD_'))) return true;
  if (claim.facts?.branch && ambiguityCodes.includes('LIBRARY_BRANCH_REQUIRED')) return true;
  if (claim.facts?.residenceType
    && ambiguityCodes.some((code) => code.startsWith('RESIDENCE_'))) return true;
  if (claim.facts?.regularHoursOnly
    && ambiguityCodes.includes('CATERING_SPECIAL_HOURS_REQUIRED')) return true;
  return false;
}

function conflictMetadataRows(ranked, selectedClaims) {
  const selectedIds = new Set(selectedClaims.map(({ claim }) => claim.id));
  const rows = [];
  for (const { source } of ranked) {
    for (const claim of source.claims) {
      if (selectedIds.has(claim.id)) continue;
      if (claim.verificationStatus === 'conflicted' && claim.facts?.mustNotPromote) {
        rows.push({ claim, source, claimScore: 0 });
      }
    }
  }
  return rows;
}

export function createRetriever({ corpus, now = () => new Date() }) {
  if (!corpus?.sources) throw new Error('a validated corpus is required');
  if (typeof now !== 'function') throw new Error('now must be an injected clock function');

  function retrieve(input) {
    const safety = routeSafety(input);
    if (safety.kind === 'emergency') {
      return {
        ...safety,
        topSourceId: 'hkbu.eo.security',
        claims: [],
        supportableClaims: [],
        staleClaims: [],
        evidenceIds: [],
        sources: [],
        needsClarification: false,
        ambiguityCodes: [],
      };
    }

    const query = normalizeKnowledgeQuery(input);
    const ranked = query ? rankSources(corpus, query) : [];
    const selectedClaims = ranked.flatMap(({ source }) => selectClaims(source, query));
    const ambiguityCodes = query ? ambiguityFor(query, ranked, selectedClaims) : ['QUERY_REQUIRED'];
    if (query && ranked.length === 0) ambiguityCodes.push('NO_MATCHING_OFFICIAL_EVIDENCE');

    const current = now();
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw new Error('injected clock returned an invalid instant');
    const claimRows = [];
    const sourceScores = new Map(ranked.map(({ source, score }) => [source.id, score]));
    const rowsWithMetadata = [
      ...selectedClaims,
      ...conflictMetadataRows(ranked, selectedClaims),
    ];
    for (const { claim, source, claimScore } of rowsWithMetadata) {
      if (isBlockedByClarification(claim, ambiguityCodes)) continue;
      claimRows.push({
        ...claim,
        status: evaluateClaimFreshness(claim, current),
        sourceTitle: source.title,
        canonicalUrl: source.canonicalUrl,
        _rank: (sourceScores.get(source.id) ?? 0) + claimScore,
      });
    }
    claimRows.sort((left, right) => right._rank - left._rank || left.id.localeCompare(right.id));
    const publicClaim = ({ _rank, ...claim }) => claim;
    const supportableClaims = claimRows.filter((claim) => claim.status === 'verified').map(publicClaim);
    const staleClaims = claimRows.filter((claim) => claim.status !== 'verified').map(publicClaim);
    const sources = ranked.map(({ source }) => ({
      id: source.id,
      title: source.title,
      publisher: source.publisher,
      canonicalUrl: source.canonicalUrl,
      risk: source.risk,
      verifiedAt: source.verifiedAt,
    }));

    return {
      kind: 'knowledge',
      query,
      topSourceId: ranked[0]?.source.id ?? null,
      claims: supportableClaims,
      supportableClaims,
      staleClaims,
      evidenceIds: supportableClaims.map((claim) => claim.id),
      sources,
      needsClarification: ambiguityCodes.length > 0,
      ambiguityCodes,
    };
  }

  return { retrieve };
}
