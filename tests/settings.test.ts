import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, settingsFromData } from '../src/settings';

test('settings use flat storage unless a current layout is explicitly saved', () => {
  assert.deepEqual(settingsFromData(undefined), DEFAULTS);
  assert.deepEqual(settingsFromData(null), DEFAULTS);
  assert.deepEqual(settingsFromData({interceptPaste: false, interceptDrop: true, showRecordLink: false}), {
    interceptPaste: false, interceptDrop: true, showRecordLink: false, storageLayout: 'flat',
  });
  assert.equal(settingsFromData({}).storageLayout, 'flat');
  assert.equal(settingsFromData({storageLayout: 'import-year'}).storageLayout, 'import-year');
  assert.equal(settingsFromData({storageLayout: 'note-year'}).storageLayout, 'note-year');
});

test('malformed saved settings cannot enable invalid toggle values', () => {
  assert.deepEqual(settingsFromData('invalid'), DEFAULTS);
  assert.deepEqual(settingsFromData([]), DEFAULTS);
  assert.equal(settingsFromData({interceptPaste: 'false'}).interceptPaste, true);
  assert.equal(settingsFromData({storageLayout: 'invalid'}).storageLayout, 'flat');
});
