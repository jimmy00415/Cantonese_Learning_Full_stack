import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

const expectedAssetVersion = '20260709dock1';

assert.match(indexHtml, new RegExp(`styles\\.css\\?v=${expectedAssetVersion}`));
assert.match(indexHtml, new RegExp(`app\\.js\\?v=${expectedAssetVersion}`));
assert.match(indexHtml, /rel="icon"[^>]+data:image\/svg\+xml/, 'Page should provide an inline favicon to avoid browser 404 console noise');
assert.match(appJs, new RegExp(`\\.\\/i18n\\/index\\.js\\?v=${expectedAssetVersion}`));

assert.match(appJs, /isGenericVisitTranslationText/);
assert.match(appJs, /classList\.toggle\('is-fallback', fallbackResult\)/);
assert.match(appJs, /res\.autoRouted/);
assert.match(appJs, /syncVisitDirectionControls\(res\.direction\)/);
assert.match(appJs, /visit-route-note/);
assert.match(appJs, /visitTranslate\.autoRouted/);
assert.match(appJs, /window\.location\.port\s*===\s*'5173'/, 'Only the Vite dev server should redirect API calls to the backend dev port');
assert.match(appJs, /\$\{window\.location\.origin\}\/api/, 'Backend-served local and Azure pages should use same-origin API calls');
assert.doesNotMatch(appJs, /window\.location\.hostname\s*===\s*'localhost'\s*\?[^:]+:4000\/api/s, 'localhost backend pages should not be forced to port 4000');
assert.match(stylesCss, /\.visit-translation-output\.is-fallback/);
assert.match(stylesCss, /\.visit-large-text\.is-fallback/);
assert.match(stylesCss, /\.visit-route-note/);
assert.match(stylesCss, /body\[data-user-mode="visit_translation"\]\s+\.input-panel/);
assert.match(stylesCss, /grid-template-columns:[^;]*minmax\(0,\s*1fr\)/);

const translateViewMatches = [...indexHtml.matchAll(/<section\b[^>]*class="[^"]*\bapp-view\b[^"]*"[^>]*data-app-view="([^"]*)"[^>]*>/g)]
  .filter((match) => match[1].split(/\s+/).includes('translate'));
const translateViewTags = translateViewMatches.map((match) => match[0]);
assert.equal(
  translateViewTags.length,
  1,
  `Only the self-contained V2 translator should be tagged as the translate app view: ${translateViewTags.join('\n')}`
);
assert.match(translateViewTags[0], /id="translateView"/, 'The translate app view should be #translateView');
assert.doesNotMatch(indexHtml, /id="practiceInputDock"[^>]*data-app-view="[^"]*\btranslate\b/, 'Practice input dock should not render in the translate workspace');
assert.match(indexHtml, /id="visitTextInput"/, 'Translate workspace should own a dedicated text input');
assert.match(indexHtml, /class="[^"]*\bvisit-entry-bar\b/, 'Translate workspace should own an inline entry bar');
assert.match(appJs, /visitTextInput/, 'Translate JS should wire the dedicated visit text input');
assert.doesNotMatch(appJs, /roleContextPanel\.hidden\s*=\s*currentAppView\s*!==\s*'translate'/, 'Legacy role context panel should not be unhidden inside the V2 translate workspace');
assert.doesNotMatch(
  appJs,
  /\[sendBtn,\s*newSessionBtn,\s*scenarioSelect,\s*textInput,\s*visitTextInput,\s*visitTranslateBtn\]\.forEach/,
  'Text fallback in the translate workspace should not be disabled by global voice/session control gating'
);
assert.match(stylesCss, /\.visit-entry-bar\b/, 'Translate entry bar styling should exist');

console.log('visit layout and asset cache contract passed');
