import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDescriptionCodec } from '../src/images/description';
import { imageIdentity, UnreadableImageError } from '../src/images/identity';
import { detectImageFormat, sha256 } from '../src/images/media';
import { ICC_PROFILE, JPEG, PNG, jpegWithExif, jpegWithIcc, jpegWithMpf, jpegWithXmp, pngChunk, pngWithExif, pngWithIcc } from './fixtures';
import { readExif } from './exif';
import { storageFixture } from './storage-fixture';
import { MediaStore } from '../src/images/store';
import { DEFAULTS } from '../src/settings';

const executable = process.env.EXIFTOOL || 'exiftool';
let version = '';
try {
  version = execFileSync(executable, ['-config', '', '-ver'], {encoding: 'utf8', timeout: 15_000}).trim();
} catch {
  // An explicit executable is required to work; unconfigured developer machines may skip integration checks.
}
const available = /^\d+\.\d+$/.test(version);
if (process.env.EXIFTOOL && !available) throw new Error('EXIFTOOL must identify an executable ExifTool installation');
const integration = {skip: !available};

test('metadata codec rejects missing tools and unsupported bytes with actionable errors', async () => {
  const codec = createDescriptionCodec('/missing/image-ledger-exiftool');
  await assert.rejects(codec.inspect(JPEG), /Install ExifTool/);
  await assert.rejects(codec.inspect(Buffer.from('GIF89a')), /JPEG and PNG/);
});

test('caption edits and export copies retain JPEG/PNG identity and EXIF metadata', integration, async () => {
  const codec = createDescriptionCodec(executable);
  const fixtures = [
    jpegWithExif({gps: true, offset: '-04:00'}),
    pngWithExif({gps: true, offset: '-04:00'}),
  ];
  for (const original of fixtures) {
    const savedBytes = Buffer.from(original);
    const baseline = await codec.inspect(original);
    assert.match(baseline.id, /^[0-9a-f]{64}$/);
    assert.equal(baseline.id, await imageIdentity(original));
    const metadata = await readExif(original);
    assert.equal(metadata?.latitude, -12.5);
    assert.equal(metadata?.longitude, -45.25);
    assert.equal(metadata?.DateTimeOriginal, '2026:10:17 12:34:56');
    assert.equal(metadata?.OffsetTimeOriginal, '-04:00');
    assert.equal(metadata?.Orientation, 6);
    let current: Uint8Array = original;
    for (const description of ['Fried rice — egg & vegetables <bowl>', 'Second caption with 中文', '']) {
      current = await codec.describe(current, description);
      assert.equal(detectImageFormat(current), detectImageFormat(original));
      assert.deepEqual(await codec.inspect(current), {id: baseline.id, description});
      assert.equal(await codec.readDescription(current), description);
      assert.deepEqual(await readExif(current), metadata);
    }
    const copied = Uint8Array.from(current);
    assert.equal((await codec.inspect(copied)).id, baseline.id);
    assert.deepEqual(original, savedBytes);
    const described = await codec.describe(current, 'A caption');
    assert.notEqual(sha256(described), sha256(original));
  }
});

const alternate = process.env.EXIFTOOL_ALTERNATE;
test('ICC profiles, all MPF frames and PNG text survive caption edits and reimport', integration, async () => {
  if (alternate) {
    const alternateVersion = execFileSync(alternate, ['-config', '', '-ver'], {encoding: 'utf8', timeout: 15_000}).trim();
    assert.match(alternateVersion, /^\d+\.\d+$/);
    assert.notEqual(alternateVersion, version);
  }
  const first = createDescriptionCodec(executable);
  const second = createDescriptionCodec(alternate ?? executable);
  const text = pngChunk('tEXt', Buffer.from('Comment\0Synthetic comment'));
  const png = Buffer.concat([PNG.subarray(0, -12), text, PNG.subarray(-12)]);
  const directory = await mkdtemp(join(tmpdir(), 'image-ledger-round-trip-'));
  try {
    for (const [original, tags] of [
      [jpegWithIcc(), {'-ICC_Profile': ICC_PROFILE}],
      [pngWithIcc(), {'-ICC_Profile': ICC_PROFILE}],
      [jpegWithMpf(), {'-MPImage2': JPEG, '-MPImage3': JPEG}],
      [png, {'-Comment': Buffer.from('Synthetic comment')}],
    ] as const) {
      const {io} = storageFixture();
      const store = new MediaStore(io, DEFAULTS, first);
      const pending = await store.stage({bytes: original}, 'Note.md');
      const initial = await store.describe(await store.prepare(pending), 'First writer');
      await store.complete(pending);
      const exported = Uint8Array.from(await io.readBinary(initial.imagePath));
      const edited = await second.describe(exported, 'Second writer');
      assert.deepEqual(await first.inspect(edited), {id: initial.id, description: 'Second writer'});
      const restarted = new MediaStore(io, DEFAULTS, second);
      const imported = await restarted.stage({bytes: edited}, 'Other.md');
      const prepared = await restarted.prepare(imported);
      assert.equal(prepared.duplicate, true);
      assert.equal(prepared.record.imagePath, initial.imagePath);
      assert.equal(prepared.record.description, 'First writer');
      await restarted.complete(imported);

      const saved = join(directory, `saved.${detectImageFormat(original)}`);
      await writeFile(saved, edited);
      for (const [tag, expected] of Object.entries(tags)) {
        assert.deepEqual(execFileSync(executable, ['-config', '', '-b', tag, saved]), expected);
      }
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('v2 identity is pinned and includes EXIF, ICC, PNG text and every JPEG frame', async () => {
  assert.equal(await imageIdentity(JPEG), '7886d70c21769cbdf1067103840cc7a33f7f58df57dbfc27945f5843e95a4f90');
  assert.equal(await imageIdentity(PNG), '07a2797da15f91abd8c003e6c5c21b0d2d819d89bb845aad953c9e273ede5cde');
  const changed = Buffer.from(JPEG);
  changed[25]++; // Change the first quantization table without changing the frame length.
  const comment = Buffer.concat([PNG.subarray(0, -12), pngChunk('tEXt', Buffer.from('Comment\0Synthetic comment')), PNG.subarray(-12)]);
  for (const [original, modified] of [
    [JPEG, jpegWithExif({gps: true})],
    [JPEG, jpegWithIcc()],
    [PNG, pngWithIcc()],
    [PNG, comment],
    [jpegWithMpf(), jpegWithMpf(changed)],
  ]) {
    assert.notEqual(await imageIdentity(original), await imageIdentity(modified));
  }
});

test('identity excludes only the main subject’s default XMP description', async () => {
  const withXmp = (caption: string, related: string, locale: string) => {
    const alt = (value: string, lang: string) => `<dc:description><rdf:Alt><rdf:li xml:lang="${lang}">${value}</rdf:li></rdf:Alt></dc:description>`;
    const primary = `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${caption}</rdf:li><rdf:li xml:lang="fr">${locale}</rdf:li></rdf:Alt></dc:description>`;
    const packet = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <rdf:Description rdf:about="">${primary}</rdf:Description>
      <rdf:Description rdf:about="urn:related">${alt(related, 'x-default')}</rdf:Description>
    </rdf:RDF>`;
    const chunk = pngChunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${packet}`));
    return Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
  };
  const id = await imageIdentity(withXmp('Caption', 'Related', 'Texte'));
  assert.equal(await imageIdentity(withXmp('Edited', 'Related', 'Texte')), id);
  assert.notEqual(await imageIdentity(withXmp('Caption', 'Changed', 'Texte')), id);
  assert.notEqual(await imageIdentity(withXmp('Caption', 'Related', 'Autre texte')), id);
});

test('identity reports unreadable XMP and retains the parsing error', async () => {
  const truncatedPngXmp = pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0'));
  const fixtures = [
    jpegWithXmp(Buffer.from('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">')),
    jpegWithXmp(Buffer.from([0xc3, 0x28])),
    Buffer.concat([PNG.subarray(0, -12), truncatedPngXmp, PNG.subarray(-12)]),
  ];
  for (const bytes of fixtures) {
    await assert.rejects(imageIdentity(bytes), error => {
      assert.ok(error instanceof UnreadableImageError);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
  await assert.rejects(imageIdentity(PNG.subarray(0, -1)), /PNG image is incomplete/);
});

test('extended JPEG XMP survives edits to the default description', integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'image-ledger-extended-xmp-'));
  try {
    const source = join(directory, 'source.jpg');
    const tagged = join(directory, 'tagged.jpg');
    const titleFile = join(directory, 'title.txt');
    const title = 'Synthetic title '.repeat(4_200).trim();
    await writeFile(titleFile, title);
    await writeFile(source, JPEG);
    execFileSync(executable, ['-config', '', `-XMP-dc:Title<=${titleFile}`, '-o', tagged, source]);
    const original = await readFile(tagged);
    assert.ok(original.includes(Buffer.from('http://ns.adobe.com/xmp/extension/\0')));
    assert.notEqual(await imageIdentity(original), await imageIdentity(JPEG));
    const writer = createDescriptionCodec(alternate ?? executable);
    const edited = await writer.describe(original, 'Caption next to extended XMP');
    assert.deepEqual(await writer.inspect(edited), {id: await imageIdentity(original), description: 'Caption next to extended XMP'});
    await writeFile(tagged, edited);
    assert.equal(execFileSync(executable, ['-config', '', '-b', '-XMP-dc:Title', tagged]).toString(), title);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('unrelated XMP fields participate in identity and survive caption edits', integration, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'image-ledger-description-test-'));
  try {
    const source = join(directory, 'source.png');
    const tagged = join(directory, 'tagged.png');
    await writeFile(source, PNG);
    execFileSync(executable, ['-config', '', '-XMP-dc:Title=Existing title', '-XMP-dc:Description-fr=Texte français', '-o', tagged, source]);
    const codec = createDescriptionCodec(executable);
    const original = await readFile(tagged);
    const plain = await codec.inspect(PNG);
    const baseline = await codec.inspect(original);
    assert.notEqual(baseline.id, plain.id);
    const writer = createDescriptionCodec(alternate ?? executable);
    const output = await writer.describe(original, 'A new default description');
    assert.equal((await codec.inspect(output)).id, baseline.id);
    const saved = join(directory, 'saved.png');
    await writeFile(saved, output);
    assert.equal(execFileSync(executable, ['-config', '', '-b', '-XMP-dc:Title', saved]).toString(), 'Existing title');
    assert.equal(execFileSync(executable, ['-config', '', '-b', '-XMP-dc:Description-fr', saved]).toString(), 'Texte français');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('caption edits keep nested XMP order and all JPEG frames under the original identity', integration, async () => {
  const packet = Buffer.from(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:stRef="http://ns.adobe.com/xap/1.0/sType/ResourceRef#">
      <xmpMM:DerivedFrom rdf:parseType="Resource">
        <stRef:instanceID>synthetic-instance</stRef:instanceID>
        <stRef:documentID>synthetic-document</stRef:documentID>
      </xmpMM:DerivedFrom>
      <dc:description><rdf:Alt><rdf:li xml:lang="fr">Texte français</rdf:li></rdf:Alt></dc:description>
    </rdf:Description>
  </rdf:RDF>`);
  const withXmp = jpegWithXmp(packet);
  const app1 = withXmp.subarray(2, 4 + withXmp.readUInt16BE(4));
  const mpf = jpegWithMpf();
  const original = Buffer.concat([mpf.subarray(0, 2), app1, mpf.subarray(2)]);
  // APP1 precedes MPF, so only the primary frame size needs updating.
  const primarySize = original.indexOf(Buffer.from('MPF\0')) + 4 + 54;
  original.writeUInt32LE(original.readUInt32LE(primarySize) + app1.length, primarySize);

  const codec = createDescriptionCodec(executable);
  const writer = createDescriptionCodec(alternate ?? executable);
  const baseline = await codec.inspect(original);
  assert.deepEqual(baseline, {id: 'a519c24e088f8f69d02a86e5c93a36a3df532f17bf1471a386ae817a316622ce', description: ''});
  let saved: Uint8Array = original;
  for (const description of ['Synthetic caption & <test>', 'Changed caption', '']) {
    saved = await writer.describe(saved, description);
    assert.deepEqual(await codec.inspect(saved), {id: baseline.id, description});
  }

  const directory = await mkdtemp(join(tmpdir(), 'image-ledger-structured-xmp-'));
  try {
    const output = join(directory, 'saved.jpg');
    await writeFile(output, saved);
    const tag = (name: string) => execFileSync(executable, ['-config', '', '-b', name, output]);
    assert.match(tag('-XMP').toString(), /<stRef:instanceID>synthetic-instance<\/stRef:instanceID>\s*<stRef:documentID>synthetic-document<\/stRef:documentID>/);
    assert.equal(tag('-XMP-dc:Description-fr').toString(), 'Texte français');
    assert.deepEqual(tag('-MPImage2'), JPEG);
    assert.deepEqual(tag('-MPImage3'), JPEG);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('concurrent metadata operations keep their temporary inputs separate', integration, async () => {
  const codec = createDescriptionCodec(executable);
  const [first, second] = await Promise.all([
    codec.describe(JPEG, 'First image'),
    codec.describe(PNG, 'Second image'),
  ]);
  assert.equal(await codec.readDescription(first), 'First image');
  assert.equal(await codec.readDescription(second), 'Second image');
});
