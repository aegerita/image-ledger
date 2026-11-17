import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, settingsFromData } from '../src/settings';

test('saved settings retain current controls and discard obsolete record controls', () => {
  assert.deepEqual(settingsFromData(undefined), DEFAULTS);
  assert.deepEqual(settingsFromData(null), DEFAULTS);
  assert.deepEqual(settingsFromData({interceptPaste: false, showRecordLink: true, syncCustomAlt: true}), {
    interceptPaste: false,
    interceptDrop: true,
    storageLayout: 'flat',
    exiftoolPath: 'exiftool',
  });
  assert.equal(settingsFromData({storageLayout: 'import-year'}).storageLayout, 'import-year');
  assert.equal(settingsFromData({storageLayout: 'note-year'}).storageLayout, 'note-year');
  assert.equal(settingsFromData({exiftoolPath: ' /usr/local/bin/exiftool '}).exiftoolPath, '/usr/local/bin/exiftool');
});

test('malformed saved settings use safe current defaults', () => {
  for (const value of ['invalid', [], null]) assert.deepEqual(settingsFromData(value), DEFAULTS);
  assert.equal(settingsFromData({interceptPaste: 'false'}).interceptPaste, true);
  assert.equal(settingsFromData({storageLayout: 'invalid'}).storageLayout, 'flat');
  assert.equal(settingsFromData({exiftoolPath: '   '}).exiftoolPath, 'exiftool');
  assert.equal(settingsFromData({exiftoolPath: 42}).exiftoolPath, 'exiftool');
});
