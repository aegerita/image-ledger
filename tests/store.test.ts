import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MediaStore, storageFolder, type VaultIO } from '../src/store';
import { sha256 } from '../src/media';
import { parseRecord } from '../src/records';
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
    writeBinary: async (relative, bytes) => {await writeFile(path.join(root, relative), bytes);},
    mkdir: async relative => {await mkdir(path.join(root, relative), {recursive: true});},
    remove: async relative => {await unlink(path.join(root, relative)).catch(error => {if (error.code !== 'ENOENT') throw error;});},
    recordPaths: async () => (await walk('')).filter(p => /(?:^|\/)image-records\/[^/]+\.md$/.test(p)),
    pendingPaths: async () => walk('.image-ledger/staging'),
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
