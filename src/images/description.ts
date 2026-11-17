import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { detectImageFormat, sha256 } from './media';

export const SUPPORTED_EXIFTOOL_VERSIONS: readonly string[] = ['13.58', '13.63'];
const SUPPORTED_VERSIONS_TEXT = SUPPORTED_EXIFTOOL_VERSIONS.join(' or ');
const NORMALIZED_DESCRIPTION = 'Image Ledger fingerprint prototype';
const NORMALIZED_TOOLKIT = 'Image::ExifTool 13.58';
const DESCRIPTION_TAG = '-XMP-dc:Description-x-default=';
const execute = promisify(execFile);

export interface DescriptionCodec {
  readDescription(bytes: Uint8Array): Promise<string>;
  inspect(bytes: Uint8Array): Promise<{id: string; description: string}>;
  describe(bytes: Uint8Array, description: string): Promise<Uint8Array>;
}

export function createDescriptionCodec(executable: string): DescriptionCodec {
  async function run(...args: string[]): Promise<string> {
    try {
      const result = await execute(executable, ['-config', '', ...args], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 15_000,
        windowsHide: true,
      });
      return result.stdout;
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      throw new Error(`ExifTool failed. Install version ${SUPPORTED_VERSIONS_TEXT} and check the executable path in Image Ledger settings. ${details}`);
    }
  }

  async function checkVersion(): Promise<void> {
    const version = (await run('-ver')).trim();
    if (!SUPPORTED_EXIFTOOL_VERSIONS.includes(version)) {
      throw new Error(`Image Ledger supports ExifTool ${SUPPORTED_VERSIONS_TEXT}, but found ${version}. Normalized image IDs depend on compatible output.`);
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

  async function fingerprint(file: string, destination: string): Promise<string> {
    // Keep the original 13.58 stamp in the fingerprint copy so existing IDs stay valid.
    await run(DESCRIPTION_TAG + NORMALIZED_DESCRIPTION, `-XMP-x:XMPToolkit=${NORMALIZED_TOOLKIT}`, '-o', destination, file);
    return sha256(await readFile(destination));
  }

  async function preservedData(file: string): Promise<Record<string, unknown>> {
    const [data] = JSON.parse(await run('-j', '-b', '-api', 'ImageHashType=SHA256',
      '-ImageDataHash', '-EXIF', '-ICC_Profile', '-MPImage2', file));
    if (!data || !/^[a-f0-9]{64}$/i.test(data.ImageDataHash ?? '')) {
      throw new Error('ExifTool could not verify the encoded image data. The image was not saved.');
    }
    const { SourceFile, ...metadata } = data;
    return metadata;
  }

  return {
    readDescription: bytes => withSource(bytes, source => caption(source)),
    inspect: bytes => withSource(bytes, async (source, directory, extension) => {
      await checkVersion();
      const description = await caption(source);
      const id = await fingerprint(source, join(directory, `normalized.${extension}`));
      return {id, description};
    }),
    describe: (bytes, description) => withSource(bytes, async (source, directory, extension) => {
      await checkVersion();
      if (typeof description !== 'string' || description.includes('\0')) {
        throw new Error('The image description must be text without null characters.');
      }
      const original = await preservedData(source);
      const id = await fingerprint(source, join(directory, `normalized-before.${extension}`));
      const destination = join(directory, `described.${extension}`);
      await run('-P', DESCRIPTION_TAG + description, '-o', destination, source);
      if (await caption(destination) !== description) {
        throw new Error('Embedded description verification failed. The image was not saved.');
      }
      if (await fingerprint(destination, join(directory, `normalized-after.${extension}`)) !== id) {
        throw new Error('The normalized image ID changed while saving the description. The image was not saved.');
      }
      const actual = await preservedData(destination);
      for (const key of new Set([...Object.keys(original), ...Object.keys(actual)])) {
        if (original[key] !== actual[key]) {
          throw new Error(`Image metadata verification failed for ${key}. The image was not saved.`);
        }
      }
      return readFile(destination);
    }),
  };
}
