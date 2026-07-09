import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const markup = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
const styles = readFileSync(join(__dirname, '..', 'public', 'styles.css'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} should exist`);

  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const initialVoiceState = source.match(/let\s+voiceInputEnabled\s*=\s*(true|false)\s*;/);
assert.equal(initialVoiceState?.[1], 'false', 'voice input should default to disabled until /health confirms ASR is ready');

assert.match(
  markup,
  /<button\s+id="holdToSpeak"[^>]*\sdisabled(?:\s|>)/,
  'hold-to-speak button should be disabled before /health confirms ASR is ready'
);
assert.match(
  markup,
  /styles\.css\?v=20260709dock1/,
  'stylesheet cache-bust should change when unavailable voice styling changes'
);
assert.match(
  source,
  /\.\/errors\.js\?v=20260709dock1/,
  'voice availability helper import should be cache-busted with the V2 asset version'
);
assert.doesNotMatch(
  source,
  /holdBtn\.disabled\s*=\s*false/,
  'request completion should not bypass voiceInputEnabled by directly re-enabling hold-to-speak'
);

const handleRecordStart = extractFunction('handleRecordStart');
const guardIndex = handleRecordStart.indexOf('if (!voiceInputEnabled)');
const permissionIndex = handleRecordStart.indexOf('requestMicPermission');

assert.ok(guardIndex !== -1, 'handleRecordStart should guard when voice input is unavailable');
assert.ok(guardIndex < permissionIndex, 'voice unavailable guard should run before requesting microphone permission');
assert.match(handleRecordStart, /setNotice\(t\('input\.voiceUnavailableHint'\), 'warning'\)/, 'guard should show the text-only pilot hint');
assert.match(handleRecordStart, /cleanupRecordingResources\(\);/, 'guard should clear any stale recorder resources');

const visitMicRuleIndex = styles.indexOf('body[data-user-mode="visit_translation"] .mic');
const unavailableRuleIndex = styles.indexOf('body[data-user-mode="visit_translation"] .mic.is-unavailable');
assert.ok(visitMicRuleIndex !== -1, 'visit translation mic style should exist');
assert.ok(unavailableRuleIndex !== -1, 'visit translation unavailable mic style should exist');
assert.ok(
  unavailableRuleIndex > visitMicRuleIndex,
  'unavailable mic style should come after the visit translation primary mic style'
);

const unavailableRule = styles.slice(unavailableRuleIndex, styles.indexOf('}', unavailableRuleIndex) + 1);
assert.match(unavailableRule, /background:\s*#[a-f0-9]{3,6}|background:\s*rgb|background:\s*var\(/i, 'unavailable mic should define its own background');
assert.doesNotMatch(unavailableRule, /background:\s*#111827/i, 'unavailable mic should not keep the active dark background');
assert.match(unavailableRule, /cursor:\s*not-allowed/i, 'unavailable mic should show disabled cursor');
assert.match(unavailableRule, /pointer-events:\s*none/i, 'unavailable mic should not accept pointer events');

console.log('voice disabled UI contract passed');
