import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../public/i18n/index.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.match(html, /id="visitInputCard"/, 'Translation workspace should keep input visible');
assert.match(html, /id="visitOutputCard"/, 'Translation workspace should render output in paired card');
assert.match(html, /id="visitRetryBtn"/, 'Translation workspace should expose retry action');
assert.match(app, /let\s+visitTranslationState\s*=/, 'visitTranslationState should track last request');
assert.match(app, /function\s+renderVisitInputCard\s*\(/, 'renderVisitInputCard should exist');
assert.match(app, /function\s+renderVisitError\s*\(/, 'renderVisitError should exist');
assert.match(app, /renderVisitInputCard\(text,\s*inputType,\s*direction\)/, 'translateVisitText should render input before request');
assert.match(app, /renderVisitError\(err,\s*text\)/, 'translateVisitText should render failed request state');
assert.match(css, /\.visit-pair-grid\b/, 'paired translation grid styling should exist');
assert.match(css, /\.visit-result-state-error\b/, 'error result styling should exist');
assert.match(css, /\.visit-result-state-fallback\b/, 'fallback result styling should exist');
assert.match(i18n, /retryTranslation:/, 'retry copy should exist');
assert.equal(pkg.scripts['test:v2-translation'], 'node scripts/test-v2-translation-contract.js');

console.log('V2 translation contract passed');
