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

assert.match(html, /id="practiceTaskCard"/, 'Practice should show the current task card');
assert.match(html, /id="practiceCoachPanel"/, 'Practice should show coach notes panel');
assert.match(html, /id="practiceInputDock"/, 'Practice input dock should wrap input and audio controls');
assert.match(html, /data-practice-mode="habit"/, 'Practice should expose a habit-first mode');
assert.match(app, /function\s+startPracticeFromToday\s*\(/, 'startPracticeFromToday should exist');
assert.match(app, /function\s+markHabitPractised\s*\(/, 'markHabitPractised should exist');
assert.match(app, /function\s+renderPracticeOutcomeMode\s*\(/, 'practice mode rendering helper should exist');
assert.match(app, /function\s+updatePracticeCoachSummary\s*\(/, 'practice coach summary helper should exist');
assert.match(app, /renderImmediateFeedback[\s\S]*updatePracticeCoachSummary\(/, 'practice coach summary should be updated from the feedback rendering path');
assert.doesNotMatch(app, /scenarioPill\.textContent\s*=\s*label/, 'practice mode rendering should not overwrite the scenario pill with mode text');
assert.match(app, /markHabitPractised\(\)/, 'successful user exchange should mark habit practised');
assert.match(css, /\.practice-workspace-grid\b/, 'practice workspace grid styling should exist');
assert.match(css, /\.practice-input-dock\b/, 'practice input dock styling should exist');
assert.match(i18n, /practice:\s*{/, 'V2 practice copy should exist');
assert.equal(pkg.scripts['test:v2-practice'], 'node scripts/test-v2-practice-contract.js');

console.log('V2 practice contract passed');
