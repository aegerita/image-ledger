import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

type HostModules = {
  createVaultIO: typeof import('../src/obsidian/vault-io').createVaultIO;
  RecordLibrary: typeof import('../src/obsidian/library').RecordLibrary;
  NoteImages: typeof import('../src/obsidian/notes').NoteImages;
  MediaStore: typeof import('../src/images/store').MediaStore;
  TFile: typeof import('obsidian').TFile;
  FileSystemAdapter: typeof import('obsidian').FileSystemAdapter;
};

export async function loadHostModules(): Promise<HostModules> {
  const bundled = await build({
    stdin: {
      contents: `
        export {createVaultIO} from './src/obsidian/vault-io';
        export {RecordLibrary} from './src/obsidian/library';
        export {NoteImages} from './src/obsidian/notes';
        export {MediaStore} from './src/images/store';
        export {TFile, FileSystemAdapter} from 'obsidian';
      `,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'host-test-entry.ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['@codemirror/*'],
    plugins: [{
      name: 'obsidian-test-runtime',
      setup(builder) {
        builder.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian', namespace: 'host-test'}));
        builder.onLoad({filter: /.*/, namespace: 'host-test'}, () => ({contents: `
          export class TFile {}
          export class FileSystemAdapter {}
          export class Modal { constructor(app) { this.app = app; } open() {} close() { this.onClose?.(); } }
          export class PluginSettingTab {}
          export class Setting {}
          export class Notice {}
          export const editorInfoField = undefined;
        `}));
      },
    }],
  });
  const loaded = {exports: {}};
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
    createRequire(import.meta.url), loaded, loaded.exports);
  return loaded.exports as HostModules;
}
