import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    getConfig: () => 'system',
    getFiles: () => [...indexed.values()],
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
    io: createVaultIO(vault, {trashFile: file => vault.delete(file)}), root, bytes, indexed, created, removed, renamed, faults,
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

test('image ID reservations are exclusive across concurrent callers and remain reserved', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = '012345abcdef';
  const results = await Promise.all([f.io.reserveId(id), f.io.reserveId(id)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await readFile(path.join(f.root, '.image-ledger/ids', id), 'utf8'), '');
  assert.equal(await f.io.reserveId(id), false);
  await assert.rejects(f.io.remove(`.image-ledger/ids/${id}`), /Only staging files and image save receipts/);
});

test('indexed image, sidecar and malformed record filenames reserve their IDs across folders', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = '012345abcdef';
  for (const file of [`1999/images/${id}.jpg`, `images/${id.toUpperCase()}.xmp`, `Archive/image-records/${id}.md`]) {
    f.indexed.set(file, Object.assign(new TFile(), {path: file}));
    assert.equal(await f.io.reserveId(id), false);
    f.indexed.delete(file);
  }
  assert.equal(await f.io.reserveId(id), true);
});

test('staging payloads and save receipts block ID reuse without being replaced', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = '012345abcdef';
  for (const file of [
    `.image-ledger/staging/${id}.json`,
    `.image-ledger/staging/${id}.jpg`,
    `.image-ledger/staging/${id}.png`,
    `.image-ledger/operations/${id}.json`,
  ]) {
    await f.io.write(file, 'Retained collision');
    assert.equal(await f.io.reserveId(id), false);
    assert.equal(await readFile(path.join(f.root, file), 'utf8'), 'Retained collision');
    await f.io.remove(file);
  }
  assert.equal(await f.io.reserveId(id), true);
});

test('ID reservation refuses invalid IDs and propagates filesystem failures', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  for (const id of ['../outside', '012345ABCDEf', '012345abcde', 'not-an-image-id']) {
    await assert.rejects(f.io.reserveId(id), /Invalid image ID/);
  }
  await writeFile(path.join(f.root, '.image-ledger'), 'Keep this file');
  await assert.rejects(f.io.reserveId('012345abcdef'), {code: 'ENOTDIR'});
  assert.equal(await readFile(path.join(f.root, '.image-ledger'), 'utf8'), 'Keep this file');
});

test('short-ID cleanup stays restricted to staging payloads and operation JSON', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const id = '012345abcdef';
  for (const file of [`.image-ledger/staging/${id}.png`, `.image-ledger/operations/${id}.json`]) {
    await f.io.write(file, 'Temporary state');
    await f.io.remove(file);
    await assert.rejects(readFile(path.join(f.root, file)), {code: 'ENOENT'});
  }
  for (const file of [
    `.image-ledger/operations/${id}.png`,
    `.image-ledger/staging/${id}.xmp`,
    `.image-ledger/staging/../${id}.json`,
    '.image-ledger/staging/000000000000000000000000000000000000.json',
    `images/${id}.png`,
  ]) {
    await assert.rejects(f.io.remove(file), /Only staging files and image save receipts/);
  }
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
  await assert.rejects(f.io.remove(destination), /Only staging files and image save receipts may be removed automatically/);
  await f.io.remove(staged);
  await assert.rejects(readFile(path.join(f.root, staged)), {code: 'ENOENT'});
});

test('save receipts use atomic hidden writes and narrowly scoped cleanup', async t => {
  const f = await fixture();
  t.after(f.cleanup);
  const receipt = '.image-ledger/operations/00000000-0000-4000-8000-000000000000.json';
  await f.io.write(receipt, '{"before":"A"}');
  await f.io.write(receipt, '{"before":"B"}');
  assert.equal(await readFile(path.join(f.root, receipt), 'utf8'), '{"before":"B"}');
  await assert.rejects(f.io.remove(receipt.replace('.json', '.png')), /Only staging files and image save receipts/);
  await f.io.remove(receipt);
  await f.io.remove(receipt);
  await assert.rejects(readFile(path.join(f.root, receipt)), {code: 'ENOENT'});
});

test('record processing uses the host atomic callback and refuses missing records', async () => {
  const file = Object.assign(new TFile(), {path: 'image-records/test.md'});
  let content = 'Newer saved content';
  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => '/synthetic-vault';
  const vault = {
    adapter,
    getConfig: () => 'system',
    getAbstractFileByPath: (relative: string) => relative === file.path ? file : null,
    process: async (target: HostFile, update: (value: string) => string) => {
      assert.equal(target, file);
      content = update(content);
    },
  } as unknown as Vault;
  const io = createVaultIO(vault, {trashFile: file => vault.delete(file)});

  await io.process(file.path, current => `${current} plus update`);
  assert.equal(content, 'Newer saved content plus update');
  await assert.rejects(io.process('image-records/missing.md', () => 'Replacement'), /no longer exists/);
  assert.equal(content, 'Newer saved content plus update');
});

test('managed deletion delegates to the host Trash API and rejects missing or escaping paths', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-ledger-trash-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'images'));
  await writeFile(path.join(root, 'images/012345abcdef.png'), payload);
  const file = Object.assign(new TFile(), {path: 'images/012345abcdef.png'});
  const trashed: HostFile[] = [];
  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => root;
  const vault = {
    adapter,
    getConfig: () => 'system',
    getAbstractFileByPath: (path: string) => path === file.path ? file : null,
  } as unknown as Vault;
  const io = createVaultIO(vault, {trashFile: async file => { trashed.push(file as HostFile); }});
  await io.trash(file.path);
  assert.deepEqual(trashed, [file]);
  await assert.rejects(io.trash('images/missing.png'), /unavailable/);
  await assert.rejects(io.trash('../outside.png'), /Invalid vault/);
  assert.equal(trashed.length, 1);
});

test('Trash refuses permanent deletion and unknown destination settings', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-ledger-trash-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'images'));
  await writeFile(path.join(root, 'images/012345abcdef.png'), payload);
  const file = Object.assign(new TFile(), {path: 'images/012345abcdef.png'});
  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => root;
  let option: unknown = 'none';
  let calls = 0;
  const vault = {
    adapter,
    getConfig: () => option,
    getAbstractFileByPath: () => file,
  } as unknown as Vault;
  const io = createVaultIO(vault, {trashFile: async () => { calls++; }});
  for (const invalid of ['none', 'unknown', undefined]) {
    option = invalid;
    await assert.rejects(io.trash(file.path), /Deleted files|Trash/);
  }
  assert.equal(calls, 0);
  for (const valid of ['system', 'local']) {
    option = valid;
    await io.trash(file.path);
  }
  assert.equal(calls, 2);
});

test('Trash refuses symlinks to files outside the vault', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-ledger-trash-link-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const vaultPath = path.join(root, 'vault');
  const external = path.join(root, 'external.png');
  await mkdir(vaultPath);
  await writeFile(external, payload);
  await symlink(external, path.join(vaultPath, '012345abcdef.png'));
  const file = Object.assign(new TFile(), {path: '012345abcdef.png'});
  const adapter = new FileSystemAdapter();
  adapter.getBasePath = () => vaultPath;
  let calls = 0;
  const vault = {
    adapter,
    getConfig: () => 'local',
    getAbstractFileByPath: () => file,
  } as unknown as Vault;
  const io = createVaultIO(vault, {trashFile: async () => { calls++; }});
  await assert.rejects(io.trash(file.path), /outside this vault/);
  assert.equal(calls, 0);
  assert.deepEqual(new Uint8Array(await readFile(external)), payload);
});
