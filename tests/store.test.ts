import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MediaStore, storageFolder, type VaultIO } from '../src/images/store';
import { sha256 } from '../src/images/media';
import { parseRecord, serializeRecord } from '../src/images/records';
import type { StorageLayout } from '../src/settings';

// A complete 1×1 PNG, kept as fixed bytes so preservation assertions are independent of the implementation.
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/pUAAAAASUVORK5CYII=', 'base64'));
async function fixture(storageLayout: StorageLayout = 'note-year') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-ledger-test-'));
  const walk = async (directory: string): Promise<string[]> => {
    const result: string[] = [];
    for (const entry of await readdir(path.join(root, directory), {withFileTypes: true}).catch(() => [])) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await walk(relative)); else result.push(relative);
    }
    return result;
  };
  const io: VaultIO = {
    exists: async relative => {try {await readFile(path.join(root, relative));return true;} catch {try {return (await readdir(path.join(root, relative))) !== null;} catch {return false;}}},
    read: relative => readFile(path.join(root, relative), 'utf8'),
    readBinary: async relative => new Uint8Array(await readFile(path.join(root, relative))),
    write: async (relative, text) => {await writeFile(path.join(root, relative), text);},
    process: async (relative, update) => {
      const file = path.join(root, relative);
      await writeFile(file, update(await readFile(file, 'utf8')));
    },
    writeBinary: async (relative, bytes) => {await writeFile(path.join(root, relative), bytes);},
    mkdir: async relative => {await mkdir(path.join(root, relative), {recursive: true});},
    remove: async relative => {await unlink(path.join(root, relative)).catch(error => {if (error.code !== 'ENOENT') throw error;});},
    recordPaths: async () => (await walk('')).filter(p => /(?:^|\/)image-records\/[^/]+\.md$/.test(p)),
    pendingPaths: async () => walk('.image-ledger/staging'),
    operationPaths: async () => walk('.image-ledger/operations'),
  };
  const store = new MediaStore(io, {storageLayout}); await store.initialize();
  return {root, io, store, cleanup: () => rm(root, {recursive: true, force: true})};
}
test('saves byte-identical UUID image, caption record, sidecar and Base', async () => {
  const f = await fixture();
  try {
    const pending = await f.store.stage({bytes: PNG, name: 'photo.png', method: 'clipboard'}, '2025/12/2025-12-24.md');
    const prepared = await f.store.prepare(pending);
    const record = await f.store.describe(prepared, 'A tiny test image.');
    assert.match(record.imagePath, /^2025\/images\/[0-9a-f-]{36}\.png$/);
    assert.deepEqual(await f.io.readBinary(record.imagePath), PNG);
    assert.equal(record.sha256, sha256(PNG));
    assert.equal(parseRecord(await f.io.read(record.recordPath))?.description, 'A tiny test image.');
    assert.match(await f.io.read(record.sidecarPath), /A tiny test image\./);
    assert.match(await f.io.read('image-library.base'), /name: Images/);
    await f.store.complete(pending);
    assert.equal((await f.store.pendingCaptures()).length, 0);
  } finally {await f.cleanup();}
});
test('stages captures with distinct UUIDv4 image names', async () => {
  const f = await fixture();
  try {
    const captures = await Promise.all(Array.from({length: 100}, () =>
      f.store.stage({bytes: PNG, method: 'clipboard'}, 'Projects/Research.md')));
    const ids = captures.map(capture => capture.id);
    for (const id of ids) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    assert.equal(new Set(ids).size, ids.length);
  } finally {await f.cleanup();}
});
test('restart recovers staged capture and duplicate paste reuses its UUID across years', async () => {
  const f = await fixture();
  try {
    const pending = await f.store.stage({bytes: PNG, method: 'clipboard'}, '2026/10/2026-10-17.md');
    const restarted = new MediaStore(f.io); await restarted.initialize();
    assert.equal((await restarted.pendingCaptures())[0].id, pending.id);
    const first = await restarted.prepare(pending);
    assert.match(first.record.imagePath, /^2026\/images\//);
    await restarted.describe(first, 'First caption');
    await restarted.complete(pending);
    const secondPending = await restarted.stage({bytes: PNG, method: 'file'}, '2027/01/2027-01-04.md');
    const second = await restarted.prepare(secondPending);
    assert.equal(second.duplicate, true);
    assert.equal(second.record.id, first.record.id);
    assert.equal(second.record.imagePath, first.record.imagePath);
    assert.deepEqual(second.record.sourceNotes, ['2026/10/2026-10-17.md', '2027/01/2027-01-04.md']);
    const kept = await restarted.describe(second, null);
    assert.equal(kept.description, 'First caption');
    assert.equal(kept.captionStatus, 'confirmed');
  } finally {await f.cleanup();}
});
test('restores a missing identical local image but refuses to overwrite changed bytes', async () => {
  const f = await fixture();
  try {
    const first = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, '2026/a.md'));
    await f.store.describe(first, null);
    await unlink(path.join(f.root, first.record.imagePath));
    const restored = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, '2026/b.md'));
    assert.equal(restored.record.id, first.record.id);
    assert.deepEqual(await f.io.readBinary(first.record.imagePath), PNG);
    await writeFile(path.join(f.root, first.record.imagePath), 'changed bytes');
    await assert.rejects(f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, '2026/c.md')), /differs from its recorded hash/);
    assert.equal(await readFile(path.join(f.root, first.record.imagePath), 'utf8'), 'changed bytes');
  } finally {await f.cleanup();}
});

test('Describe later preserves newer saved properties and references while a duplicate prompt is open', async () => {
  const f = await fixture();
  try {
    const first = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'First.md'));
    await f.store.describe(first, 'Original description');
    const duplicate = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Second.md'));
    const current = {
      ...first.record,
      description: 'Edited in Bases',
      captionStatus: 'pending' as const,
      sourceName: 'Updated source name',
      sourceNotes: ['First.md', 'Third.md'],
    };
    await f.io.write(current.recordPath, serializeRecord(current));
    const saved = await f.store.describe(duplicate, null);
    assert.equal(saved.description, current.description);
    assert.equal(saved.captionStatus, current.captionStatus);
    assert.equal(saved.sourceName, current.sourceName);
    assert.deepEqual(saved.sourceNotes, ['First.md', 'Third.md', 'Second.md']);

    await f.io.write(saved.recordPath, serializeRecord({...saved, description: 'Another saved edit'}));
    const explicit = await f.store.describe(duplicate, 'My chosen replacement');
    assert.equal(explicit.description, 'My chosen replacement');
    assert.deepEqual(explicit.sourceNotes, saved.sourceNotes);
  } finally {await f.cleanup();}
});

test('description save refuses an unreadable current record and leaves staging recoverable', async () => {
  const f = await fixture();
  try {
    const pending = await f.store.stage({bytes: PNG, method: 'file'}, 'First.md');
    const prepared = await f.store.prepare(pending);
    await f.io.write(prepared.record.recordPath, 'Malformed record');
    await assert.rejects(f.store.describe(prepared, null), /record changed or cannot be read/);
    assert.equal(await f.io.read(prepared.record.recordPath), 'Malformed record');
    assert.deepEqual((await f.store.pendingCaptures()).map(item => item.id), [pending.id]);
  } finally {await f.cleanup();}
});

test('capture description retries preserve unrelated saved fields and new source references', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const first = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'First.md'));
  const original = await f.store.describe(first, 'Original description');
  const duplicate = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Second.md'));
  const process = f.io.process;
  let edited = false;
  f.io.process = async (file, update) => {
    if (!edited) {
      edited = true;
      await f.io.write(file, serializeRecord({...original, sourceName: 'New filename', sourceNotes: ['First.md', 'Third.md']}));
    }
    await process(file, update);
  };

  const saved = await f.store.describe(duplicate, 'Submitted description');

  assert.equal(edited, true);
  assert.equal(saved.description, 'Submitted description');
  assert.equal(saved.sourceName, 'New filename');
  assert.deepEqual(saved.sourceNotes, ['First.md', 'Third.md', 'Second.md']);
  assert.deepEqual(parseRecord(await f.io.read(saved.recordPath)), saved);
  assert.match(await f.io.read(saved.sidecarPath), /Submitted description/);
  assert.deepEqual(f.store.allRecords(), [saved]);
});

test('capture description and a queued scan preserve a newer concurrent caption', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const first = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'First.md'));
  const original = await f.store.describe(first, 'Original description');
  const duplicate = await f.store.prepare(await f.store.stage({bytes: PNG, method: 'file'}, 'Second.md'));
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const describing = f.store.describe(duplicate, 'Submitted description', 'Second.md', async () => {
    enter();
    await released;
  });
  await entered;
  await f.io.write(original.recordPath, serializeRecord({...original, description: 'Newer caption'}));
  const scanning = f.store.refresh();
  release();
  const saved = await describing;
  await scanning;

  assert.equal(saved.description, 'Newer caption');
  assert.deepEqual(saved.sourceNotes, ['First.md', 'Second.md']);
  assert.deepEqual(parseRecord(await f.io.read(saved.recordPath)), saved);
  assert.match(await f.io.read(saved.sidecarPath), /Newer caption/);
  assert.deepEqual(f.store.allRecords(), [saved]);
});

test('preparing a staged capture never replaces an unreadable existing record', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const pending = await f.store.stage({bytes: PNG, method: 'file'}, 'First.md');
  const prepared = await f.store.prepare(pending);
  const content = 'Unreadable record kept for inspection';
  await f.io.write(prepared.record.recordPath, content);

  await assert.rejects(f.store.prepare(pending), /Refusing to overwrite an existing image record/);

  assert.equal(await f.io.read(prepared.record.recordPath), content);
  assert.deepEqual((await f.store.pendingCaptures()).map(item => item.id), [pending.id]);
});
test('failed record write leaves recoverable staging and never reports successful completion', async () => {
  const f = await fixture();
  try {
    const pending = await f.store.stage({bytes: PNG, method: 'clipboard'}, '2026/a.md');
    const original = f.io.write;
    f.io.write = async (p, text) => {if (p.endsWith('.md')) throw new Error('disk full');return original(p, text);};
    await assert.rejects(f.store.prepare(pending), /disk full/);
    assert.equal((await f.store.pendingCaptures()).length, 1);
    f.io.write = original;
    const recovered = await f.store.prepare(pending);
    assert.equal(recovered.record.id, pending.id);
    assert.deepEqual(await f.io.readBinary(recovered.record.imagePath), PNG);
  } finally {await f.cleanup();}
});
test('note-year layout infers a year while generic layouts ignore note names and folders', () => {
  const importedAt = new Date(2026, 9, 17);
  assert.equal(storageFolder('2025/12/2025-12-24.md', importedAt, 'note-year'), '2025');
  assert.equal(storageFolder('2024/ideas.md', importedAt, 'note-year'), '2024');
  assert.equal(storageFolder('ideas.md', importedAt, 'note-year'), '2026');
  for (const source of ['ideas.md', 'Projects/Design.md', '2024/ideas.md', '2025/12/2025-12-24.md']) {
    assert.equal(storageFolder(source, importedAt, 'flat'), '');
    assert.equal(storageFolder(source, importedAt, 'import-year'), '2026');
  }
});

test('flat captures pin their folder across settings changes and recover without a note date', async () => {
  const f = await fixture('flat');
  try {
    const pending = await f.store.stage({bytes: PNG, method: 'file'}, '1999/1999-12-31.md');
    assert.equal(pending.storageFolder, '');
    assert.equal('noteDate' in pending, false);
    const restarted = new MediaStore(f.io, {storageLayout: 'note-year'});
    await restarted.initialize();
    const [recovered] = await restarted.pendingCaptures();
    const prepared = await restarted.prepare(recovered);
    assert.equal(prepared.record.imagePath, `images/${pending.id}.png`);
    assert.equal(prepared.record.recordPath, `image-records/${pending.id}.md`);
    assert.equal('noteDate' in prepared.record, false);
    await restarted.describe(prepared, 'A project image');
    await restarted.complete(recovered);
    const duplicate = await restarted.prepare(await restarted.stage({bytes: PNG, method: 'clipboard'}, '2000/2000-01-01.md'));
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record.id, pending.id);
    assert.deepEqual(duplicate.record.sourceNotes, ['1999/1999-12-31.md', '2000/2000-01-01.md']);
  } finally {await f.cleanup();}
});

test('receipt recovery retains the pinned destination and rejects malformed receipts without deleting staged bytes', async () => {
  const f = await fixture('note-year');
  try {
    const pending = await f.store.stage({bytes: PNG, method: 'file'}, '2003/2003-02-03.md');
    const restarted = new MediaStore(f.io, {storageLayout: 'flat'});
    await restarted.initialize();
    const [recovered] = await restarted.pendingCaptures();
    assert.equal(recovered.storageFolder, '2003');
    await restarted.retarget(recovered, 'Projects/Renamed.md');
    assert.equal((await restarted.pendingCaptures())[0].sourcePath, 'Projects/Renamed.md');
    const prepared = await restarted.prepare(recovered);
    assert.equal(prepared.record.imagePath, `2003/images/${pending.id}.png`);
    assert.deepEqual(prepared.record.sourceNotes, ['Projects/Renamed.md']);
    for (const invalid of [
      {...recovered, storageFolder: undefined},
      {...recovered, storageFolder: '../outside'},
      {...recovered, storageFolder: 2003},
      {...recovered, transactionPath: `.other-state/staging/${pending.id}.json`},
      {...recovered, dataPath: `.other-state/staging/${pending.id}.png`},
      {...recovered, importedAt: 'unknown'},
    ]) {
      await f.io.write(pending.transactionPath, JSON.stringify(invalid));
      assert.equal((await restarted.pendingCaptures()).length, 0);
      assert.deepEqual(await f.io.readBinary(pending.dataPath), PNG);
    }
    await f.io.write(pending.transactionPath, JSON.stringify(recovered));
    await restarted.complete(recovered);
    assert.equal((await restarted.pendingCaptures()).length, 0);
  } finally {await f.cleanup();}
});
