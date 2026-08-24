const FIXED_CONTACTS = Object.freeze([
  Object.freeze({ label: 'Emergency services', phone: '999' }),
  Object.freeze({ label: 'HKBU Security', phone: '3411 7777' }),
]);

function normalize(value) {
  return String(value ?? '')
    .slice(0, 8192)
    .normalize('NFKC')
    .replace(/[\p{Cf}\u180E]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(value, expressions) {
  return expressions.some((expression) => expression.test(value));
}

function emergency(category) {
  return {
    kind: 'emergency',
    category,
    bypassRetrieval: true,
    contacts: FIXED_CONTACTS.map((contact) => ({ ...contact })),
    guidance: {
      en: 'If there is immediate danger, call 999 now. Contact HKBU Security at 3411 7777 when it is safe to do so.',
      zhHant: '如有即時危險，請立即致電 999；在安全情況下再聯絡浸大保安 3411 7777。',
      zhHans: '如有即时危险，请立即致电 999；在安全情况下再联系浸大保安 3411 7777。',
    },
  };
}

export function routeSafety(input) {
  const value = normalize(input);
  if (!value) return { kind: 'normal', bypassRetrieval: false };

  const injury = includesAny(value, [
    /\b(?:badly|seriously|severely) injured\b/,
    /\bbleeding (?:heavily|badly|a lot)\b/,
    /(?:流好多血|流很多血|大量出血|嚴重出血|严重出血|血流不止)/,
    /\bunconscious (?:person|student|someone)\b/,
    /\b(?:someone|my (?:friend|roommate)|a student) is unconscious and not breathing\b/,
    /(?:受傷|受伤).*(?:流好多血|流很多血|大量出血|昏迷)/,
    /(?:流好多血|流很多血|大量出血).*(?:受傷|受伤|有人)/,
  ]);
  if (injury) return emergency('injury');

  const fireNearMiss = includesAny(value, [
    /\bfire\s*wall\b/, /\bfire drill\b/, /\bfire safety (?:class|workshop|training)\b/,
    /(?:火警|火災|火灾).*(?:演習|演习)/, /(?:演習|演习).*(?:火警|火災|火灾)/,
  ]);
  const explicitFire = includesAny(value, [
    /\b(?:building|room|hostel|hall|kitchen|campus) is on fire\b/,
    /\bthere(?:'s| is) (?:a )?fire (?:now|right now|in )/,
    /(?:而家|現在|现在).*(?:火警|着火|著火|火災|火灾)/,
    /(?:宿舍|大樓|大楼|房間|房间|校園|校园).*(?:火警|着火|著火|火災|火灾)/,
  ]);
  const unambiguousFire = /\bon fire\b|着火|著火/.test(value);
  if (explicitFire && (!fireNearMiss || unambiguousFire || /not (?:a )?drill/.test(value))) return emergency('fire');

  const selfHarm = includesAny(value, [
    /\b(?:i(?: am)?|i'm|my friend is|someone is) (?:will|going to|trying to|about to|planning to) (?:kill (?:myself|himself|herself|themself)|end (?:my|his|her|their) life)\b/,
    /\b(?:i want to kill myself|my (?:friend|roommate) wants to kill (?:himself|herself|themself))(?: right)? now\b/,
    /(?:我|我朋友|有人|佢|他|她|室友|同學|同学).*(?:而家|現在|现在|即刻|立即).*(?:自殺|自杀|結束生命|结束生命)/,
    /(?:我|我朋友|有人|佢|他|她|室友|同學|同学).*(?:想|要|準備|准备).*(?:自殺|自杀|結束生命|结束生命)/,
    /\b(?:i|my friend|a friend|my roommate|someone|he|she|they).{0,50}(?:want(?:s)? to die|do(?:es)? not want to live|doesn't want to live|don't want to live|cannot go on living)\b/,
    /(?:我|朋友|我朋友|我嘅朋友|我的朋友|有人|佢|他|她|室友|同學|同学).{0,40}(?:想死|想去死|唔想活|唔想再活|不想活(?:了|下去)?|不想再活|活不下去)/,
  ]);
  if (selfHarm) return emergency('self_harm');

  const violence = includesAny(value, [
    /\b(?:someone|a person|a student).*(?:knife|gun).*(?:attacking|stabbing|shooting|threatening)\b/,
    /\b(?:attack|stabbing|shooting) (?:people|someone|students) (?:now|right now)\b/,
    /有人.*(?:持刀|持槍|持枪).*(?:傷人|伤人|襲擊|袭击|攻擊|攻击)/,
    /(?:有人|佢|他|她|朋友|同學|同学).{0,30}(?:拎刀|拿刀|持刀|揸刀|有刀).{0,30}(?:斬人|斩人|砍人|傷人|伤人|襲擊|袭击|攻擊|攻击|殺人|杀人)/,
    /(?:正在|而家|现在).*(?:打人|傷人|伤人|襲擊|袭击|攻擊|攻击)/,
  ]);
  if (violence) return emergency('violence');

  return { kind: 'normal', bypassRetrieval: false };
}
