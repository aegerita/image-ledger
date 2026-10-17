import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { latestBatchRecords, settledCaptures } from '../src/capture-batch';
import type { ImageRecord } from '../src/types';

function record(id: string, description: string): ImageRecord {
  return {
    schemaVersion: 1, id, description, captionStatus: 'confirmed',
    imagePath: `2026/images/${id}.jpg`, recordPath: `2026/image-records/${id}.md`, sidecarPath: `2026/images/${id}.xmp`,
    sourceName: null, sourceLastModified: null, ingestMethod: 'clipboard',
    importedAt: '2026-10-17T16:00:00Z', journalDate: '2026-10-17', journalEntries: ['2026/10/2026-10-17.md'],
    sha256: 'a'.repeat(64), bytes: 100, format: 'jpg',
    metadata: {
      capturedAt: null, captureTimeRaw: null, captureTimeOffset: null, captureTimeStatus: 'missing_from_received_file',
      width: 2, height: 3, orientation: null, cameraMake: null, cameraModel: null, raw: {},
    },
  };
}

test('staging failures are handled immediately while the consumer waits behind a caption dialog', async () => {
  const failure = new Error('Disk is full');
  const settled = settledCaptures([Promise.reject(failure), Promise.resolve('saved')]);
  // An early rejection would fail node:test as an unhandled rejection if the
  // settlement handlers were attached only after this delayed consumer resumes.
  await setImmediate();
  assert.deepEqual(await settled, [
    { status: 'rejected', reason: failure },
    { status: 'fulfilled', value: 'saved' },
  ]);
});

test('settlement keeps input order even when writes finish in a different order', async () => {
  let finishFirst!: (value: string) => void;
  const first = new Promise<string>(resolve => { finishFirst = resolve; });
  const settled = settledCaptures([first, Promise.resolve('second')]);
  finishFirst('first');
  assert.deepEqual(await settled, [
    { status: 'fulfilled', value: 'first' },
    { status: 'fulfilled', value: 'second' },
  ]);
});

test('a duplicate image has one embed using its latest caption, preserving first occurrence order', () => {
  const first = record('first', 'First caption');
  const second = record('second', 'Second image');
  const revised = { ...first, description: 'Final caption', captionStatus: 'pending' as const };
  const input = [first, second, revised];
  const before = structuredClone(input);
  const result = latestBatchRecords(input, [revised, second]);
  assert.deepEqual(result, [revised, second]);
  assert.equal(result[0].description, 'Final caption');
  assert.deepEqual(input, before);
});

test('a record not in the refreshed catalog remains renderable', () => {
  const item = record('first', 'Available caption');
  assert.deepEqual(latestBatchRecords([item, item], []), [item]);
  assert.deepEqual(latestBatchRecords([], [item]), []);
});
