import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const reliability = JSON.parse(await readFile(join(__dirname, '..', 'eval', 'reliability-cases.json'), 'utf8'));
const corpus = JSON.parse(await readFile(join(__dirname, '..', 'data', 'cantonese-quality-cases.json'), 'utf8'));

const requiredTypes = ['wrong_language', 'register', 'final_particle', 'safety', 'asr_confidence', 'visit_translation'];
const presentTypes = new Set(reliability.cases.map((item) => item.type));
const corpusCategories = new Set(corpus.cases.map((item) => item.category));
const failures = [];

requiredTypes.forEach((type) => {
  if (!presentTypes.has(type)) failures.push(`missing reliability type: ${type}`);
});

['final_particle', 'elderly_visit', 'visit_translation'].forEach((category) => {
  if (!corpusCategories.has(category)) failures.push(`missing corpus category: ${category}`);
});

reliability.cases.forEach((item, index) => {
  if (!item.id || !item.type || !item.input || !item.expected) {
    failures.push(`case[${index}] missing required fields`);
  }
});

const summary = {
  reliabilityVersion: reliability.version,
  totalReliabilityCases: reliability.cases.length,
  types: Array.from(presentTypes).sort(),
  linkedCorpusCases: corpus.cases.length,
  failures
};

console.log(JSON.stringify(summary, null, 2));

if (failures.length) {
  process.exitCode = 1;
}
