import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/images/media';
import { PNG, jpegWithExif } from '../tests/fixtures';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const markerName = '.image-ledger-test-vault.json';
export const sourceNote = 'Projects/Research.md';
export const otherNote = '2027/01/2027-01-04.md';

export async function createTestVault(destination?: string): Promise<string> {
  const artifacts = ['main.js', 'manifest.json', 'styles.css'];
  // Check the build before creating anything; never copy an installed personal-vault plugin.
  await Promise.all(artifacts.map(file => readFile(path.join(repo, file))));
  let vault: string;
  if (destination) {
    vault = path.resolve(destination);
    await mkdir(vault); // An existing directory, file or symlink must fail without changes.
  } else {
    const parent = path.join(repo, 'test-vaults');
    await mkdir(parent, {recursive: true});
    vault = await mkdtemp(path.join(parent, 'ImageLedger-'));
  }
  for (const folder of ['.obsidian/plugins/image-ledger', 'fixtures', 'Projects', '2027/01']) {
    await mkdir(path.join(vault, folder), {recursive: true});
  }
  for (const file of artifacts) await copyFile(path.join(repo, file), path.join(vault, '.obsidian/plugins/image-ledger', file));
  const fixtures = {'sample.png': PNG, 'sample-exif.jpg': jpegWithExif({offset: '-04:00', subsecond: '0074'})};
  for (const [name, bytes] of Object.entries(fixtures)) await writeFile(path.join(vault, 'fixtures', name), bytes);
  await writeFile(path.join(vault, '.obsidian/community-plugins.json'), JSON.stringify(['image-ledger']));
  await writeFile(path.join(vault, '.obsidian/core-plugins.json'), JSON.stringify(['file-explorer', 'switcher', 'command-palette', 'bases']));
  await writeFile(path.join(vault, '.obsidian/app.json'), JSON.stringify({livePreview: true}));
  for (const note of [sourceNote, otherNote]) await writeFile(path.join(vault, note), `# Synthetic media test\n\nOnly generated fixtures belong in this vault.\n\n`);
  await writeFile(path.join(vault, 'README.md'), '# Image Ledger test vault\n\nSynthetic data only. No personal contents or settings were copied.\nDefault smoke test: npm run test:obsidian (Obsidian host API only). Computer use is prohibited. See the repository AGENTS.md and TESTING.md.\n');
  await writeFile(path.join(vault, markerName), JSON.stringify({version: 1, fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, bytes]) => [name, sha256(bytes)]))}, null, 2) + '\n');
  return vault;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--vault' || !args[1])) throw new Error('Usage: npm run test:vault -- [--vault /new/path]');
  const vault = await createTestVault(args[1]);
  console.log(`Created synthetic test vault: ${vault}\nFor routine live verification run npm run test:obsidian; it creates and opens its own isolated vault.\nUse Obsidian host APIs only. Computer use is prohibited.\nSee AGENTS.md and TESTING.md for the current verification policy.`);
}
