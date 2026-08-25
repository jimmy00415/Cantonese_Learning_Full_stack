import assert from 'node:assert/strict';
import test from 'node:test';

import { readEvidenceRecord } from '../src/services/voice-evidence.js';

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
