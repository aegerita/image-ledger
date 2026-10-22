import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/media';
import { PNG, jpegWithExif } from '../tests/fixtures';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const markerName = '.journal-media-test-vault.json';
export const sourceNote = '2026/10/2026-10-17.md';
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
    vault = await mkdtemp(path.join(parent, 'JournalMedia-'));
  }
  for (const folder of ['.obsidian/plugins/journal-media', 'fixtures', '2026/10', '2027/01']) {
    await mkdir(path.join(vault, folder), {recursive: true});
  }
  for (const file of artifacts) await copyFile(path.join(repo, file), path.join(vault, '.obsidian/plugins/journal-media', file));
  const fixtures = {'sample.png': PNG, 'sample-exif.jpg': jpegWithExif({offset: '-04:00', subsecond: '0074'})};
  for (const [name, bytes] of Object.entries(fixtures)) await writeFile(path.join(vault, 'fixtures', name), bytes);
  await writeFile(path.join(vault, '.obsidian/community-plugins.json'), JSON.stringify(['journal-media']));
  await writeFile(path.join(vault, '.obsidian/core-plugins.json'), JSON.stringify(['file-explorer', 'switcher', 'command-palette', 'bases']));
  await writeFile(path.join(vault, '.obsidian/app.json'), JSON.stringify({livePreview: true}));
  for (const note of [sourceNote, otherNote]) await writeFile(path.join(vault, note), `# Synthetic media test\n\nOnly generated fixtures belong in this vault.\n\n`);
  await writeFile(path.join(vault, 'README.md'), '# Journal Media test vault\n\nSynthetic data only. No journal contents or settings were copied.\nSee the repository TESTING.md for the computer-use protocol.\n');
  await writeFile(path.join(vault, markerName), JSON.stringify({version: 1, fixtures: Object.fromEntries(Object.entries(fixtures).map(([name, bytes]) => [name, sha256(bytes)]))}, null, 2) + '\n');
  return vault;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--vault' || !args[1])) throw new Error('Usage: npm run test:vault -- [--vault /new/path]');
  const vault = await createTestVault(args[1]);
  console.log(`Created synthetic test vault: ${vault}\nOpen this folder as a vault in Obsidian, then enable Journal Media in this test vault only.\nFollow the computer-use protocol in TESTING.md and record PASS, FAIL or NOT RUN for each step.`);
}
