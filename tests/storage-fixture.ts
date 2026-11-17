import assert from 'node:assert/strict';
import { MediaStore, type VaultIO } from '../src/images/store';
import type { DescriptionCodec } from '../src/images/description';
import { sha256 } from '../src/images/media';
import { DEFAULTS } from '../src/settings';

const marker = Buffer.from('\0image-ledger-test-caption\0');
function unpack(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  const split = buffer.indexOf(marker);
  return {base: split < 0 ? buffer : buffer.subarray(0, split), description: split < 0 ? '' : buffer.subarray(split + marker.length).toString()};
}

export const codec: DescriptionCodec = {
  readDescription: async bytes => unpack(bytes).description,
  inspect: async bytes => {
    const {base, description} = unpack(bytes);
    return {id: sha256(base), description};
  },
  describe: async (bytes, description) => Buffer.concat([unpack(bytes).base, marker, Buffer.from(description)]),
};

export function storageFixture() {
  const files = new Map<string, Uint8Array>();
  const revisions = new WeakMap<Uint8Array, number>();
  let nextRevision = 0;
  const trashed: string[] = [];
  const faults = {trash: false, removeReceipt: false};
  const io: VaultIO = {
    checkTrash: () => {},
    exists: async path => files.has(path),
    stat: async path => {
      const bytes = files.get(path);
      if (!bytes) return undefined;
      if (!revisions.has(bytes)) revisions.set(bytes, ++nextRevision);
      return String(revisions.get(bytes));
    },
    read: async path => {
      if (!files.has(path)) throw new Error('Missing file');
      return Buffer.from(files.get(path)!).toString();
    },
    write: async (path, text) => { files.set(path, Buffer.from(text)); },
    readBinary: async path => {
      if (!files.has(path)) throw new Error('Missing file');
      return files.get(path)!.slice();
    },
    writeBinary: async (path, bytes) => {
      if (files.has(path)) throw new Error('Existing image');
      files.set(path, bytes.slice());
    },
    replaceBinary: async (path, checksum, bytes) => {
      assert.equal(sha256(files.get(path)!), checksum, 'Image changed');
      files.set(path, bytes.slice());
    },
    remove: async path => {
      if (faults.removeReceipt && path.endsWith('.json')) throw new Error('Receipt cleanup failed');
      files.delete(path);
    },
    trash: async path => {
      if (faults.trash) throw new Error('Trash unavailable');
      trashed.push(path);
      files.delete(path);
    },
    mediaPaths: async () => [...files.keys()].filter(path => !path.startsWith('.') && /\.(jpg|png)$/.test(path)),
    pendingPaths: async () => [...files.keys()].filter(path => path.startsWith('.image-ledger/staging/')),
    operationPaths: async () => [...files.keys()].filter(path => path.startsWith('.image-ledger/operations/')),
  };
  return {io, files, trashed, faults, store: new MediaStore(io, DEFAULTS, codec)};
}
