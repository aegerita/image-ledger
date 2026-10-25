import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createTestVault, markerName, sourceNote, otherNote } from '../scripts/test-vault';
import { extractMetadata, sha256 } from '../src/media';

test('test vault contains only synthetic inputs, isolated settings and the current build', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'image-ledger-setup-'));
  try {
    const vault = await createTestVault(path.join(parent, 'vault'));
    assert.deepEqual((await readdir(vault)).sort(), ['.image-ledger-test-vault.json', '.obsidian', '2027', 'Projects', 'README.md', 'fixtures']);
    assert.deepEqual(JSON.parse(await readFile(path.join(vault, '.obsidian/community-plugins.json'), 'utf8')), ['image-ledger']);
    const marker = JSON.parse(await readFile(path.join(vault, markerName), 'utf8'));
    assert.deepEqual(Object.keys(marker.fixtures).sort(), ['sample-exif.jpg', 'sample.png']);
    for (const [file, hash] of Object.entries(marker.fixtures)) assert.equal(sha256(await readFile(path.join(vault, 'fixtures', file))), hash);
    const metadata = await extractMetadata(await readFile(path.join(vault, 'fixtures/sample-exif.jpg')));
    assert.equal(metadata.capturedAt, '2026-10-17T12:34:56.0074-04:00');
    for (const file of ['main.js', 'manifest.json', 'styles.css']) assert.deepEqual(await readFile(path.join(vault, '.obsidian/plugins/image-ledger', file)), await readFile(new URL(`../${file}`, import.meta.url)));
    for (const note of [sourceNote, otherNote]) assert.match(await readFile(path.join(vault, note), 'utf8'), /Only generated fixtures/);
  } finally { await rm(parent, {recursive: true, force: true}); }
});

test('test vault setup refuses existing folders and symlinks without changing them', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'image-ledger-setup-'));
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

test('installer preserves settings and unrelated plugins, enabling Image Ledger only when requested', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'image-ledger-install-'));
  try {
    const vault = await createTestVault(path.join(parent, 'vault'));
    const dataPath = path.join(vault, '.obsidian/plugins/image-ledger/data.json');
    const existingData = JSON.stringify({storageLayout: 'flat', interceptPaste: true});
    await writeFile(dataPath, existingData);
    const enabledPath = path.join(vault, '.obsidian/community-plugins.json');
    const originalEnabled = JSON.stringify(['keep-plugin', 'obsidian-imgur-plugin']);
    await writeFile(enabledPath, originalEnabled);
    const install = (...args: string[]) => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/install.mjs', import.meta.url)), '--vault', vault, ...args]);
    await install();
    assert.equal(await readFile(dataPath, 'utf8'), existingData);
    assert.equal(await readFile(enabledPath, 'utf8'), originalEnabled, 'Installing must not change enabled plugins without --enable');
    await install('--enable');
    assert.deepEqual(JSON.parse(await readFile(enabledPath, 'utf8')), ['keep-plugin', 'image-ledger']);
    assert.equal(await readFile(dataPath, 'utf8'), existingData, 'An upgrade must not overwrite existing Image Ledger settings');
    const backup = path.join(vault, '.image-ledger/community-plugins.before-image-ledger.json');
    assert.equal(await readFile(backup, 'utf8'), originalEnabled);
    await install('--enable');
    assert.equal(await readFile(backup, 'utf8'), originalEnabled, 'Repeated installs must preserve the original enabled-plugin backup');
  } finally {await rm(parent, {recursive: true, force: true});}
});
