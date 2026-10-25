import esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
const exifrLicense = await readFile(new URL('./node_modules/exifr/LICENSE', import.meta.url), 'utf8');
const config = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', 'node:*', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  outfile: 'main.js',
  sourcemap: process.argv.includes('--watch') ? 'inline' : false,
  logLevel: 'info',
  banner: {js: `/* Image Ledger: built from source. See README.md. */\n/*! Bundled exifr license:\n${exifrLicense}\n*/`},
};
if (process.argv.includes('--watch')) {
  const context = await esbuild.context(config);
  await context.watch();
} else {
  await esbuild.build(config);
}
