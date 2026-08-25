import assert from 'node:assert/strict';
import test from 'node:test';

import { providerConfigDescriptor, providerConfigDigest, readEvidenceRecord } from '../src/services/voice-evidence.js';

test('Google speech evidence binds exact regional recognizer and one selected voice per locale', () => {
  const asr = { provider: 'google-stt-v2', settings: {
    projectId: 'hkbuddy-prod-v1-20260826', location: 'asia-southeast1', model: 'chirp_2', recognizer: '_',
    languageCodes: ['yue-Hant-HK', 'en-US', 'cmn-Hans-CN'], credentialVersion: 'runtime-sa-rotation-v1',
  } };
  const tts = { provider: 'google-tts', settings: {
    projectId: 'hkbuddy-prod-v1-20260826', location: 'asia-southeast1', credentialVersion: 'runtime-sa-rotation-v1',
    voices: {
      en: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
      yueHant: { languageCode: 'yue-HK', name: 'yue-HK-Chirp3-HD-Achernar' },
      zhHans: { languageCode: 'cmn-CN', name: 'cmn-CN-Chirp3-HD-Achernar' },
    },
  } };
  assert.deepEqual(providerConfigDescriptor(asr, 'asr'), {
    provider: 'google-stt-v2', capability: 'asr',
    endpoint: 'https://asia-southeast1-speech.googleapis.com/v2/projects/hkbuddy-prod-v1-20260826/locations/asia-southeast1/recognizers/_:recognize',
    projectId: 'hkbuddy-prod-v1-20260826', location: 'asia-southeast1', recognizer: '_', model: 'chirp_2',
    languageCodes: ['yue-Hant-HK', 'en-US', 'cmn-Hans-CN'],
    contentType: 'application/json', inputEncoding: 'canonical-wav-v1', credentialVersion: 'runtime-sa-rotation-v1',
  });
  assert.deepEqual(providerConfigDescriptor(tts, 'tts'), {
    provider: 'google-tts', capability: 'tts',
    endpoint: 'https://asia-southeast1-texttospeech.googleapis.com/v1/text:synthesize',
    projectId: 'hkbuddy-prod-v1-20260826', location: 'asia-southeast1',
    voices: tts.settings.voices, audioEncoding: 'MP3', outputChannels: 1,
    credentialVersion: 'runtime-sa-rotation-v1', fallbackPolicy: 'none',
  });
  const asrDigest = providerConfigDigest(asr, 'asr');
  const ttsDigest = providerConfigDigest(tts, 'tts');
  assert.match(asrDigest, /^[0-9a-f]{64}$/);
  assert.match(ttsDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(providerConfigDigest({ ...asr, settings: { ...asr.settings, credentialVersion: 'runtime-sa-rotation-v2' } }, 'asr'), asrDigest);
  assert.throws(
    () => providerConfigDigest({ ...tts, settings: { ...tts.settings, location: 'us' } }, 'tts'),
    /Google TTS configuration/,
  );
});

test('voice evidence reader is regular-file-only, fixed-cap, and always closes its descriptor', async (t) => {
  const record = { schemaVersion: 1, capability: 'asr', result: 'pass' };
  const source = Buffer.from(JSON.stringify(record));
  const regularStat = (size = source.length) => ({
    dev: 9,
    ino: 23,
    size,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const attempt = ({ bytes = source, lstatFile = () => regularStat(bytes.length), fstatFile = () => regularStat(bytes.length) } = {}) => {
    let cursor = 0;
    const state = { closes: 0, firstReadLength: null, opens: 0 };
    const dependencies = {
      fileConstants: { O_RDONLY: 0, O_NOFOLLOW: 0x100, O_NONBLOCK: 0x200 },
      lstatFile,
      openFile: () => { state.opens += 1; return 61; },
      fstatFile,
      readBytes(fd, target, offset, length, position) {
        assert.equal(fd, 61);
        assert.equal(position, null);
        state.firstReadLength ??= length;
        const count = Math.min(length, bytes.length - cursor);
        if (count <= 0) return 0;
        bytes.copy(target, offset, cursor, cursor + count);
        cursor += count;
        return count;
      },
      closeFile: () => { state.closes += 1; },
    };
    return { dependencies, read: () => readEvidenceRecord('voice-evidence.json', dependencies), state };
  };

  const valid = attempt();
  assert.deepEqual(valid.read(), record);
  assert.deepEqual(valid.state, { closes: 1, firstReadLength: 65_537, opens: 1 });

  for (const [name, pathStat] of [
    ['symbolic link', { ...regularStat(), isSymbolicLink: () => true }],
    ['FIFO or other non-regular file', { ...regularStat(), isFile: () => false }],
  ]) {
    await t.test(name, () => {
      const blocked = attempt({ lstatFile: () => pathStat });
      assert.equal(blocked.read(), null);
      assert.deepEqual(blocked.state, { closes: 0, firstReadLength: null, opens: 0 });
    });
  }

  await t.test('growth beyond the fixed cap is rejected after MAX plus one byte', () => {
    const prefix = JSON.stringify(record);
    const oversized = Buffer.from(`${prefix}${' '.repeat(65_536 - Buffer.byteLength(prefix))}X`);
    const blocked = attempt({
      bytes: oversized,
      lstatFile: () => regularStat(1),
      fstatFile: () => regularStat(1),
    });
    assert.equal(blocked.read(), null);
    assert.deepEqual(blocked.state, { closes: 1, firstReadLength: 65_537, opens: 1 });
  });

  await t.test('read failure still closes the descriptor', () => {
    const blocked = attempt();
    blocked.dependencies.readBytes = () => { throw new Error('private path detail'); };
    assert.equal(blocked.read(), null);
    assert.deepEqual(blocked.state, { closes: 1, firstReadLength: null, opens: 1 });
  });
});
