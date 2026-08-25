import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicUrl = new URL('../public/', import.meta.url);

async function text(name) {
  return readFile(new URL(name, publicUrl), 'utf8');
}

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('ui contract exposes one truthful mobile conversation and no legacy workspace', async () => {
  const html = await text('index.html');

  assert.equal((html.match(/<main\b/gi) ?? []).length, 1);
  assert.match(html, /<main[^>]+id="message-list"[^>]+aria-label="Conversation"/i);
  assert.doesNotMatch(html, /<main[^>]+role="log"/i);
  assert.match(html, /id="message-feed"[^>]+role="log"[^>]+aria-live="polite"[^>]+aria-atomic="false"/i);
  assert.match(html, /id="turn-status"[^>]+role="status"[^>]+aria-atomic="true"/i);
  assert.match(html, /Campus AI Senior/);
  assert.match(html, /AI assistant/);
  assert.match(html, /id="assistant-info"/);
  assert.match(html, /not a student or an official HKBU representative/i);
  assert.match(html, /id="clear-session"/);
  assert.match(html, /id="clear-status"[^>]+role="status"[^>]+aria-live="polite"/i);
  assert.match(html, /id="knowledge-snapshot-date"/i);
  assert.match(html, /id="message-template"/);
  assert.match(html, /id="source-template"/);
  assert.match(html, /id="action-card-template"/);
  assert.doesNotMatch(html, /MODE|SCENARIO|START MISSION|Free Talk|Teaching/i);
  assert.doesNotMatch(html, /\btyping\b|\bonline\b|\bseen\b|last active|read receipt/i);
});

test('ui contract keeps four starter questions and the composer after the timeline', async () => {
  const html = await text('index.html');
  const prompts = [...html.matchAll(/class="starter-prompt"/g)];
  const promptContracts = [...html.matchAll(/<button[^>]+class="starter-prompt"[^>]+data-prompt="([^"]+)"[^>]*>([^<]+)<\/button>/gi)];
  const timelineIndex = html.indexOf('id="message-list"');
  const statusIndex = html.indexOf('id="turn-status"');
  const composerIndex = html.indexOf('id="composer"');

  assert.equal(prompts.length, 4);
  assert.equal(promptContracts.length, 4);
  for (const [, sentText, visibleText] of promptContracts) {
    assert.equal(visibleText.trim().replace(/\s+/g, ' '), sentText.trim().replace(/\s+/g, ' '));
  }
  assert.ok(timelineIndex >= 0 && statusIndex > timelineIndex && composerIndex > statusIndex);
  assert.match(html, /id="message-input"[^>]+maxlength="4000"/i);
  assert.match(html, /id="voice-button"/i);
  assert.match(html, /id="send-button"[^>]+disabled/i);
});

test('ui contract preserves the exact source assets and serves an optimized avatar derivative', async () => {
  const html = await text('index.html');
  const wordmark = await readFile(new URL('assets/simplify-wordmark.svg', publicUrl));
  const avatar = await readFile(new URL('assets/ai-senior-avatar.png', publicUrl));
  const optimizedAvatar = await readFile(new URL('assets/ai-senior-avatar-128.png', publicUrl));

  assert.equal(wordmark.byteLength, 1033);
  assert.equal(createHash('sha256').update(wordmark).digest('hex'), '80b8c7a6b9368cfde4b41c776c48c7523d537350c28d300fd1f72736cbe5bb87');
  assert.equal(createHash('sha256').update(avatar).digest('hex'), '47ca07b1f03706e08640055d8c9975f7f4543c1686d051da5d209cd3455c05d0');
  assert.deepEqual(pngDimensions(avatar), { width: 1254, height: 1254 });
  assert.deepEqual(pngDimensions(optimizedAvatar), { width: 128, height: 128 });
  assert.ok(optimizedAvatar.byteLength < avatar.byteLength / 5);
  assert.match(html, /class="profile-avatar[^>]+src="\/assets\/ai-senior-avatar-128\.png"/i);
  assert.doesNotMatch(html, /class="profile-avatar[^>]+src="\/assets\/ai-senior-avatar\.png"/i);
  assert.match(html, /src="\/assets\/simplify-wordmark\.svg"/);
  assert.match(html, /aria-label="from Simplify"/);
  assert.match(html, /src="\/assets\/simplify-wordmark\.svg" alt="Simplify"/);
  assert.doesNotMatch(html, /ai-senior-avatar\.svg/);
});

test('ui contract locks the mobile-safe visual and accessibility fundamentals', async () => {
  const css = await text('styles.css');

  assert.match(css, /--canvas:\s*#f5f1ec/i);
  assert.match(css, /--ink:\s*#171816/i);
  assert.match(css, /--accent:\s*#2f6546/i);
  assert.match(css, /min-height:\s*100dvh/i);
  assert.match(css, /grid-template-rows:\s*calc\(56px \+ env\(safe-area-inset-top\)\)/i);
  assert.match(css, /height:\s*calc\(56px \+ env\(safe-area-inset-top\)\)/i);
  assert.match(css, /padding-top:\s*calc\(6px \+ env\(safe-area-inset-top\)\)/i);
  assert.match(css, /min-width:\s*44px/i);
  assert.match(css, /min-height:\s*44px/i);
  assert.match(css, /env\(safe-area-inset-bottom\)/i);
  assert.match(css, /env\(safe-area-inset-top\)/i);
  assert.match(css, /:focus-visible/i);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/i);
  assert.match(css, /overflow-x:\s*hidden/i);

  const retryRule = css.match(/\.retry-message\s*\{([^}]+)\}/i)?.[1] ?? '';
  assert.match(retryRule, /min-height:\s*44px/i);
  assert.doesNotMatch(retryRule, /min-height:\s*(?:3[0-9]|4[0-3])px/i);
  assert.match(css, /\.message-sources:empty,\s*\.message-actions:empty,\s*\.suggested-replies:empty\s*\{[^}]*display:\s*none/i);

  const canvas = css.match(/--canvas:\s*(#[a-f\d]{6})/i)?.[1];
  const subtle = css.match(/--ink-subtle:\s*(#[a-f\d]{6})/i)?.[1];
  assert.ok(contrastRatio(subtle, canvas) >= 4.5);
});

test('ui contract loads the canonical message client as an ES module', async () => {
  const html = await text('index.html');
  const app = await text('app.js');
  const controller = await text('chat-controller.js');

  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(app, /from ['"]\.\/chat-controller\.js['"]/);
  assert.match(app, /from ['"]\.\/message-renderer\.js['"]/);
  assert.match(app, /from ['"]\.\/timeline-view\.js['"]/);
  assert.match(app, /from ['"]\.\/chat-copy\.js['"]/);
  assert.doesNotMatch(app, /messageFeed\.replaceChildren/);
  assert.match(app, /knowledgeSnapshotDate/);
  assert.match(app, /clearStatus/);
  assert.match(controller, /new EventSourceImpl\(/);
  assert.match(controller, /full \? 0 : state\.lastMessageSequence/);
});

test('ui contract publishes a self-contained mobile web app manifest', async () => {
  const html = await text('index.html');
  const manifest = JSON.parse(await text('manifest.webmanifest'));

  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/assets\/ai-senior-avatar\.png"/);
  assert.deepEqual(manifest, {
    name: 'Hong Kong Buddy · Campus AI Senior',
    short_name: 'HK Buddy',
    description: 'A grounded AI senior for everyday HKBU questions.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f5f1ec',
    theme_color: '#f5f1ec',
    icons: [{
      src: '/assets/ai-senior-avatar.png',
      sizes: '1254x1254',
      type: 'image/png',
      purpose: 'any',
    }],
  });
});

test('ui contract syntax check covers every shipped client module', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const check = packageJson.scripts.check;

  assert.match(check, /node --check public\/app\.js/);
  assert.match(check, /node --check public\/chat-controller\.js/);
  assert.match(check, /node --check public\/chat-state\.js/);
  assert.match(check, /node --check public\/message-renderer\.js/);
  assert.match(check, /node --check public\/timeline-view\.js/);
  assert.match(check, /node --check public\/chat-copy\.js/);
  assert.match(check, /node --check public\/voice-transport\.js/);
  assert.match(check, /node --check public\/voice-upload-coordinator\.js/);
});
