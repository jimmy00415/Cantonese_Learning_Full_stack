import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const i18n = readFileSync(join(__dirname, '..', 'public', 'i18n', 'index.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

for (const id of ['todayView', 'practiceView', 'translateView', 'phrasebookView', 'privacyView']) {
  assert.match(html, new RegExp(`id="${id}"`), `${id} should exist in V2 app shell`);
}

for (const view of ['today', 'practice', 'translate', 'phrasebook', 'privacy']) {
  assert.match(html, new RegExp(`data-app-view-target="${view}"`), `${view} nav target should exist`);
}

assert.match(html, /data-default-view="today"/, 'app shell should default to Today');
assert.match(html, /id="todayQuickStart"/, 'Today view should expose a quick-start action');
assert.match(html, /id="todayHabitState"/, 'Today view should expose habit state');
assert.match(html, /id="todayVoiceState"/, 'Today view should expose voice readiness');
assert.match(
  html,
  /<a class="action-card primary-action"[^>]*data-app-view-target="practice"[\s\S]*?href="#practice"[\s\S]*?Start practice<\/strong>/,
  'Translate CTA should switch to the practice app view before jumping to #practice'
);
assert.match(app, /const\s+V2_HABIT_STORAGE_KEY\s*=\s*['"]hkbuddy\.v2\.habitState['"]/, 'habit storage key should be explicit');
assert.match(app, /function\s+setAppView\s*\(/, 'setAppView should control top-level V2 navigation');
assert.match(app, /function\s+getHabitState\s*\(/, 'getHabitState should read local habit state');
assert.match(app, /function\s+saveHabitState\s*\(/, 'saveHabitState should persist local habit state');
assert.match(app, /function\s+renderTodayView\s*\(/, 'renderTodayView should update Today cards');
assert.match(app, /function\s+getTodayKey\s*\(/, 'getTodayKey should exist');
assert.match(app, /getFullYear\(\)/, 'getTodayKey should use the local calendar year');
assert.match(app, /getMonth\(\)\s*\+\s*1/, 'getTodayKey should use the local calendar month');
assert.match(app, /getDate\(\)/, 'getTodayKey should use the local calendar day');
assert.doesNotMatch(app, /function\s+getTodayKey\s*\([^)]*\)\s*{[\s\S]*?toISOString\(\)\.slice\(0,\s*10\)/, 'getTodayKey should not derive the day key from UTC');
assert.match(css, /\.v2-shell\b/, 'V2 shell styling should exist');
assert.match(css, /\.today-dashboard\b/, 'Today dashboard styling should exist');
assert.match(css, /@media\s*\(max-width:\s*980px\)/, 'responsive breakpoint should be present');
assert.match(i18n, /v2:\s*{/, 'V2 i18n namespace should exist');
assert.match(i18n, /today:\s*{/, 'Today copy should exist in i18n');
assert.equal(pkg.scripts['test:v2-shell'], 'node scripts/test-v2-shell-contract.js');

console.log('V2 shell contract passed');
