import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

assert.match(html, /id="audioControlDock"/, 'audio controls should be grouped in a named dock');
assert.match(app, /const\s+VOICE_UI_STATES\s*=\s*{/, 'VOICE_UI_STATES should exist');
assert.match(app, /function\s+setVoiceUiState\s*\(/, 'setVoiceUiState should exist');
assert.match(app, /function\s+updateReplayAvailability\s*\(/, 'updateReplayAvailability should exist');
assert.match(app, /setVoiceUiState\('unavailable'\)/, 'unavailable state should be set explicitly');
assert.match(app, /setVoiceUiState\('recording'\)/, 'recording state should be set explicitly');
assert.match(app, /setVoiceUiState\('processing'\)/, 'processing state should be set explicitly');
assert.match(app, /replayBtn\.disabled\s*=\s*!lastTtsAudio/, 'replay should be disabled without audio');
assert.match(css, /\.audio-control-dock\b/, 'audio dock styling should exist');
assert.match(css, /\.voice-state-unavailable\b/, 'unavailable voice state styling should exist');
assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'mobile-safe grid sizing should exist');
assert.equal(pkg.scripts['test:v2-voice-audio'], 'node scripts/test-v2-voice-audio-contract.js');

console.log('V2 voice/audio contract passed');
