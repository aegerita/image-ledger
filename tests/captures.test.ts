import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { CaptureWorkflow, latestBatchRecords } from '../src/captures';
import { MediaStore, type VaultIO } from '../src/images/store';
import type { CaptureTarget } from '../src/obsidian/notes';
import { PNG } from './fixtures';
import type { ImageRecord } from '../src/images/model';

function record(id: string, description: string): ImageRecord {
  return {
    schemaVersion: 2, id, description, captionStatus: 'confirmed',
    imagePath: `images/${id}.jpg`, recordPath: `image-records/${id}.md`, sidecarPath: `images/${id}.xmp`,
    sourceName: null, sourceLastModified: null, ingestMethod: 'clipboard',
    importedAt: '2026-10-17T16:00:00Z', sourceNotes: ['Projects/Research.md'],
    sha256: 'a'.repeat(64), bytes: 100, format: 'jpg',
    metadata: {
      capturedAt: null, captureTimeRaw: null, captureTimeOffset: null, captureTimeStatus: 'missing_from_received_file',
      width: 2, height: 3, orientation: null, cameraMake: null, cameraModel: null, raw: {},
    },
  };
}

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

function fixture(describe: (record: ImageRecord) => Promise<string | null> = async () => 'Saved image') {
  const text = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  const folders = new Set<string>();
  const io: VaultIO = {
    exists: async path => text.has(path) || bytes.has(path) || folders.has(path),
    read: async path => {
      const value = text.get(path);
      assert.notEqual(value, undefined, `Missing file: ${path}`);
      return value!;
    },
    readBinary: async path => {
      const value = bytes.get(path);
      assert.ok(value, `Missing payload: ${path}`);
      return value.slice();
    },
    write: async (path, value) => { text.set(path, value); },
    writeBinary: async (path, value) => { bytes.set(path, value.slice()); },
    mkdir: async path => { folders.add(path); },
    remove: async path => { text.delete(path); bytes.delete(path); },
    recordPaths: async () => [...text.keys()].filter(path => /(?:^|\/)image-records\/[^/]+\.md$/.test(path)),
    pendingPaths: async () => [...text.keys(), ...bytes.keys()].filter(path => path.startsWith('.image-ledger/staging/')),
  };
  const store = new MediaStore(io, {storageLayout: 'note-year'});
  const errors: unknown[] = [];
  const notifications: string[] = [];
  const recovered: ImageRecord[] = [];
  const library = {
    ready: () => store.initialize(),
    prepare: (pending: Parameters<MediaStore['prepare']>[0]) => store.prepare(pending),
    openRecord: async () => {},
  };
  const notes = {
    updateEmbeds: async () => {},
    recover: async (record: ImageRecord) => { recovered.push(record); },
    sourceNote: () => undefined,
  };
  const workflow = new CaptureWorkflow(store, library, notes, {
    describe,
    report: error => { errors.push(error); },
    notify: message => { notifications.push(message); },
  });
  const target: CaptureTarget & {records: ImageRecord[]; released: boolean} = {
    path: '2026/Research.md', records: [], released: false,
    insert: async records => { target.records = records; },
    release: () => { target.released = true; },
  };
  const file = () => new File([PNG], 'sample.png', {type: 'image/png'});
  const drain = () => new Promise<void>(resolve => workflow.enqueue(async () => { resolve(); }));
  return {io, store, workflow, target, file, drain, errors, notifications, recovered, text, notes};
}

test('staging failures settle while an earlier caption holds the shared capture and rename queue', async () => {
  let enterPrompt!: () => void;
  let finishPrompt!: (value: string) => void;
  const promptStarted = new Promise<void>(resolve => { enterPrompt = resolve; });
  const prompt = new Promise<string>(resolve => { finishPrompt = resolve; });
  const f = fixture(async () => { enterPrompt(); return prompt; });
  f.workflow.capture([f.file()], f.target, 'clipboard');
  await promptStarted;

  const failure = new Error('Disk is full');
  f.io.writeBinary = async () => { throw failure; };
  const secondTarget = {...f.target, records: [], released: false};
  f.workflow.capture([f.file()], secondTarget, 'clipboard');
  let renamed = false;
  f.workflow.enqueue(async () => { renamed = true; });

  // Delaying consumption must not leave staging rejections unhandled.
  await setImmediate();
  assert.equal(renamed, false);
  const receipts = [...f.text.keys()].filter(path => path.startsWith('.image-ledger/staging/') && path.endsWith('.json'));
  assert.equal(receipts.length, 2, 'The queued batch must stage before its dialog can open');
  finishPrompt('First image');
  await f.drain();
  assert.deepEqual(f.errors, [failure]);
  assert.equal(renamed, true);
  assert.equal(f.target.records.length, 1);
  assert.equal(f.target.released, true);
});

test('failed note insertion retains staged bytes and recovery completes them afterward', async () => {
  const f = fixture();
  const failure = new Error('Note cannot be saved');
  f.target.insert = async () => { throw failure; };
  f.workflow.capture([f.file()], f.target, 'file');
  await f.drain();
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.target.released, true);
  const [pending] = await f.store.pendingCaptures();
  assert.ok(pending);
  assert.deepEqual(await f.io.readBinary(pending.dataPath), new Uint8Array(PNG));

  f.workflow.recover();
  await f.drain();
  assert.equal(f.recovered.length, 1);
  assert.equal(f.recovered[0].description, 'Saved image');
  assert.deepEqual(await f.store.pendingCaptures(), []);
  assert.deepEqual(f.notifications, ['Interrupted images recovered.']);
});

test('a note renamed during its caption keeps the staged storage folder and updates its reference', async () => {
  let notePath = '2026/Research.md';
  const f = fixture(async () => {
    notePath = '2027/Renamed.md';
    return 'Renamed note image';
  });
  Object.defineProperty(f.target, 'path', {get: () => notePath});
  f.workflow.capture([f.file()], f.target, 'file');
  await f.drain();
  const [record] = f.target.records;
  assert.match(record.imagePath, /^2026\/images\//);
  assert.deepEqual(record.sourceNotes, ['2027/Renamed.md']);
  assert.deepEqual(await f.store.pendingCaptures(), []);
  assert.deepEqual(f.errors, []);
});

test('a batch inserts duplicate images once using their final description', async () => {
  const descriptions = ['First description', 'Final description'];
  const f = fixture(async () => descriptions.shift()!);
  f.workflow.capture([f.file(), f.file()], f.target, 'clipboard');
  await f.drain();
  assert.equal(f.store.allRecords().length, 1);
  assert.equal(f.target.records.length, 1);
  assert.equal(f.target.records[0].description, 'Final description');
  assert.deepEqual(await f.store.pendingCaptures(), []);
  assert.deepEqual(f.errors, []);
});
