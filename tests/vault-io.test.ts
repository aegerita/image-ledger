import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DataWriteOptions, TFile as HostFile, Vault } from 'obsidian';
import { loadHostModules } from './host-modules';

const {createVaultIO, TFile, FileSystemAdapter} = await loadHostModules();
const destination = 'images/photo.png';
const payload = new Uint8Array([7, 1, 2, 3, 9]).subarray(1, 4);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-ledger-vault-io-'));
  const bytes = new Map<string, Uint8Array>();
  const indexed = new Map<string, HostFile>();
  const created: {path: string; options?: DataWriteOptions}[] = [];
  const removed: string[] = [];
  const renamed: string[] = [];
  const faults: {
    partial?: Error;
    tempConflict?: Uint8Array;
    unindexedPartial?: boolean;
    corrupt?: boolean;
    lateConflict?: Uint8Array;
    rename?: Error;
    cleanup?: Error;
  } = {};
  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => root;
  adapter.exists = async relative => {
    if (relative.endsWith('.tmp') && faults.tempConflict) bytes.set(relative, faults.tempConflict.slice());
    return bytes.has(relative);
  };
  adapter.remove = async relative => {
    removed.push(relative);
    bytes.delete(relative);
    indexed.delete(relative);
  };
  const vault = {
    adapter,
    getAbstractFileByPath: (relative: string) => indexed.get(relative) ?? null,
    createBinary: async (relative: string, data: ArrayBuffer, options?: DataWriteOptions) => {
      assert.equal(bytes.has(relative), false, 'The temporary path must be new');
      created.push({path: relative, options});
      const file = Object.assign(new TFile(), {path: relative});
      if (!faults.unindexedPartial) indexed.set(relative, file);
      if (faults.partial) {
        bytes.set(relative, new Uint8Array(data).slice(0, 1));
        throw faults.partial;
      }
      bytes.set(relative, new Uint8Array(data).slice());
      return file;
    },
    readBinary: async (file: HostFile) => {
      const content = bytes.get(file.path)!.slice();
      if (faults.corrupt) content[0] ^= 1;
      if (faults.lateConflict) bytes.set(destination, faults.lateConflict.slice());
      return content.buffer;
    },
    rename: async (file: HostFile, relative: string) => {
      renamed.push(relative);
      if (faults.rename) throw faults.rename;
      assert.equal(bytes.has(relative), false, 'Rename must not replace a user file');
      bytes.set(relative, bytes.get(file.path)!);
      bytes.delete(file.path);
      indexed.delete(file.path);
      file.path = relative;
      indexed.set(relative, file);
    },
    delete: async (file: HostFile) => {
      removed.push(file.path);
      if (faults.cleanup) throw faults.cleanup;
      bytes.delete(file.path);
      indexed.delete(file.path);
    },
  } as unknown as Vault;
  return {
    io: createVaultIO(vault), root, bytes, created, removed, renamed, faults,
    cleanup: () => rm(root, {recursive: true, force: true}),
  };
}

test('a partial image write leaves no final file and can be retried safely', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const failure = new Error('Disk became full');
  f.faults.partial = failure;
  await assert.rejects(f.io.writeBinary(destination, payload), error => error === failure);
  assert.equal(f.bytes.has(destination), false);
  assert.equal(f.bytes.size, 0);
  assert.deepEqual(f.removed, [f.created[0].path]);
  assert.equal(path.posix.dirname(f.created[0].path), path.posix.dirname(destination));

  f.faults.partial = undefined;
  await f.io.writeBinary(destination, payload, 12345);
  assert.deepEqual([...f.bytes.keys()], [destination]);
  assert.deepEqual(f.bytes.get(destination), payload);
  assert.notEqual(f.created[0].path, f.created[1].path);
  assert.deepEqual(f.created[1].options, {mtime: 12345});
  assert.deepEqual(f.renamed, [destination]);
});

test('a failed create cleans its unindexed partial temporary file', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  f.faults.partial = new Error('Interrupted before indexing');
  f.faults.unindexedPartial = true;
  await assert.rejects(f.io.writeBinary(destination, payload), /Interrupted before indexing/);
  assert.equal(f.bytes.size, 0);
  assert.deepEqual(f.removed, [f.created[0].path]);
});

test('a verification mismatch cannot publish an image', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  f.faults.corrupt = true;
  await assert.rejects(f.io.writeBinary(destination, payload), /Image write verification failed/);
  assert.equal(f.bytes.size, 0);
  assert.deepEqual(f.renamed, []);
  assert.deepEqual(f.removed, [f.created[0].path]);
});

test('existing and late-arriving final files remain untouched', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const original = new Uint8Array([9, 8, 7]);
  f.bytes.set(destination, original);
  await assert.rejects(f.io.writeBinary(destination, payload), /Refusing to overwrite existing image/);
  assert.deepEqual(f.bytes.get(destination), original);
  assert.equal(f.created.length, 0);

  f.bytes.delete(destination);
  f.faults.lateConflict = original;
  await assert.rejects(f.io.writeBinary(destination, payload), /Refusing to overwrite existing image/);
  assert.deepEqual([...f.bytes.keys()], [destination]);
  assert.deepEqual(f.bytes.get(destination), original);
  assert.deepEqual(f.renamed, []);
  assert.deepEqual(f.removed, [f.created[0].path]);
});

test('a preexisting temporary path is never claimed or cleaned up', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const original = new Uint8Array([9, 8, 7]);
  f.faults.tempConflict = original;
  await assert.rejects(f.io.writeBinary(destination, payload), /Refusing to overwrite existing temporary image/);
  assert.equal(f.created.length, 0);
  assert.deepEqual(f.removed, []);
  assert.deepEqual([...f.bytes.values()], [original]);
});

test('cleanup failures keep the original error and never delete unrelated images', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const failure = new Error('Rename failed');
  const unrelated = 'images/keep.png';
  f.bytes.set(unrelated, payload.slice());
  f.faults.rename = failure;
  f.faults.cleanup = new Error('Cleanup also failed');
  await assert.rejects(f.io.writeBinary(destination, payload), error => error === failure);
  assert.equal(f.bytes.has(destination), false);
  assert.deepEqual(f.bytes.get(unrelated), payload);
  assert.deepEqual(f.removed, [f.created[0].path]);
});

test('hidden staging writes and removal guards retain their current behavior', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const staged = '.image-ledger/staging/00000000-0000-4000-8000-000000000000.png';
  await f.io.writeBinary(staged, payload);
  assert.deepEqual(new Uint8Array(await readFile(path.join(f.root, staged))), payload);
  assert.equal(f.created.length, 0);
  await assert.rejects(f.io.writeBinary('.image-ledger/../../outside.png', payload), /Invalid vault media path/);
  await assert.rejects(f.io.remove(destination), /Only staging files may be removed automatically/);
  await f.io.remove(staged);
  await assert.rejects(readFile(path.join(f.root, staged)), {code: 'ENOENT'});
});
