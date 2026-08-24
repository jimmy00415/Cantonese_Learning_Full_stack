import { evaluateClaimFreshness } from './corpus.js';
import { routeSafety } from './safety.js';

const INTENT_ALIASES = Object.freeze({
  student_card: ['student card', 'student e card', 'ecard', 'e card', '學生證', '学生证', '學生卡', '学生卡', '校卡', '補領學生證', '补领学生证'],
  account_password: ['ssoid', 'account password', 'forgot password', 'reset password', '帳戶密碼', '账户密码', '忘記密碼', '忘记密码', '學生帳戶', '学生账户'],
  duo: ['duo', 'mfa', 'multi factor authentication', 'two factor authentication', '雙重認證', '双重认证', '兩步驗證', '两步验证', '換咗電話', '换了手机'],
  it_help: ['ito', 'it help', 'it support', 'service call centre', '電腦支援', '电脑支援', '技術支援', '技术支持', 'rrs303'],
  residence_check_in: ['residence check in', 'residence hall', 'student residence', 'village care', 'hostel check in', '宿舍', '入住', '入宿', 'check in'],
  campus_ar_navigation: ['campus map', 'academic registry', 'ar office', 'sce tower', 'jc3', 'jockey club campus of creativity', '校園地圖', '校园地图', '教務處', '教务处', '學術註冊處', '学术注册处'],
  library: ['library', 'main library', 'chinese medicine library', 'shek mun campus library', 'cml', 'smcl', '圖書館', '图书馆', '書館', '书馆'],
  dining: ['canteen', 'catering', 'restaurant', 'food', 'bu fiesta', 'main canteen', '飯堂', '饭堂', '餐廳', '餐厅', '食堂', '食嘢', '吃饭'],
  medical: ['health centre', 'health center', 'medical', 'doctor', 'dental', 'clinic', '健康中心', '醫療', '医疗', '睇醫生', '看医生', '牙科'],
  osa_counselling: ['office of student affairs', 'osa', 'student affairs', 'counselling', 'counseling', 'cdc', '學生事務處', '学生事务处', '輔導', '辅导', '心理諮詢', '心理咨询'],
  transport: ['transport', 'mtr', 'minibus', 'bus', 'kowloon tong station', '交通', '港鐵', '港铁', '地鐵', '地铁', '小巴', '巴士'],
  emergency: ['emergency contacts', 'hkbu security', 'security hotline', '保安', '緊急聯絡', '紧急联络'],
});

const BRANCH_ALIASES = ['main library', '主圖書館', '主图书馆', 'fong shu chuen library', 'cml', 'chinese medicine library', '中醫藥圖書館', '中医药图书馆', 'smcl', 'shek mun', '石門', '石门'];
const COHORT_ALIASES = ['non local freshman', 'non local freshmen', 'non-local freshman', 'local freshman', 'local freshmen', 'exchange student', 'returning student', 'research postgraduate', 'rpg', '非本地新生', '本地新生', '交換生', '交换生', '研究生', '舊生', '旧生'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeKnowledgeQuery(value) {
  return String(value ?? '')
    .slice(0, 8192)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
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

function tokens(value) {
  return new Set(value.match(/[a-z0-9]+|\p{Script=Han}+/gu) ?? []);
}

function scoreSource(source, query) {
  let score = 0;
  for (const intent of source.intentGroups) {
    for (const alias of INTENT_ALIASES[intent] ?? []) {
      if (phraseMatches(query, alias)) score = Math.max(score, 1_000 + normalizeKnowledgeQuery(alias).length);
    }
  }
  for (const example of source.exampleQuestions) {
    if (phraseMatches(query, example)) score = Math.max(score, 800 + normalizeKnowledgeQuery(example).length);
  }
  for (const tag of source.tags) {
    if (phraseMatches(query, tag)) score += 100;
  }
  if (phraseMatches(query, source.title)) score += 300;
  const queryTokens = tokens(query);
  const sourceTokens = tokens(normalizeKnowledgeQuery([source.title, ...source.tags].join(' ')));
  for (const token of queryTokens) if (sourceTokens.has(token)) score += 5;
  return score;
}

function scoreClaim(claim, query) {
  let score = 0;
  for (const keyword of claim.keywords ?? []) {
    if (phraseMatches(query, keyword)) score += 100 + normalizeKnowledgeQuery(keyword).length;
  }
  for (const text of Object.values(claim.text)) {
    const normalized = normalizeKnowledgeQuery(text);
    for (const token of tokens(query)) if (tokens(normalized).has(token)) score += 1;
  }
  return score;
}

function hasAny(query, aliases) {
  return aliases.some((alias) => phraseMatches(query, alias));
}

function ambiguityFor(query, ranked) {
  const codes = [];
  const top = ranked[0]?.source;
  if (top?.intentGroups.includes('library') && !hasAny(query, BRANCH_ALIASES)) {
    codes.push('LIBRARY_BRANCH_REQUIRED');
  }
  if (top?.intentGroups.includes('residence_check_in') && !hasAny(query, COHORT_ALIASES)) {
    codes.push('RESIDENCE_COHORT_REQUIRED');
  }
  const asksCurrentHours = hasAny(query, ['today', 'now', '今日', '今天', '而家', '現在', '现在', '幾點', '几点']);
  if (top?.intentGroups.includes('dining') && top.id !== 'hkbu.eo.dining.bu-fiesta' && asksCurrentHours) {
    codes.push('CATERING_SPECIAL_HOURS_REQUIRED');
  }
  return codes;
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
    const ranked = corpus.sources
      .map((source) => ({ source, score: scoreSource(source, query) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.source.id.localeCompare(right.source.id))
      .slice(0, 3);
    const ambiguityCodes = query ? ambiguityFor(query, ranked) : ['QUERY_REQUIRED'];
    if (query && ranked.length === 0) ambiguityCodes.push('NO_MATCHING_OFFICIAL_EVIDENCE');

    const current = now();
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw new Error('injected clock returned an invalid instant');
    const claimRows = [];
    for (const { source, score: sourceScore } of ranked) {
      const scoredClaims = source.claims.map((claim) => ({ claim, claimScore: scoreClaim(claim, query) }));
      const anySpecific = scoredClaims.some(({ claimScore }) => claimScore > 0);
      for (const { claim, claimScore } of scoredClaims) {
        if (anySpecific && claimScore === 0) continue;
        claimRows.push({
          ...claim,
          status: evaluateClaimFreshness(claim, current),
          sourceTitle: source.title,
          canonicalUrl: source.canonicalUrl,
          _rank: sourceScore + claimScore,
        });
      }
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
