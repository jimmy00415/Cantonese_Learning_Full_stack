import { spawnSync } from 'node:child_process';

const commands = [
  ['node', ['scripts/test-v2-shell-contract.js']],
  ['node', ['scripts/test-v2-practice-contract.js']],
  ['node', ['scripts/test-v2-translation-contract.js']],
  ['node', ['scripts/test-v2-voice-audio-contract.js']],
  ['node', ['scripts/test-v2-phrasebook-review-contract.js']],
  ['node', ['scripts/test-visit-direction-routing.js']],
  ['node', ['scripts/test-visit-translation-quality.js']],
  ['node', ['scripts/test-visit-layout-contract.js']],
  ['node', ['scripts/test-voice-disabled-ui.js']],
  ['node', ['--check', 'server.js']],
  ['node', ['--check', 'public/app.js']],
  ['node', ['--check', 'public/i18n/index.js']],
  ['node', ['--check', 'public/errors.js']]
];

for (const [command, args] of commands) {
  const label = `${command} ${args.join(' ')}`;
  const result = spawnSync(command, args, {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) {
    throw new Error(`Regression command failed: ${label}`);
  }
}

console.log('V2 regression suite passed');
