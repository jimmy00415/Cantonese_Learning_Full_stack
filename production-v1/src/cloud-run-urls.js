const SERVICE = /^[a-z][a-z0-9-]{0,62}$/u;
const PROJECT_NUMBER = /^[1-9]\d{5,29}$/u;
const REGION = /^[a-z][a-z0-9-]{0,62}$/u;
const TAG = /^[a-z][a-z0-9-]{0,62}$/u;

function invalid() {
  throw new Error('Cloud Run URL readback is invalid');
}

function exactOrigin(value) {
  if (typeof value !== 'string' || value.length > 512) invalid();
  let parsed;
  try { parsed = new URL(value); } catch { invalid(); }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
    || parsed.port !== '' || parsed.pathname !== '/' || parsed.search !== ''
    || parsed.hash !== '' || parsed.origin !== value) invalid();
  return parsed;
}

function expectedServiceOrigin({ service, projectNumber, region }) {
  if (!SERVICE.test(String(service ?? '')) || !PROJECT_NUMBER.test(String(projectNumber ?? ''))
    || !REGION.test(String(region ?? ''))) invalid();
  return `https://${service}-${projectNumber}.${region}.run.app`;
}

function validateServiceOrigin(value, identity) {
  const expected = expectedServiceOrigin(identity);
  const parsed = exactOrigin(value);
  if (value === expected) return value;
  // Cloud Run documents SERVICE_IDENTIFIER as opaque. Bind alternate origins
  // relationally to the authoritative Service readback; never parse that
  // identifier or assume its current shape.
  if (!parsed.hostname.endsWith('.run.app')) invalid();
  return value;
}

export function normalizeCloudRunServiceUrlAliases(value, identity) {
  const expected = expectedServiceOrigin(identity);
  const aliases = value === undefined ? [expected] : value;
  if (!Array.isArray(aliases) || aliases.length < 1 || aliases.length > 2
    || aliases.some((member) => typeof member !== 'string')
    || new Set(aliases).size !== aliases.length) invalid();
  const normalized = aliases.map((member) => validateServiceOrigin(member, identity)).sort();
  if (!normalized.includes(expected)) invalid();
  return Object.freeze(normalized);
}

export function normalizeCloudRunV1ServiceUrls(value, identity) {
  const rawAnnotation = value?.metadata?.annotations?.['run.googleapis.com/urls'];
  const primary = value?.status?.url;
  const addressRecord = value?.status?.address;
  if (addressRecord === null || typeof addressRecord !== 'object' || Array.isArray(addressRecord)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(addressRecord))
    || Object.keys(addressRecord).length !== 1
    || !Object.hasOwn(addressRecord, 'url')) invalid();
  const address = addressRecord.url;
  if (typeof rawAnnotation !== 'string') invalid();
  let declared;
  try { declared = JSON.parse(rawAnnotation); } catch { invalid(); }
  const aliases = normalizeCloudRunServiceUrlAliases(declared, identity);
  if (typeof primary !== 'string' || address !== primary || !aliases.includes(primary)) invalid();
  return Object.freeze({ aliases, primary });
}

export function cloudRunTaggedUrl(tag, serviceUrl) {
  if (!TAG.test(String(tag ?? ''))) invalid();
  const parsed = exactOrigin(serviceUrl);
  return `https://${tag}---${parsed.hostname}`;
}
