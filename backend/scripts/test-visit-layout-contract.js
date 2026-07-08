import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

const expectedAssetVersion = '20260708v2uiux1';

assert.match(indexHtml, new RegExp(`styles\\.css\\?v=${expectedAssetVersion}`));
assert.match(indexHtml, new RegExp(`app\\.js\\?v=${expectedAssetVersion}`));
assert.match(appJs, new RegExp(`\\.\\/i18n\\/index\\.js\\?v=${expectedAssetVersion}`));

assert.match(appJs, /isGenericVisitTranslationText/);
assert.match(appJs, /classList\.toggle\('is-fallback', fallbackResult\)/);
assert.match(appJs, /res\.autoRouted/);
assert.match(appJs, /syncVisitDirectionControls\(res\.direction\)/);
assert.match(appJs, /visit-route-note/);
assert.match(appJs, /visitTranslate\.autoRouted/);
assert.match(stylesCss, /\.visit-translation-output\.is-fallback/);
assert.match(stylesCss, /\.visit-large-text\.is-fallback/);
assert.match(stylesCss, /\.visit-route-note/);
assert.match(stylesCss, /body\[data-user-mode="visit_translation"\]\s+\.input-panel/);
assert.match(stylesCss, /grid-template-columns:[^;]*minmax\(0,\s*1fr\)/);

console.log('visit layout and asset cache contract passed');
