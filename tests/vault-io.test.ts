import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vault } from 'obsidian';
import { loadHostModules } from './host-modules';
import { sha256 } from '../src/images/media';
import { PNG } from './fixtures';

const {createVaultIO, TFile, FileSystemAdapter} = await loadHostModules();
const imagePath = `images/${'a'.repeat(64)}.png`;
const staging = '.image-ledger/staging/11111111-2222-4333-8444-555555555555.json';

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await mkdtemp(join(tmpdir(), 'image-ledger-fs-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => root;
  const file = Object.assign(new TFile(), {path: imagePath});
  let trashOption = 'local';
  const vault = {adapter, getConfig: () => trashOption, getFiles: () => [file],
    getAbstractFileByPath: (path: string) => path === imagePath ? file : null} as unknown as Vault;
  const io = createVaultIO(vault, {trashFile: item => rename(join(root, item.path), join(root, 'trashed.png'))});
  return {io, root, setTrash: (value: string) => { trashOption = value; }};
}

test('concurrent file publication accepts one writer and leaves a complete image', async t => {
  const f = await fixture(t);
  const other = Buffer.concat([PNG, Buffer.from('other')]);
  const results = await Promise.allSettled([f.io.writeBinary(imagePath, PNG), f.io.writeBinary(imagePath, other)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const saved = await readFile(join(f.root, imagePath));
  assert(saved.equals(results[0].status === 'fulfilled' ? PNG : other));
  assert.equal((await readdir(join(f.root, 'images'))).length, 1);
});

test('caption file replacement verifies the exact original bytes and leaves no temporary files', async t => {
  const f = await fixture(t);
  await f.io.writeBinary(imagePath, PNG, 12345);
  assert.equal((await stat(join(f.root, imagePath))).mtimeMs, 12345);
  const updated = Buffer.concat([PNG, Buffer.from('updated')]);
  await f.io.replaceBinary(imagePath, sha256(PNG), updated);
  await assert.rejects(f.io.replaceBinary(imagePath, sha256(PNG), PNG), /changed/);
  assert.deepEqual(await readFile(join(f.root, imagePath)), updated);
  assert.equal((await readdir(join(f.root, 'images'))).length, 1);
});

test('receipts are writable and removable only in their allowed hidden paths', async t => {
  const f = await fixture(t);
  await f.io.write(staging, '{"state":"prepared"}');
  await f.io.write(staging, '{"state":"saved"}');
  assert.equal(await f.io.read(staging), '{"state":"saved"}');
  assert.deepEqual(await f.io.pendingPaths(), [staging]);
  await assert.rejects(f.io.remove(imagePath), /Only current staging/);
  await assert.rejects(f.io.write('Note.md', 'changed'), /Only current staging/);
  await f.io.remove(staging);
  assert.deepEqual(await f.io.pendingPaths(), []);
});

test('vault writes and removals reject traversal and symlinked destinations', async t => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'image-ledger-fs-outside-'));
  t.after(() => rm(outside, {recursive: true, force: true}));
  await symlink(outside, join(f.root, 'images'));
  await writeFile(join(outside, 'untouched.png'), PNG);
  await assert.rejects(f.io.writeBinary(imagePath, PNG), /symlinked/);
  await assert.rejects(f.io.readBinary('images/untouched.png'), /symlinked/);
  await assert.rejects(f.io.readBinary('../outside.png'), /traversal/);
  await assert.rejects(f.io.trash(imagePath), /symlinked/);
  assert.deepEqual(await readdir(outside), ['untouched.png']);
});

test('deletion uses the configured recoverable host Trash', async t => {
  const f = await fixture(t);
  await f.io.writeBinary(imagePath, PNG);
  f.setTrash('none');
  await assert.rejects(f.io.trash(imagePath), /Deleted files/);
  assert.equal(await f.io.exists(imagePath), true);
  f.setTrash('system');
  await f.io.trash(imagePath);
  assert.equal(await f.io.exists(imagePath), false);
  assert.deepEqual(await readFile(join(f.root, 'trashed.png')), PNG);
});
