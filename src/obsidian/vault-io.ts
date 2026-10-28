import { FileSystemAdapter, TFile, type Vault } from 'obsidian';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VaultIO } from '../images/store';

export function createVaultIO(vault: Vault): VaultIO {
  if (!(vault.adapter instanceof FileSystemAdapter)) {
    throw new Error('Image Ledger currently requires a desktop filesystem vault.');
  }
  const basePath = vault.adapter.getBasePath();
  const resolve = (relative: string) => {
    const full = path.resolve(basePath, relative);
    if (full === basePath || !full.startsWith(basePath + path.sep) || relative.includes('\\')) {
      throw new Error('Invalid vault media path.');
    }
    return full;
  };
  const folder = async (relative: string) => {
    const segments = relative.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current += (current ? '/' : '') + segment;
      if (!await vault.adapter.exists(current)) {
        try {
          await vault.createFolder(current);
        } catch (error) {
          if (!await vault.adapter.exists(current)) throw error;
        }
      }
    }
  };
  const durableHiddenWrite = async (relative: string, data: Uint8Array | string) => {
    const destination = resolve(relative);
    await mkdir(path.dirname(destination), {recursive: true});
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  };

  return {
    exists: p => vault.adapter.exists(p),
    read: p => vault.adapter.read(p),
    readBinary: async p => new Uint8Array(await vault.adapter.readBinary(p)),
    mkdir: folder,
    write: async (p, text) => {
      if (p.startsWith('.image-ledger/')) return durableHiddenWrite(p, text);
      const file = vault.getAbstractFileByPath(p);
      if (file instanceof TFile) {
        if (await vault.read(file) !== text) await vault.modify(file, text);
      } else {
        await vault.create(p, text);
      }
    },
    process: async (p, update) => {
      const file = vault.getAbstractFileByPath(p);
      if (!(file instanceof TFile)) throw new Error(`Image record no longer exists: ${p}`);
      await vault.process(file, update);
    },
    writeBinary: async (p, bytes, mtime) => {
      if (p.startsWith('.image-ledger/')) return durableHiddenWrite(p, bytes);
      if (await vault.adapter.exists(p)) {
        throw new Error(`Refusing to overwrite existing image: ${p}`);
      }
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const temporary = `${p}.${randomUUID()}.tmp`;
      if (await vault.adapter.exists(temporary)) {
        throw new Error(`Refusing to overwrite existing temporary image: ${temporary}`);
      }
      try {
        const file = await vault.createBinary(temporary, buffer, mtime ? {mtime} : undefined);
        if (!Buffer.from(await vault.readBinary(file)).equals(bytes)) {
          throw new Error('Image write verification failed. The capture is still staged for recovery.');
        }
        if (await vault.adapter.exists(p)) {
          throw new Error(`Refusing to overwrite existing image: ${p}`);
        }
        await vault.rename(file, p);
      } catch (error) {
        try {
          const file = vault.getAbstractFileByPath(temporary);
          if (file instanceof TFile) await vault.delete(file);
          else if (await vault.adapter.exists(temporary)) await vault.adapter.remove(temporary);
        } catch {
          // Keep the original write error if cleanup also fails.
        }
        throw error;
      }
    },
    remove: async p => {
      if (!/^\.image-ledger\/(?:staging\/[0-9a-f-]{36}\.(?:json|jpg|png)|operations\/[0-9a-f-]{36}\.json)$/.test(p)) {
        throw new Error('Only staging files and image save receipts may be removed automatically.');
      }
      try {
        await unlink(resolve(p));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
    recordPaths: async () => vault.getMarkdownFiles()
      .filter(file => /(?:^|\/)image-records\/[^/]+\.md$/.test(file.path))
      .map(file => file.path),
    pendingPaths: async () => await vault.adapter.exists('.image-ledger/staging')
      ? (await vault.adapter.list('.image-ledger/staging')).files
      : [],
    operationPaths: async () => await vault.adapter.exists('.image-ledger/operations')
      ? (await vault.adapter.list('.image-ledger/operations')).files.filter(file => file.endsWith('.json'))
      : [],
  };
}
