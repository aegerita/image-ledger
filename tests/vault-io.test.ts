import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Vault } from 'obsidian';
import { loadHostModules } from './host-modules';
import { sha256 } from '../src/images/media';
import { operationPath } from '../src/images/operations';
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

test('caption file replacement preserves dates, verifies original bytes, and leaves no temporary files', async t => {
  const f = await fixture(t);
  const destination = join(f.root, imagePath);
  await f.io.writeBinary(imagePath, PNG, 12345);
  assert.equal((await stat(destination)).mtimeMs, 12345);
  const modified = new Date(67890);
  await utimes(destination, modified, modified);
  const original = await stat(destination, {bigint: true});
  if (process.platform === 'darwin') assert.notEqual(original.birthtimeNs, original.mtimeNs);

  const updated = Buffer.concat([PNG, Buffer.from('updated')]);
  await f.io.replaceBinary(imagePath, sha256(PNG), updated);
  const saved = await stat(destination, {bigint: true});
  assert.notEqual(saved.ino, original.ino);
  assert.ok(Math.abs(Number(saved.mtimeNs - original.mtimeNs)) < 1000, 'Modification date changed');
  if (process.platform === 'darwin') {
    assert.ok(Math.abs(Number(saved.birthtimeNs - original.birthtimeNs)) < 1000, 'Creation date changed');
  }
  await assert.rejects(f.io.replaceBinary(imagePath, sha256(PNG), PNG), /changed/);
  assert.deepEqual(await readFile(destination), updated);
  assert.equal((await readdir(join(f.root, 'images'))).length, 1);
});

test('catalog stat detects an atomic replacement with the same size and modification time', async t => {
  const f = await fixture(t);
  assert.equal(await f.io.stat(imagePath), undefined);
  const mtime = new Date(12345);
  await f.io.writeBinary(imagePath, PNG, mtime.getTime());
  const initial = await f.io.stat(imagePath);
  assert(initial);
  assert.equal(await f.io.stat(imagePath), initial);

  const destination = join(f.root, imagePath);
  const replacement = join(f.root, 'replacement.png');
  const newBytes = Buffer.from(PNG);
  newBytes[newBytes.length - 1] ^= 1;
  await writeFile(replacement, newBytes);
  await utimes(replacement, mtime, mtime);
  await rename(replacement, destination);
  const replaced = await stat(destination);
  assert.equal(replaced.size, PNG.length);
  assert.equal(replaced.mtimeMs, mtime.getTime());
  assert.notEqual(await f.io.stat(imagePath), initial);
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
  for (const id of ['a'.repeat(64), 'b'.repeat(64)]) {
    const receipt = operationPath(id);
    await f.io.write(receipt, '{}');
    assert.deepEqual(await f.io.operationPaths(), [receipt]);
    await f.io.remove(receipt);
  }
  await assert.rejects(f.io.write(operationPath(`v3-${'a'.repeat(64)}`), '{}'), /Only current staging/);
});

test('vault writes and removals reject traversal and symlinked destinations', async t => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'image-ledger-fs-outside-'));
  t.after(() => rm(outside, {recursive: true, force: true}));
  await symlink(outside, join(f.root, 'images'));
  await writeFile(join(outside, 'untouched.png'), PNG);
  await assert.rejects(f.io.writeBinary(imagePath, PNG), /symlinked/);
  await assert.rejects(f.io.readBinary('images/untouched.png'), /symlinked/);
  await assert.rejects(f.io.stat('images/untouched.png'), /symlinked/);
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
