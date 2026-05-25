import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const corpusPath = join(__dirname, '..', 'data', 'cantonese-quality-cases.json');

const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
const requiredFields = corpus.requiredFields || [];
const provider = (process.env.TTS_PROVIDER || 'mock').toLowerCase();
const hasAzure = Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
const hasMiniMax = Boolean(process.env.MINIMAX_API_KEY || process.env.ANTHROPIC_API_KEY);
const configured = (provider === 'azure' && hasAzure) || (provider === 'minimax' && hasMiniMax);

const counts = corpus.cases.reduce((acc, item) => {
  acc[item.category] = (acc[item.category] || 0) + 1;
  return acc;
}, {});

const failures = [];
corpus.cases.forEach((item, index) => {
  requiredFields.forEach((field) => {
    if (!item[field]) failures.push(`case[${index}] ${item.id || '(missing id)'} missing ${field}`);
  });
});

if ((counts.final_particle || 0) < 10) failures.push('expected at least 10 final_particle cases');
if ((counts.elderly_visit || 0) < 10) failures.push('expected at least 10 elderly_visit cases');
if (corpus.cases.length < 40) failures.push('expected at least 40 total cases');

const summary = {
  corpusVersion: corpus.version,
  totalCases: corpus.cases.length,
  counts,
  tts: {
    provider,
    configured,
    status: configured ? 'configured' : 'mock_or_unconfigured',
    voice: provider === 'minimax'
      ? process.env.MINIMAX_TTS_VOICE || 'Cantonese_GentleLady'
      : process.env.AZURE_TTS_VOICE || 'zh-HK-HiuMaanNeural',
    speed: provider === 'minimax'
      ? Number(process.env.MINIMAX_TTS_SPEED || 1)
      : process.env.AZURE_TTS_RATE || '0%'
  },
  failures
};

console.log(JSON.stringify(summary, null, 2));

if (failures.length) {
  process.exitCode = 1;
}
