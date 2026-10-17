import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const vaultIndex = args.indexOf('--vault');
if (vaultIndex < 0 || !args[vaultIndex + 1]) throw new Error('Usage: npm run install:vault -- --vault /absolute/path/to/vault [--enable]');
const vault = path.resolve(args[vaultIndex + 1]);
await access(path.join(vault, '.obsidian'));
const target = path.join(vault, '.obsidian/plugins/journal-media');
await mkdir(target, {recursive: true});
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  await access(path.join(repo, file));
  await copyFile(path.join(repo, file), path.join(target, file + '.installing'));
  await rename(path.join(target, file + '.installing'), path.join(target, file));
}
const state = path.join(vault, '.journal-media');
await mkdir(state, {recursive: true});
const ignorePath = path.join(vault, '.gitignore');
let ignore = await readFile(ignorePath, 'utf8').catch(() => '');
for (const pattern of ['images/', '.journal-media/']) {
  if (!ignore.split(/\r?\n/).some(line => line.trim() === pattern)) ignore = `${ignore.trimEnd()}\n${pattern}\n`;
}
await writeFile(ignorePath, ignore);
if (args.includes('--enable')) {
  const configPath = path.join(vault, '.obsidian/community-plugins.json');
  const original = await readFile(configPath, 'utf8');
  const enabled = JSON.parse(original);
  if (!Array.isArray(enabled)) throw new Error('Unexpected community plugin config; enabled plugins were not changed.');
  const backupPath = path.join(state, 'community-plugins.before-journal-media.json');
  try { await writeFile(backupPath, original, {flag: 'wx'}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const updated = [...new Set([...enabled.filter(id => id !== 'obsidian-imgur-plugin'), 'journal-media'])];
  await writeFile(configPath, JSON.stringify(updated, null, 2) + '\n');
  console.log('Enabled Journal Media in configuration; disabled the competing Imgur paste plugin. Reload Obsidian or enable the plugin in its UI.');
}
console.log(`Installed Journal Media at ${target}`);
