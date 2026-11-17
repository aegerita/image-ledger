import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaStore, storageFolder } from '../src/images/store';
import { sha256 } from '../src/images/media';
import { deletionProjection } from '../src/images/embeds';
import { operationPath, parseOperation, type DeletionNotes } from '../src/images/operations';
import { DEFAULTS } from '../src/settings';
import { JPEG, PNG } from './fixtures';
import { codec, storageFixture } from './storage-fixture';

async function importImage(f: ReturnType<typeof storageFixture>, bytes: Uint8Array = JPEG, description: string | null = 'A synthetic image') {
  const pending = await f.store.stage({bytes}, 'Note.md');
  const image = await f.store.describe(await f.store.prepare(pending), description);
  await f.store.complete(pending);
  return image;
}

test('capture stores one hash-named image with embedded description and no permanent record files', async () => {
  const f = storageFixture();
  const image = await importImage(f);
  assert.equal(image.id, sha256(JPEG));
  assert.equal(image.imagePath, `images/${image.id}.jpg`);
  assert.equal(await codec.readDescription(f.files.get(image.imagePath)!), 'A synthetic image');
  assert.deepEqual([...f.files.keys()], [image.imagePath]);
});

test('description edits and reimporting an exported copy reuse the same normalized identity', async () => {
  const f = storageFixture();
  let image = await importImage(f);
  image = await f.store.setDescription(await f.store.load(image.imagePath), 'Updated caption');
  const exported = f.files.get(image.imagePath)!;
  for (const bytes of [JPEG, exported]) {
    const pending = await f.store.stage({bytes}, 'Other.md');
    const prepared = await f.store.prepare(pending);
    assert.equal(prepared.duplicate, true);
    assert.equal(prepared.record.id, image.id);
    assert.equal((await f.store.describe(prepared, null)).description, 'Updated caption');
    await f.store.complete(pending);
  }
  assert.deepEqual([...f.files.keys()], [image.imagePath]);
});

test('fresh stores rebuild their catalog from image metadata', async () => {
  const f = storageFixture();
  const image = await importImage(f);
  const restarted = new MediaStore(f.io, DEFAULTS, codec);
  await restarted.refresh();
  assert.equal(restarted.allRecords()[0].description, image.description);
  assert.equal((await restarted.load(image.imagePath)).id, image.id);
});

test('Describe later keeps an empty embedded caption and existing import captions survive', async () => {
  const f = storageFixture();
  const empty = await importImage(f, PNG, null);
  assert.equal(empty.description, '');
  const input = await codec.describe(JPEG, 'Existing caption');
  assert.equal((await importImage(f, input, null)).description, 'Existing caption');
  assert.equal((await f.store.audit()).pending, 1);
});

test('description saves refuse stale dialogs and renamed content', async () => {
  const f = storageFixture();
  const image = await importImage(f);
  const first = await f.store.load(image.imagePath);
  await f.store.setDescription(first, 'A newer caption');
  await assert.rejects(f.store.setDescription(first, 'Stale caption'), /changed/);
  f.files.set(image.imagePath, PNG);
  await assert.rejects(f.store.load(image.imagePath), /format does not match|no longer matches/);
});

test('interrupted cleanup can recover from the committed image when staged bytes were already removed', async () => {
  const f = storageFixture();
  const pending = await f.store.stage({bytes: JPEG}, 'Note.md');
  const image = await f.store.describe(await f.store.prepare(pending), 'Saved caption');
  f.faults.removeReceipt = true;
  await assert.rejects(f.store.complete(pending), /cleanup failed/);
  assert.equal(f.files.has(pending.dataPath), false);
  f.faults.removeReceipt = false;
  const restarted = new MediaStore(f.io, DEFAULTS, codec);
  const [recovered] = await restarted.pendingCaptures();
  const prepared = await restarted.prepare(recovered);
  assert.equal(prepared.record.description, image.description);
  await restarted.complete(recovered);
  assert.deepEqual([...f.files.keys()], [image.imagePath]);
});

test('damaged payloads and forged destinations retain their receipts and cannot overwrite another image', async () => {
  const f = storageFixture();
  const pending = await f.store.stage({bytes: JPEG}, 'Note.md');
  pending.imagePath = `images/${'a'.repeat(64)}.jpg`;
  f.files.set(pending.transactionPath, Buffer.from(JSON.stringify(pending)));
  await assert.rejects(f.store.prepare(pending), /destination/);
  f.files.set(pending.dataPath, PNG);
  assert.deepEqual(await f.store.pendingCaptures(), []);
  assert(f.files.has(pending.transactionPath));
});

test('year layout and source-note renames retain pinned recovery destinations', async () => {
  assert.equal(storageFolder('2027-02-03.md', new Date('2026-11-10'), 'note-year'), '2027');
  const f = storageFixture();
  const pending = await f.store.stage({bytes: JPEG}, 'Folder/Note.md');
  const prepared = await f.store.prepare(pending);
  await f.store.rename('Folder', 'Renamed');
  const [renamed] = await f.store.pendingCaptures();
  assert.equal(renamed.sourcePath, 'Renamed/Note.md');
  assert.equal(renamed.imagePath, prepared.record.imagePath);
});

test('deletion receipts resume after note removal and Trash failure without touching prose', async () => {
  const f = storageFixture();
  const image = await importImage(f);
  const original = `Prose\n![caption](${image.imagePath})\nOther prose`;
  let note = original;
  const plans = {'Note.md': deletionProjection(original, 'Note.md', image)};
  const remove = async (_: unknown, notes: DeletionNotes) => {
    assert([notes['Note.md'].before, notes['Note.md'].after].includes(note));
    note = notes['Note.md'].after;
  };
  f.faults.trash = true;
  await assert.rejects(f.store.deleteImage(image, plans, remove), /Trash unavailable/);
  assert.equal(note, 'Prose\n\nOther prose');
  const receiptPath = operationPath(image.id);
  const receipt = JSON.parse(await f.io.read(receiptPath));
  assert.deepEqual(receipt.notes['Note.md'], {before: original, after: note});
  const priorReceipt = {
    ...receipt,
    image: {...receipt.image, importedAt: '2026-11-10T12:00:00Z'},
    notes: {'Note.md': {...plans['Note.md'], afterRanges: [{from: 6, to: 6}]}},
  };
  await f.io.write(receiptPath, JSON.stringify(priorReceipt));
  const pending = await f.store.stage({bytes: JPEG}, 'Other.md');
  await assert.rejects(f.store.prepare(pending), /unfinished deletion/);
  f.faults.trash = false;
  const restarted = new MediaStore(f.io, DEFAULTS, codec);
  await restarted.recoverDeletions(remove);
  await restarted.recoverDeletions(remove);
  assert.deepEqual(f.trashed, [image.imagePath]);
  assert.equal(f.files.has(operationPath(image.id)), false);
});

test('deletion rejects pending captures, changed assets and tampered prose projections', async () => {
  const f = storageFixture();
  const image = await importImage(f);
  const pending = await f.store.stage({bytes: JPEG}, 'Note.md');
  await assert.rejects(f.store.deleteImage(image, {}, async () => {}), /pending captures/);
  await f.store.complete(pending);
  const plan = deletionProjection(`Keep prose ![x](${image.imagePath})`, 'Note.md', image);
  plan.after = 'Destroyed prose';
  const receipt = {version: 2, image, notes: {'Note.md': plan}};
  assert.throws(() => parseOperation(JSON.stringify(receipt), operationPath(image.id)), /Invalid/);
  await f.store.setDescription(image, 'New caption');
  await assert.rejects(f.store.deleteImage(image, {}, async () => {}), /changed during deletion/);
  assert(f.files.has(image.imagePath));
});

test('a failed staging write leaves an auditable receipt for the incomplete capture', async () => {
  const f = storageFixture();
  f.io.writeBinary = async () => { throw new Error('Disk write failed'); };
  await assert.rejects(f.store.stage({bytes: JPEG}, 'Note.md'), /Disk write failed/);
  const audit = await f.store.audit();
  assert.equal(audit.issues.length, 1);
  assert.match(audit.issues[0].path, /staging\/.+\.json$/);
  assert.equal(f.files.size, 1);
});

test('deduplication refreshes the embed target after an image moved while the catalog was stale', async () => {
  const f = storageFixture();
  const image = await importImage(f);
  const moved = `2027/${image.imagePath}`;
  f.files.set(moved, f.files.get(image.imagePath)!);
  f.files.delete(image.imagePath);
  const pending = await f.store.stage({bytes: JPEG}, 'Other.md');
  const prepared = await f.store.prepare(pending);
  assert.equal(prepared.record.imagePath, moved);
  await f.store.describe(prepared, null);
  assert.equal(f.store.allRecords()[0].imagePath, moved);
  await f.store.complete(pending);
  assert.deepEqual([...f.files.keys()], [moved]);
});
