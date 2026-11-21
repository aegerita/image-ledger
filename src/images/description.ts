import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { detectImageFormat } from './media';
import { imageIdentity } from './identity';

const DESCRIPTION_TAG = '-XMP-dc:Description-x-default=';
const execute = promisify(execFile);

export interface DescriptionCodec {
  readDescription(bytes: Uint8Array): Promise<string>;
  identity(bytes: Uint8Array): Promise<string>;
  inspect(bytes: Uint8Array): Promise<{id: string; description: string}>;
  describe(bytes: Uint8Array, description: string): Promise<Uint8Array>;
}

export function createDescriptionCodec(executable: string): DescriptionCodec {
  const env = executable === 'exiftool' && process.platform === 'darwin'
    ? {...process.env, PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(delimiter)}
    : undefined;

  async function run(...args: string[]): Promise<string> {
    try {
      const result = await execute(executable, ['-config', '', ...args], {
        encoding: 'utf8',
        env,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 15_000,
        windowsHide: true,
      });
      return result.stdout;
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      throw new Error(`ExifTool failed. Install ExifTool and check the executable path in Image Ledger settings. ${details}`);
    }
  }

  async function withSource<T>(bytes: Uint8Array, action: (source: string, directory: string, extension: string) => Promise<T>): Promise<T> {
    const extension = detectImageFormat(bytes);
    const directory = await mkdtemp(join(tmpdir(), 'image-ledger-metadata-'));
    try {
      const source = join(directory, `source.${extension}`);
      await writeFile(source, bytes, {flag: 'wx', mode: 0o600});
      return await action(source, directory, extension);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  }

  async function caption(file: string): Promise<string> {
    return run('-b', '-XMP-dc:Description', file);
  }

  return {
    readDescription: bytes => withSource(bytes, source => caption(source)),
    identity: imageIdentity,
    inspect: async bytes => {
      const id = await imageIdentity(bytes);
      const description = await withSource(bytes, caption);
      return {id, description};
    },
    describe: (bytes, description) => withSource(bytes, async (source, directory, extension) => {
      if (typeof description !== 'string' || description.includes('\0')) {
        throw new Error('The image description must be text without null characters.');
      }
      const id = await imageIdentity(bytes);
      const destination = join(directory, `described.${extension}`);
      await run('-P', DESCRIPTION_TAG + description, '-o', destination, source);
      if (await caption(destination) !== description) {
        throw new Error('Embedded description verification failed. The image was not saved.');
      }
      const saved = await readFile(destination);
      if (await imageIdentity(saved) !== id) {
        throw new Error('Encoded image data or other metadata changed while saving the description. The image was not saved.');
      }
      return saved;
    }),
  };
}
