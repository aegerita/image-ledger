import { FileSystemAdapter, TFile, type FileManager, type Vault } from 'obsidian';
import { lstat, link, mkdir, open, readFile, readdir, realpath, rename, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertVaultPath } from '../images/markdown';
import { sha256 } from '../images/media';
import { CATALOG_CACHE_PATH, type VaultIO } from '../images/store';

export function createVaultIO(vault: Vault, fileManager: Pick<FileManager, 'trashFile'>): VaultIO {
  if (!(vault.adapter instanceof FileSystemAdapter)) throw new Error('Image Ledger requires a desktop filesystem vault.');
  const basePath = vault.adapter.getBasePath();
  const root = realpath(basePath);

  const resolve = async (relative: string) => {
    assertVaultPath(relative);
    const base = await root;
    const destination = path.join(base, relative);
    if (!destination.startsWith(base + path.sep)) throw new Error('Invalid vault path.');
    // Reject symlinks at every boundary, including symlinked parent directories.
    let current = base;
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('Image Ledger refuses symlinked paths.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return destination;
  };

  const folder = async (relative: string) => {
    let current = '';
    for (const segment of relative.split('/')) {
      current += (current ? '/' : '') + segment;
      const destination = await resolve(current);
      try { await mkdir(destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await lstat(destination)).isDirectory()) throw new Error('A media folder is not a directory.');
      }
    }
  };

  const writeTemporary = async (destination: string, data: Uint8Array | string) => {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return temporary;
  };

  const hidden = (relative: string) => {
    if (relative === CATALOG_CACHE_PATH) return;
    if (!/^\.image-ledger\/(?:staging\/[a-f0-9-]{36}\.(?:json|jpg|png)|operations\/[a-f0-9]{64}\.json)$/.test(relative)) {
      throw new Error('Only current staging files, deletion receipts, and the catalog cache may be changed automatically.');
    }
  };

  const checkTrash = () => {
    const option = (vault as Vault & {getConfig(key: string): unknown}).getConfig('trashOption');
    if (option !== 'local' && option !== 'system') {
      throw new Error('Set Obsidian’s Deleted files setting to system Trash or the vault .trash folder before deleting images.');
    }
  };

  const list = async (relative: string) => {
    const directory = await resolve(relative);
    try { return (await readdir(directory)).map(name => `${relative}/${name}`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return [];
    }
  };

  return {
    checkTrash,
    exists: async relative => {
      try { await lstat(await resolve(relative)); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return false;
      }
    },
    stat: async relative => {
      try {
        const file = await lstat(await resolve(relative), {bigint: true});
        if (file.isSymbolicLink()) throw new Error('Image Ledger refuses symlinked paths.');
        if (!file.isFile()) throw new Error('The managed image path is not a regular file.');
        // File identity and change time catch sync replacements that preserve size and mtime.
        return [file.size, file.mtimeNs, file.ctimeNs, file.dev, file.ino].join(':');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      }
    },
    read: async relative => readFile(await resolve(relative), 'utf8'),
    readBinary: async relative => readFile(await resolve(relative)),
    write: async (relative, text) => {
      hidden(relative);
      await folder(path.posix.dirname(relative));
      const destination = await resolve(relative);
      const temporary = await writeTemporary(destination, text);
      try { await rename(temporary, destination); }
      finally { await unlink(temporary).catch(() => {}); }
    },
    writeBinary: async (relative, bytes, mtime) => {
      await folder(path.posix.dirname(relative));
      const destination = await resolve(relative);
      const temporary = await writeTemporary(destination, bytes);
      try {
        if (sha256(await readFile(temporary)) !== sha256(bytes)) throw new Error('Image write verification failed.');
        if (mtime !== undefined) await utimes(temporary, new Date(), new Date(mtime));
        // A hard link publishes the complete file without overwriting a late arrival.
        await link(temporary, destination);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
    replaceBinary: async (relative, checksum, bytes) => {
      const destination = await resolve(relative);
      if (sha256(await readFile(destination)) !== checksum) throw new Error('The image changed before its description could be saved.');
      const temporary = await writeTemporary(destination, bytes);
      try {
        if (sha256(await readFile(temporary)) !== sha256(bytes)) throw new Error('Image write verification failed.');
        await resolve(relative);
        if (sha256(await readFile(destination)) !== checksum) throw new Error('The image changed during its description save.');
        await rename(temporary, destination);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
    remove: async relative => {
      hidden(relative);
      try { await unlink(await resolve(relative)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
    trash: async relative => {
      checkTrash();
      const destination = await resolve(relative);
      const file = vault.getAbstractFileByPath(relative);
      if (!(file instanceof TFile) || !(await realpath(destination)).startsWith((await root) + path.sep)) {
        throw new Error('The image is unavailable for recoverable Trash.');
      }
      checkTrash();
      await fileManager.trashFile(file);
    },
    mediaPaths: async () => vault.getFiles().filter(file => /\.(?:jpg|png)$/.test(file.path)).map(file => file.path),
    pendingPaths: () => list('.image-ledger/staging'),
    operationPaths: async () => (await list('.image-ledger/operations')).filter(file => file.endsWith('.json')),
  };
}
