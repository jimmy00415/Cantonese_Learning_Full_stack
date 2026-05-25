const { copyFileSync, existsSync, mkdirSync, readFileSync } = require('fs');
const { dirname, join } = require('path');

const repoRoot = join(dirname(__filename), '..');
const checkOnly = process.argv.includes('--check');

const files = [
  'index.html',
  'app.js',
  'styles.css',
  'content/playbooks.js',
  'i18n/index.js'
];

const mismatches = [];

for (const file of files) {
  const source = join(repoRoot, 'frontend', file);
  const target = join(repoRoot, 'backend', 'public', file);

  if (!existsSync(source)) {
    throw new Error(`Missing frontend source: ${source}`);
  }

  const sourceContent = readFileSync(source);
  const targetContent = existsSync(target) ? readFileSync(target) : null;
  const matches = targetContent && sourceContent.equals(targetContent);

  if (checkOnly) {
    if (!matches) mismatches.push(file);
    continue;
  }

  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`Synced ${file}`);
}

if (checkOnly && mismatches.length) {
  throw new Error(`backend/public is out of sync with frontend: ${mismatches.join(', ')}`);
}

if (checkOnly) {
  console.log('backend/public is in sync with frontend');
}
