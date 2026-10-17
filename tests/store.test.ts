import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MediaStore, journalLocation, type VaultIO } from '../src/store';
import { sha256 } from '../src/media';
import { parseRecord } from '../src/records';

// A complete 1×1 PNG, kept as fixed bytes so preservation assertions are independent of the implementation.
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/pUAAAAASUVORK5CYII=', 'base64'));
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'journal-media-test-'));
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
    recordPaths: async () => (await walk('')).filter(p => /\/image-records\/.*\.md$/.test(p)),
    pendingPaths: async () => walk('.journal-media/staging'),
  };
  const store = new MediaStore(io); await store.initialize();
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
    assert.match(await f.io.read('journal-images.base'), /journal-image/);
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
    await restarted.describe(first, 'First caption');
    await restarted.complete(pending);
    const secondPending = await restarted.stage({bytes: PNG, method: 'file'}, '2027/01/2027-01-04.md');
    const second = await restarted.prepare(secondPending);
    assert.equal(second.duplicate, true);
    assert.equal(second.record.id, first.record.id);
    assert.equal(second.record.imagePath, first.record.imagePath);
    assert.deepEqual(second.record.journalEntries, ['2026/10/2026-10-17.md', '2027/01/2027-01-04.md']);
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
test('journal path controls year while a non-daily note uses the current date separately', () => {
  assert.deepEqual(journalLocation('2025/12/2025-12-24.md'), {year: '2025', date: '2025-12-24'});
  assert.equal(journalLocation('2024/ideas.md', new Date(2026, 9, 17)).year, '2024');
  assert.equal(journalLocation('ideas.md', new Date(2026, 9, 17)).date, '2026-10-17');
});
