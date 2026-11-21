import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_CACHE_PATH, MediaStore, storageFolder } from '../src/images/store';
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
  assert.equal(image.id, `${sha256(JPEG)}`);
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

const legacyId = '1'.repeat(64);
const legacyPath = `images/${legacyId}.jpg`;

test('existing legacy paths are preserved through caption edits and reimports', async () => {
  const f = storageFixture();
  f.files.set(legacyPath, await codec.describe(JPEG, 'Legacy caption'));
  await f.store.refresh();
  assert.equal(f.store.allRecords()[0].imagePath, legacyPath);
  const edited = await f.store.setDescription(await f.store.load(legacyPath), 'Updated legacy caption');
  const exported = f.files.get(legacyPath)!;
  assert.equal(edited.id, legacyId);
  for (const bytes of [JPEG, exported]) {
    const imported = await importImage(f, bytes, null);
    assert.equal(imported.imagePath, legacyPath);
    assert.equal(imported.description, 'Updated legacy caption');
  }
});

test('legacy metadata errors preserve deletion while rejecting that path as a capture destination', async () => {
  const f = storageFixture();
  const malformed = Buffer.concat([JPEG, Buffer.from('Unrecognized legacy metadata')]);
  function checkLegacyMetadata(bytes: Uint8Array) {
    if (sha256(bytes) === sha256(malformed)) throw new Error('Cannot identify legacy metadata');
  }
  const store = new MediaStore(f.io, DEFAULTS, {
    ...codec,
    identity: async bytes => {
      checkLegacyMetadata(bytes);
      return codec.identity(bytes);
    },
    inspect: async bytes => {
      checkLegacyMetadata(bytes);
      return codec.inspect(bytes);
    },
  });
  f.files.set(legacyPath, malformed);
  const pending = await store.stage({bytes: JPEG}, 'Note.md');
  pending.version = 2;
  pending.imagePath = legacyPath;
  await assert.rejects(store.prepare(pending), /destination/);
  delete pending.imagePath;
  assert.equal((await store.prepare(pending)).duplicate, false);
  await store.deleteImage(await store.load(legacyPath), {}, async () => {});
  assert.deepEqual(f.trashed, [legacyPath]);
});

test('fresh stores rebuild their catalog from image metadata', async () => {
  const f = storageFixture();
  const image = await importImage(f);
  const restarted = new MediaStore(f.io, DEFAULTS, codec);
  await restarted.refresh();
  assert.equal(restarted.allRecords()[0].description, image.description);
  assert.equal((await restarted.load(image.imagePath)).id, image.id);
});

function cachedStorageFixture() {
  const fixture = storageFixture();
  const {io} = fixture;
  const imageReads: string[] = [];
  const captions: string[] = [];
  const originalReadBinary = io.readBinary;
  io.readBinary = async path => {
    if (path.startsWith('images/') || path.includes('/images/')) imageReads.push(path);
    return originalReadBinary(path);
  };
  const trackedCodec = {
    ...codec,
    readDescription: async (bytes: Uint8Array) => {
      const description = await codec.readDescription(bytes);
      captions.push(description);
      return description;
    },
  };
  return {...fixture, imageReads, captions, open: () => new MediaStore(io, DEFAULTS, trackedCodec)};
}

test('catalog refresh and restart reuse unchanged captions and read only changed image paths', async () => {
  const f = cachedStorageFixture();
  const photo = await importImage(f, JPEG, 'Original');
  const diagram = await importImage(f, PNG, 'Diagram');
  f.imageReads.length = 0;

  const cold = f.open();
  await cold.refresh();
  assert.deepEqual(f.imageReads.splice(0), [photo.imagePath, diagram.imagePath]);
  assert.deepEqual(f.captions.splice(0), ['Original', 'Diagram']);

  await cold.refresh();
  const warm = f.open();
  await warm.refresh();
  assert.deepEqual(warm.allRecords(), cold.allRecords());
  assert.deepEqual(f.imageReads, []);
  assert.deepEqual(f.captions, []);

  const replacement = await codec.describe(JPEG, 'Replaced');
  f.files.set(photo.imagePath, replacement);
  await warm.refresh();
  assert.deepEqual(f.imageReads.splice(0), [photo.imagePath]);
  assert.deepEqual(f.captions.splice(0), ['Replaced']);

  const moved = `2027/${photo.imagePath}`;
  f.files.set(moved, replacement);
  f.files.delete(photo.imagePath);
  f.files.delete(diagram.imagePath);
  await warm.rename(photo.imagePath, moved);
  assert.deepEqual(f.imageReads.splice(0), [moved]);
  assert.deepEqual(f.captions.splice(0), ['Replaced']);
  assert.deepEqual(warm.allRecords().map(({imagePath, description}) => [imagePath, description]), [[moved, 'Replaced']]);

  const reopened = f.open();
  await reopened.refresh();
  assert.deepEqual(reopened.allRecords(), warm.allRecords());
  assert.deepEqual(f.imageReads, []);
  assert.deepEqual(f.captions, []);
});

test('a corrupt or unsupported catalog cache is rebuilt from the images', async () => {
  const f = cachedStorageFixture();
  const image = await importImage(f);
  await f.open().refresh();
  const saved = JSON.parse(await f.io.read(CATALOG_CACHE_PATH));

  const invalidCaches = ['{', 'null', JSON.stringify({...saved, version: -1}),
    JSON.stringify({...saved, entries: {[image.imagePath]: null}})];
  for (const invalid of invalidCaches) {
    await f.io.write(CATALOG_CACHE_PATH, invalid);
    f.imageReads.length = 0;
    f.captions.length = 0;
    const rebuilt = f.open();
    await rebuilt.refresh();
    assert.equal(rebuilt.allRecords()[0].description, image.description);
    assert.deepEqual(f.imageReads, [image.imagePath]);
    assert.deepEqual(f.captions, [image.description]);
    assert.deepEqual(JSON.parse(await f.io.read(CATALOG_CACHE_PATH)), saved);
  }
});

test('changing an image during caption read leaves no stale cache entry', async () => {
  const f = cachedStorageFixture();
  const image = await importImage(f);
  const replacement = await codec.describe(JPEG, 'Replaced during read');
  const readBinary = f.io.readBinary;
  f.io.readBinary = async path => {
    const bytes = await readBinary(path);
    f.files.set(image.imagePath, replacement);
    return bytes;
  };
  const cold = f.open();
  await cold.refresh();
  assert.deepEqual(cold.allRecords(), []);
  const reopened = f.open();
  await reopened.refresh();
  assert.equal(reopened.allRecords()[0].description, 'Replaced during read');
});

test('matching catalog metadata cannot hide changed bytes from edits, deletion, recovery, or audit', async () => {
  const f = cachedStorageFixture();
  const image = await importImage(f, JPEG, 'Original');
  const originalStat = f.io.stat;
  const originalStamp = await originalStat(image.imagePath);
  f.io.stat = path => path === image.imagePath ? Promise.resolve(originalStamp) : originalStat(path);
  const store = f.open();
  await store.refresh();
  const verified = await store.load(image.imagePath);
  const [cached] = store.allRecords();
  await assert.rejects(store.setDescription(cached, 'Unverified edit'), /reload the image/i);
  await assert.rejects(store.deleteImage(cached, {}, async () => {}), /reload the image/i);
  const remove = async () => { throw new Error('Interrupted note removal'); };
  await assert.rejects(store.deleteImage(verified, {}, remove), /Interrupted note removal/);

  const replacement = await codec.describe(JPEG, 'Replaced');
  assert.equal(replacement.length, f.files.get(image.imagePath)!.length);
  f.files.set(image.imagePath, replacement);
  await store.refresh();
  assert.equal(store.allRecords()[0].description, 'Original');
  await assert.rejects(store.recoverDeletions(remove), /image changed during deletion/);
  assert(f.files.has(operationPath(image.id)));
  await f.io.remove(operationPath(image.id));

  await assert.rejects(store.setDescription(verified, 'Stale edit'), /image changed/i);
  await assert.rejects(store.deleteImage(verified, {}, remove), /image changed during deletion preview/);
  assert.deepEqual(f.files.get(image.imagePath), replacement);
  assert.deepEqual(f.trashed, []);

  f.imageReads.length = 0;
  const audit = await store.audit();
  assert.deepEqual(audit.issues, []);
  assert.deepEqual(f.imageReads, [image.imagePath]);
  assert.equal(store.allRecords()[0].description, 'Replaced');
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
  for (const path of [legacyPath, `images/${'a'.repeat(64)}.jpg`]) {
    pending.imagePath = path;
    await f.io.write(pending.transactionPath, JSON.stringify(pending));
    await assert.rejects(f.store.prepare(pending), /destination/);
  }
  f.files.set(pending.dataPath, PNG);
  assert.deepEqual(await f.store.pendingCaptures(), []);
  assert(f.files.has(pending.transactionPath));
});

test('legacy capture recovery retains a committed path and retargets an uncommitted missing path safely', async () => {
  const f = storageFixture();
  const pending = await f.store.stage({bytes: JPEG}, 'Note.md');
  pending.version = 2;
  pending.imagePath = legacyPath;
  await f.io.write(pending.transactionPath, JSON.stringify(pending));
  const [uncommitted] = await f.store.pendingCaptures();
  const fresh = await f.store.prepare(uncommitted);
  assert.equal(fresh.record.imagePath, `images/${sha256(JPEG)}.jpg`);

  const saved = await codec.describe(JPEG, 'Legacy saved caption');
  f.files.set(legacyPath, saved);
  pending.savedChecksum = sha256(saved);
  await f.io.write(pending.transactionPath, JSON.stringify(pending));
  const [committed] = await f.store.pendingCaptures();
  assert.equal((await f.store.prepare(committed)).record.imagePath, legacyPath);
  f.files.delete(legacyPath);
  await assert.rejects(f.store.prepare(committed), /restore the missing legacy image/i);
  assert(f.files.has(committed.transactionPath));
  f.files.set(legacyPath, saved);
  await f.io.remove(committed.dataPath);
  const [cleanup] = await f.store.pendingCaptures();
  const recovered = await f.store.describe(await f.store.prepare(cleanup), null);
  assert.equal(recovered.imagePath, legacyPath);
  await f.store.complete(cleanup);
  assert.deepEqual([...f.files.keys()], [legacyPath]);
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

test('legacy deletion receipts block reimports and resume when the image is already in Trash', async () => {
  const f = storageFixture();
  f.files.set(legacyPath, JPEG);
  const image = await f.store.load(legacyPath);
  const pending = await f.store.stage({bytes: JPEG}, 'Other.md');
  await assert.rejects(f.store.deleteImage(image, {}, async () => {}), /pending captures/);
  await f.store.complete(pending);

  const receipt = operationPath(legacyId);
  await f.io.write(receipt, JSON.stringify({version: 2, image, notes: {}}));
  const staged = await f.store.stage({bytes: JPEG}, 'Other.md');
  await assert.rejects(f.store.prepare(staged), /unfinished deletion/);
  f.files.set(legacyPath, await codec.describe(JPEG, 'Changed checksum'));
  await assert.rejects(f.store.prepare(staged), /changed legacy image/);
  await f.io.trash(legacyPath);
  await assert.rejects(f.store.prepare(staged), /missing or changed legacy image/);
  await f.store.recoverDeletions(async () => {});
  assert.equal(f.files.has(receipt), false);
  assert.equal((await f.store.prepare(staged)).record.id, await codec.identity(JPEG));
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
