import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

assert.ok(
  app.length > 50000 && html.length > 20000 && css.length > 40000,
  'V2 frontend assets should not be empty or accidentally replaced by a stub'
);
assert.match(html, /id="phrasebookList"/, 'Phrasebook view should have a list mount');
assert.match(html, /id="habitReviewPanel"/, 'Today or practice should expose habit review');
assert.match(app, /function\s+usePhraseForPractice\s*\(/, 'usePhraseForPractice should exist');
assert.match(app, /function\s+usePhraseForTranslation\s*\(/, 'usePhraseForTranslation should exist');
assert.match(app, /function\s+renderHabitReview\s*\(/, 'renderHabitReview should exist');
assert.match(app, /data-phrase-action/, 'phrase actions should be explicit');
assert.match(app, /visitTextInput/, 'Phrase translation should target the dedicated visit translation input');
assert.match(css, /\.phrasebook-grid\b/, 'phrasebook grid styling should exist');
assert.match(css, /\.habit-review-panel\b/, 'habit review styling should exist');
assert.equal(pkg.scripts['test:v2-phrasebook-review'], 'node scripts/test-v2-phrasebook-review-contract.js');

console.log('V2 phrasebook/review contract passed');
