import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTestVault, markerName, sourceNote, otherNote } from '../scripts/test-vault';
import { extractMetadata, sha256 } from '../src/media';

test('test vault contains only synthetic inputs, isolated settings and the current build', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'journal-media-setup-'));
  try {
    const vault = await createTestVault(path.join(parent, 'vault'));
    assert.deepEqual((await readdir(vault)).sort(), ['.journal-media-test-vault.json', '.obsidian', '2026', '2027', 'README.md', 'fixtures']);
    assert.deepEqual(JSON.parse(await readFile(path.join(vault, '.obsidian/community-plugins.json'), 'utf8')), ['journal-media']);
    const marker = JSON.parse(await readFile(path.join(vault, markerName), 'utf8'));
    assert.deepEqual(Object.keys(marker.fixtures).sort(), ['sample-exif.jpg', 'sample.png']);
    for (const [file, hash] of Object.entries(marker.fixtures)) assert.equal(sha256(await readFile(path.join(vault, 'fixtures', file))), hash);
    const metadata = await extractMetadata(await readFile(path.join(vault, 'fixtures/sample-exif.jpg')));
    assert.equal(metadata.capturedAt, '2026-10-17T12:34:56.0074-04:00');
    for (const file of ['main.js', 'manifest.json', 'styles.css']) assert.deepEqual(await readFile(path.join(vault, '.obsidian/plugins/journal-media', file)), await readFile(new URL(`../${file}`, import.meta.url)));
    for (const note of [sourceNote, otherNote]) assert.match(await readFile(path.join(vault, note), 'utf8'), /Only generated fixtures/);
  } finally { await rm(parent, {recursive: true, force: true}); }
});

test('test vault setup refuses existing folders and symlinks without changing them', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'journal-media-setup-'));
  try {
    await writeFile(path.join(parent, 'sentinel.md'), 'keep');
    await assert.rejects(createTestVault(parent), {code: 'EEXIST'});
    await assert.rejects(createTestVault(path.join(parent, 'sentinel.md')), {code: 'EEXIST'});
    await symlink(parent, path.join(parent, 'linked-vault'));
    await assert.rejects(createTestVault(path.join(parent, 'linked-vault')), {code: 'EEXIST'});
    assert.equal(await readFile(path.join(parent, 'sentinel.md'), 'utf8'), 'keep');
    assert.deepEqual((await readdir(parent)).sort(), ['linked-vault', 'sentinel.md']);
  } finally { await rm(parent, {recursive: true, force: true}); }
});
