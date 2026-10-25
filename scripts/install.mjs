import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const vaultIndex = args.indexOf('--vault');
if (vaultIndex < 0 || !args[vaultIndex + 1]) throw new Error('Usage: npm run install:vault -- --vault /absolute/path/to/vault [--enable]');
const vault = path.resolve(args[vaultIndex + 1]);
await access(path.join(vault, '.obsidian'));
const target = path.join(vault, '.obsidian/plugins/image-ledger');
await mkdir(target, {recursive: true});
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  await access(path.join(repo, file));
  await copyFile(path.join(repo, file), path.join(target, file + '.installing'));
  await rename(path.join(target, file + '.installing'), path.join(target, file));
}
const state = path.join(vault, '.image-ledger');
await mkdir(state, {recursive: true});
const ignorePath = path.join(vault, '.gitignore');
let ignore = await readFile(ignorePath, 'utf8').catch(() => '');
for (const pattern of ['images/', '.image-ledger/']) {
  if (!ignore.split(/\r?\n/).some(line => line.trim() === pattern)) ignore = `${ignore.trimEnd()}\n${pattern}\n`;
}
await writeFile(ignorePath, ignore);
if (args.includes('--enable')) {
  const configPath = path.join(vault, '.obsidian/community-plugins.json');
  const original = await readFile(configPath, 'utf8');
  const enabled = JSON.parse(original);
  if (!Array.isArray(enabled)) throw new Error('Unexpected community plugin config; enabled plugins were not changed.');
  const backupPath = path.join(state, 'community-plugins.before-image-ledger.json');
  try { await writeFile(backupPath, original, {flag: 'wx'}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const updated = [...new Set([...enabled.filter(id => id !== 'obsidian-imgur-plugin'), 'image-ledger'])];
  await writeFile(configPath, JSON.stringify(updated, null, 2) + '\n');
  console.log('Enabled Image Ledger in configuration; disabled the competing Imgur paste plugin. Reload Obsidian or enable the plugin in its UI.');
}
console.log(`Installed Image Ledger at ${target}`);
