import esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
const licenses = await Promise.all(['exifr', '@lezer/markdown', '@lezer/common', '@lezer/highlight'].map(async name => {
  const license = await readFile(new URL(`./node_modules/${name}/LICENSE`, import.meta.url), 'utf8');
  return `/*! Bundled ${name} license:\n${license}\n*/`;
}));
const config = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', 'node:*', '@codemirror/*'],
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  outfile: 'main.js',
  sourcemap: process.argv.includes('--watch') ? 'inline' : false,
  logLevel: 'info',
  banner: {js: `/* Image Ledger: built from source. See README.md. */\n${licenses.join('\n')}`},
};
if (process.argv.includes('--watch')) {
  const context = await esbuild.context(config);
  await context.watch();
} else {
  await esbuild.build(config);
}
