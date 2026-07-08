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
const translateViewIndex = html.indexOf('id="translateView"');
const visitTranslatePanelIndex = html.indexOf('id="visitTranslatePanel"');
const practiceViewIndex = html.indexOf('id="practiceView"');
const roleVisitEntryBlock = app.match(/if\s*\(action\s*===\s*'startVisitTranslation'\)\s*{[\s\S]*?return;\s*}/)?.[0] || '';
const pilotVisitEntryBlock = app.match(/if\s*\(action\s*===\s*'visit'\)\s*{[\s\S]*?return;\s*}/)?.[0] || '';
const playbookVisitEntryBlock =
  app.match(/startVisitTranslationFromPlaybook\?\.addEventListener\('click',\s*\(\)\s*=>\s*{[\s\S]*?}\);/)?.[0] || '';
const appViewSections = [...html.matchAll(/<section\b[^>]*\bclass="[^"]*\bapp-view\b[^"]*"[^>]*>/g)].map((match) => match[0]);

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
assert.ok(appViewSections.length > 0, 'V2 app shell should declare app-view sections');
for (const sectionTag of appViewSections) {
  const viewNames = sectionTag.match(/\bdata-app-view="([^"]+)"/)?.[1].split(/\s+/).filter(Boolean) || [];
  const sectionName = sectionTag.match(/\bid="([^"]+)"/)?.[1] || sectionTag.match(/\bdata-app-view="([^"]+)"/)?.[1] || sectionTag;
  if (viewNames.includes('today')) {
    assert.doesNotMatch(sectionTag, /\shidden(?:\s|>|=)/, `${sectionName} should be visible in the static Today-first shell`);
  } else {
    assert.match(sectionTag, /\shidden(?:\s|>|=)/, `${sectionName} should be hidden before JS selects a non-default view`);
  }
}
assert.notEqual(translateViewIndex, -1, 'Translate workspace should exist');
assert.notEqual(visitTranslatePanelIndex, -1, 'Visit translation panel should exist');
assert.notEqual(practiceViewIndex, -1, 'Practice workspace should exist');
assert.ok(
  translateViewIndex < visitTranslatePanelIndex && visitTranslatePanelIndex < practiceViewIndex,
  'Visit translation panel should live inside the Translate workspace before Practice markup'
);
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
assert.ok(roleVisitEntryBlock, 'Role-action visit entry block should exist');
assert.match(
  roleVisitEntryBlock,
  /setAppView\('translate'\)/,
  'Role-action visit entry should route to the Translate workspace'
);
assert.match(
  roleVisitEntryBlock,
  /document\.getElementById\('visitTranslatePanel'\)\?\.scrollIntoView/,
  'Role-action visit entry should scroll to the live visit translation console'
);
assert.doesNotMatch(
  roleVisitEntryBlock,
  /setAppView\('practice'\)/,
  'Role-action visit entry should not be forced back through Practice'
);
assert.ok(pilotVisitEntryBlock, 'Pilot visit entry block should exist');
assert.match(
  pilotVisitEntryBlock,
  /setAppView\('translate'\)/,
  'Pilot visit entry should route to the Translate workspace'
);
assert.match(
  pilotVisitEntryBlock,
  /document\.getElementById\('visitTranslatePanel'\)\?\.scrollIntoView/,
  'Pilot visit entry should scroll to the live visit translation console'
);
assert.doesNotMatch(
  pilotVisitEntryBlock,
  /setAppView\('practice'\)/,
  'Pilot visit entry should not be forced back through Practice'
);
assert.ok(playbookVisitEntryBlock, 'Playbook visit entry block should exist');
assert.match(
  playbookVisitEntryBlock,
  /setAppView\('translate'\)/,
  'Playbook visit entry should route to the Translate workspace'
);
assert.match(
  playbookVisitEntryBlock,
  /document\.getElementById\('visitTranslatePanel'\)\?\.scrollIntoView/,
  'Playbook visit entry should scroll to the live visit translation console'
);
assert.doesNotMatch(
  playbookVisitEntryBlock,
  /setAppView\('practice'\)/,
  'Playbook visit entry should not be forced back through Practice'
);
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
