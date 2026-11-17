import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { App, TFile } from 'obsidian';
import { createDescriptionCodec, SUPPORTED_EXIFTOOL_VERSIONS } from '../src/images/description';
import { sha256 } from '../src/images/media';
import { CATALOG_CACHE_PATH, MediaStore } from '../src/images/store';
import { jpegWithExif } from '../tests/fixtures';
import { loadHostModules } from '../tests/host-modules';
import { createTestVault } from './test-vault';

const run = promisify(execFile);
const imageCount = 2_000;
const caption = 'Image Ledger fingerprint prototype';

async function createImages(root: string, executable: string): Promise<string[]> {
  const seed = path.join(root, '.benchmark-seed');
  const normalized = path.join(root, '.benchmark-normalized');
  const images = path.join(root, 'images');
  for (const folder of [seed, normalized, images]) await mkdir(folder);
  for (let index = 0; index < imageCount; index++) {
    await writeFile(path.join(seed, `${index}.jpg`), jpegWithExif({subsecond: String(index).padStart(4, '0')}));
  }
  // Batch the codec's current fingerprint recipe to generate valid filenames without one subprocess per fixture.
  await run(executable, ['-config', '', `-XMP-dc:Description-x-default=${caption}`,
    '-XMP-x:XMPToolkit=Image::ExifTool 13.58', '-o', normalized, seed], {timeout: 30_000});
  const paths: string[] = [];
  for (const name of await readdir(normalized)) {
    const source = path.join(normalized, name);
    const imagePath = `images/${sha256(await readFile(source))}.jpg`;
    await rename(source, path.join(root, imagePath));
    paths.push(imagePath);
  }
  assert.equal(new Set(paths).size, imageCount);
  return paths;
}

async function benchmark(root: string, executable: string, version: string): Promise<void> {
  const codec = createDescriptionCodec(executable);
  const phases: Record<string, ReturnType<typeof counters> & {ms: number}> = {};
  let metrics = counters();
  const measure = async (phase: string, action: () => Promise<void>) => {
    console.error(phase);
    metrics = counters();
    const start = performance.now();
    try {
      await action();
    } finally {
      phases[phase] = {...metrics, ms: Number((performance.now() - start).toFixed(1))};
    }
  };
  const receipt = {vault: root, imageCount, exiftool: version, node: process.version, phases};
  const receiptPath = path.join(root, 'catalog-benchmark.json');
  try {
    const paths = await createImages(root, executable);
    const host = await loadHostModules();
    const files = paths.map(imagePath => Object.assign(new host.TFile(), {path: imagePath}));
    const indexed = new Map(files.map(file => [file.path, file]));
    const adapter = new host.FileSystemAdapter();
    adapter.getBasePath = () => root;
    const app = {
      vault: {
        adapter,
        getFiles: () => files,
        getMarkdownFiles: () => [],
        getAbstractFileByPath: (file: string) => indexed.get(file),
      },
      workspace: {getActiveFile: () => null, activeEditor: null},
    } as unknown as App;
    const openCatalog = () => {
      const io = host.createVaultIO(app.vault, {trashFile: async () => assert.fail('Unexpected trash')});
      const store = new MediaStore({
        ...io,
        read: async file => {
          const contents = await io.read(file);
          if (file === CATALOG_CACHE_PATH) metrics.cacheReads++;
          return contents;
        },
        readBinary: async file => {
          const bytes = await io.readBinary(file);
          metrics.imageReads++;
          metrics.imageBytes += bytes.byteLength;
          return bytes;
        },
      }, {storageLayout: 'flat'}, {
        readDescription: bytes => {
          metrics.captionReads++;
          return codec.readDescription(bytes);
        },
        inspect: bytes => {
          metrics.inspections++;
          return codec.inspect(bytes);
        },
        describe: (bytes, description) => {
          metrics.captionWrites++;
          return codec.describe(bytes, description);
        },
      });
      return new host.ImageLibrary(app, store, new host.NoteImages(app), error => { throw error; }, action => action());
    };

    const cold = openCatalog();
    await measure('coldStart', () => cold.ready());
    assert.equal(cold.store.allRecords().length, imageCount);
    assert.equal(phases.coldStart.imageReads, imageCount);
    assert.equal(phases.coldStart.captionReads, imageCount);

    const warm = openCatalog();
    await measure('warmStart', () => warm.ready());
    assert.equal(warm.store.allRecords().length, imageCount);
    assert.ok(phases.warmStart.cacheReads > 0);
    await measure('pickerOpen', () => warm.openLibrary(async () => assert.fail('Unexpected description dialog')));
    for (const phase of ['warmStart', 'pickerOpen']) {
      assert.equal(phases[phase].imageReads, 0, phase);
      assert.equal(phases[phase].captionReads, 0, phase);
    }

    for (const [index, imagePath] of paths.slice(0, 3).entries()) {
      const phase = `edit${index + 1}`;
      const id = path.basename(imagePath, '.jpg');
      const description = `Synthetic edit ${index + 1}`;
      await measure(phase, () => warm.editDescription(async image => {
        assert.equal(image.id, id);
        assert.equal(image.description, caption);
        return description;
      }, id));
      assert.equal(phases[phase].imageReads, 2, phase);
      assert.equal(phases[phase].captionReads, 0, phase);
      assert.equal(phases[phase].inspections, 2, phase);
      assert.equal(phases[phase].captionWrites, 1, phase);
      assert.equal(await codec.readDescription(await readFile(path.join(root, imagePath))), description);
    }
    await writeFile(receiptPath, JSON.stringify({...receipt, status: 'PASS'}, null, 2) + '\n');
    console.log(await readFile(receiptPath, 'utf8'));
  } catch (error) {
    await writeFile(receiptPath, JSON.stringify({...receipt, status: 'FAIL', error: String(error)}, null, 2) + '\n');
    throw error;
  }
}

function counters() {
  return {cacheReads: 0, imageReads: 0, imageBytes: 0, captionReads: 0, inspections: 0, captionWrites: 0};
}

const executable = process.env.EXIFTOOL;
assert.ok(executable && path.isAbsolute(executable), 'Set EXIFTOOL to an absolute executable path');
const version = (await run(executable, ['-config', '', '-ver'], {timeout: 5_000})).stdout.trim();
assert.ok(SUPPORTED_EXIFTOOL_VERSIONS.includes(version), `Unsupported ExifTool ${version}`);
const root = await createTestVault(undefined, executable);
console.error(`Generated benchmark vault: ${root}`);
await benchmark(root, executable, version);
