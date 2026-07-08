import assert from 'node:assert/strict';

import { resolveVisitDirection } from '../services/visitDirectionRouting.js';

const englishInResidentMode = resolveVisitDirection(
  'Could you speak some English for me ?',
  'yue_to_en'
);
assert.equal(englishInResidentMode.effectiveDirection, 'en_to_yue');
assert.equal(englishInResidentMode.requestedDirection, 'yue_to_en');
assert.equal(englishInResidentMode.autoRouted, true);
assert.equal(englishInResidentMode.routeReason, 'english_input_in_resident_mode');

const cantoneseInResidentMode = resolveVisitDirection(
  '可唔可以幫我翻譯一下啦？',
  'yue_to_en'
);
assert.equal(cantoneseInResidentMode.effectiveDirection, 'yue_to_en');
assert.equal(cantoneseInResidentMode.autoRouted, false);

console.log('visit direction routing regressions passed');
