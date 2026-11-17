import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDescriptionCodec, SUPPORTED_EXIFTOOL_VERSIONS } from '../src/images/description';
import { detectImageFormat, sha256 } from '../src/images/media';
import { JPEG, PNG, jpegWithExif, pngWithExif } from './fixtures';
import { readExif } from './exif';

const executable = process.env.EXIFTOOL || 'exiftool';
let version = '';
try {
  version = execFileSync(executable, ['-config', '', '-ver'], {encoding: 'utf8', timeout: 15_000}).trim();
} catch {
  // An explicit executable is required to work; unconfigured developer machines may skip integration checks.
}
const available = SUPPORTED_EXIFTOOL_VERSIONS.includes(version);
if (process.env.EXIFTOOL && !available) throw new Error(`EXIFTOOL must identify ExifTool ${SUPPORTED_EXIFTOOL_VERSIONS.join(' or ')}`);
const integration = {skip: !available};

test('metadata codec rejects missing tools and unsupported bytes with actionable errors', async () => {
  const codec = createDescriptionCodec('/missing/image-ledger-exiftool');
  await assert.rejects(codec.inspect(JPEG), /Install version 13\.58/);
  await assert.rejects(codec.inspect(JPEG), /Install version 13\.58/);
  await assert.rejects(codec.inspect(Buffer.from('GIF89a')), /JPEG and PNG/);
});

test('caption edits and export copies retain the original JPEG/PNG IDs and EXIF metadata', integration, async () => {
  const codec = createDescriptionCodec(executable);
  const fixtures = [
    {original: jpegWithExif({gps: true, offset: '-04:00'}), id: '476852162f3fabc2de2f51c99efa57fb59d533a29e72c69f4cae1b575f26c9ef'},
    {original: pngWithExif({gps: true, offset: '-04:00'}), id: '76836ca895b59b69e4114e87ef59c529be8cff8b6fb91f27c7419848b62b59a1'},
  ];
  for (const {original, id} of fixtures) {
    const savedBytes = Buffer.from(original);
    const baseline = await codec.inspect(original);
    assert.equal(baseline.id, id, 'The original 13.58 fingerprint changed');
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
    const output = await codec.describe(original, 'A new default description');
    assert.equal((await codec.inspect(output)).id, baseline.id);
    const saved = join(directory, 'saved.png');
    await writeFile(saved, output);
    assert.equal(execFileSync(executable, ['-config', '', '-s3', '-XMPToolkit', saved]).toString().trim(), `Image::ExifTool ${version}`);
    assert.equal(execFileSync(executable, ['-config', '', '-b', '-XMP-dc:Title', saved]).toString(), 'Existing title');
    assert.equal(execFileSync(executable, ['-config', '', '-b', '-XMP-dc:Description-fr', saved]).toString(), 'Texte français');
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
