import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/images/media';
import { createDescriptionCodec, SUPPORTED_EXIFTOOL_VERSIONS } from '../src/images/description';
import { markdownEmbed } from '../src/images/markdown';
import { createTestVault, markerName, sourceNote, otherNote } from './test-vault';
import { PNG, jpegWithExif } from '../tests/fixtures';
import { readExif } from '../tests/exif';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactNames = ['main.js', 'manifest.json', 'styles.css'];
const timeoutMs = 90_000;
type Phase = 'main' | 'recovery';
export interface SmokeReceipt { runId: string; phase: Phase; status: string; error?: string; [key: string]: unknown }
interface ExifToolIdentity { path: string; sha256: string }
interface Config { vault: string; runId: string; deadline: number; phase: Phase; artifacts: Record<string, string>; exiftool: ExifToolIdentity }

function cliCommand(binary: string, vault: string | undefined, commandArgs: string[]): {command: string; args: string[]} {
  const args = vault ? [`vault=${path.basename(vault)}`] : [];
  if (path.basename(binary) === 'obsidian-cli') return {command: binary, args: [...args, ...commandArgs]};
  return {command: '/usr/bin/script', args: ['-q', '/dev/null', binary, ...args, ...commandArgs]};
}

export function cliInvocation(binary: string, vault: string | undefined, code: string): {command: string; args: string[]} {
  return cliCommand(binary, vault, ['eval', `code=${code}`]);
}

export async function runCommand(command: string, args: string[], deadline: number, options: {cwd?: string; timeoutMs?: number} = {}): Promise<string> {
  const remaining = Math.min(deadline - Date.now(), options.timeoutMs ?? 10_000);
  assert.ok(remaining > 0, 'Smoke deadline exceeded');
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM'); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      finish(Object.assign(new Error(`Command timed out: ${path.basename(command)}\n${output.trim()}`), {code: 'COMMAND_TIMEOUT'}));
    }, remaining);
    const collect = (chunk: Buffer) => {output = (output + chunk.toString()).slice(-4000);};
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', error => finish(error));
    child.on('close', (code, signal) => {
      const plain = output.replace(/\u001b\[[0-9;]*m/g, '');
      if (code === 0 && /(?:^|[\r\n])(?:Error:|Uncaught\b|AssertionError\b|TypeError:|ReferenceError:|SyntaxError:)/.test(plain)) {
        finish(Object.assign(new Error(`CLI eval error: ${plain.trim()}`), {code: 'CLI_EVAL_ERROR'}));
      } else finish(code === 0 ? undefined : new Error(`Command failed (${code ?? signal}): ${path.basename(command)}\n${output.trim()}`));
    });
  });
}

export async function waitForReceipt(file: string, expected: {runId: string; phase: Phase}, statuses: string[], deadline: number): Promise<SmokeReceipt> {
  while (Date.now() < deadline) {
    let receipt: SmokeReceipt | undefined;
    try {receipt = JSON.parse(await readFile(file, 'utf8')) as SmokeReceipt;}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    if (receipt) {
      assert.equal(receipt.runId, expected.runId, 'Stale smoke receipt: runId differs');
      assert.equal(receipt.phase, expected.phase, 'Stale smoke receipt: phase differs');
      assert.ok(['RUNNING', 'FAIL', 'AWAITING_RELOAD', 'PASS'].includes(receipt.status), 'Invalid smoke receipt status');
      if (receipt.status === 'FAIL') throw new Error(`Host ${expected.phase} failed: ${receipt.error ?? 'see receipt'}`);
      if (statuses.includes(receipt.status)) return receipt;
      assert.equal(receipt.status, 'RUNNING', 'Unexpected terminal smoke receipt');
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${expected.phase} receipt: ${file}`);
}

export async function waitForReady(file: string, expected: {runId: string; phase: Phase; nonce: string; vault: string}, deadline: number, invoke: (timeoutMs: number) => Promise<string>): Promise<void> {
  let output = '(no CLI output)';
  while (Date.now() < deadline) {
    let ready;
    try {ready = JSON.parse(await readFile(file, 'utf8'));}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    if (ready) {
      for (const field of ['runId', 'phase', 'nonce', 'vault'] as const) assert.equal(ready[field], expected[field], `Stale readiness receipt: ${field} differs`);
      assert.equal(ready.status, 'READY', 'Invalid readiness status');
      return;
    }
    try {output = await invoke(Math.min(2000, Math.max(1, deadline - Date.now())));}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'COMMAND_TIMEOUT' && !((error as NodeJS.ErrnoException).code === 'CLI_EVAL_ERROR' && (error as Error).message.includes('Error: Command \"eval\" not found. It may require a plugin to be enabled.'))) throw error;
      output = error instanceof Error ? error.message : String(error);
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${expected.phase} app readiness. Last CLI output: ${output.trim() || '(empty)'}`);
}

export function assertSelectedVault(output: string, vault: string): void {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  assert.equal(lines.filter(line => line === vault).length, 1, 'CLI did not confirm the exact generated vault path');
}

export async function waitForSelectedVault(vault: string, deadline: number, invoke: (timeoutMs: number) => Promise<string>): Promise<void> {
  let last = '(no CLI response)';
  while (Date.now() < deadline) {
    try {assertSelectedVault(await invoke(Math.min(2000, Math.max(1, deadline - Date.now()))), vault); return;}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'COMMAND_TIMEOUT' && !((error as NodeJS.ErrnoException).code === 'CLI_EVAL_ERROR' && (error as Error).message.includes('Error: Command "vault" not found. It may require a plugin to be enabled.'))) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out confirming generated vault path. Last CLI output: ${last}`);
}

export async function verifyTrustTarget(vault: string, artifacts: Record<string, string>, exiftool: ExifToolIdentity): Promise<void> {
  assert.equal(await realpath(vault), vault, 'Trust target must be canonical');
  const marker = JSON.parse(await readFile(path.join(vault, markerName), 'utf8'));
  assert.equal(marker.version, 1, 'Trust requires a generated vault');
  const fixtures = {'sample.png': PNG, 'sample-exif.jpg': jpegWithExif({offset: '-04:00', subsecond: '0074'})};
  assert.deepEqual(Object.keys(marker.fixtures).sort(), Object.keys(fixtures).sort());
  for (const [name, bytes] of Object.entries(fixtures)) {
    assert.equal(marker.fixtures[name], sha256(bytes), 'Unknown fixture marker');
    assert.equal(sha256(await readFile(path.join(vault, 'fixtures', name))), sha256(bytes), 'Trust fixture changed');
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(vault, '.obsidian/community-plugins.json'), 'utf8')), ['image-ledger'], 'Trust target enables an unknown plugin');
  assert.deepEqual(await readdir(path.join(vault, '.obsidian/plugins')), ['image-ledger'], 'Trust target contains another plugin');
  assert.deepEqual(Object.keys(artifacts).sort(), [...artifactNames].sort());
  for (const [name, hash] of Object.entries(artifacts)) assert.equal(sha256(await readFile(path.join(vault, '.obsidian/plugins/image-ledger', name))), hash, 'Trust build changed');
  assert.equal(await realpath(exiftool.path), exiftool.path, 'ExifTool path must be canonical');
  assert.equal(sha256(await readFile(exiftool.path)), exiftool.sha256, 'ExifTool executable changed');
  assert.deepEqual(JSON.parse(await readFile(path.join(vault, '.obsidian/plugins/image-ledger/data.json'), 'utf8')),
    {exiftoolPath: exiftool.path}, 'Unexpected generated plugin settings');
}

export async function validateFinalVault(vault: string, artifacts: Record<string, string>, exiftoolPath: string): Promise<{images: number; pending: number; staging: number}> {
  const walk = async (directory: string): Promise<string[]> => {
    const result: string[] = [];
    for (const entry of await readdir(path.join(vault, directory), {withFileTypes: true}).catch(error => {if (error.code === 'ENOENT') return []; throw error;})) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.name.startsWith('.') || relative === 'fixtures') continue;
      if (entry.isDirectory()) result.push(...await walk(relative)); else if (entry.isFile()) result.push(relative);
    }
    return result;
  };
  const files = await walk('');
  assert.ok(!files.some(file => /(?:^|\/)image-records\/|\.xmp$|(?:^|\/)image-library\.base$/i.test(file)), 'Record, sidecar, or Bases file created');
  const images = files.filter(file => /(?:^|\/)images\/[^/]+\.(jpg|png)$/.test(file));
  assert.equal(images.length, 2, 'Expected exactly two managed payloads');
  for (const image of images) assert.match(path.posix.basename(image), /^[0-9a-f]{64}\.(jpg|png)$/, `Invalid managed filename: ${image}`);
  const marker = JSON.parse(await readFile(path.join(vault, markerName), 'utf8'));
  assert.equal(marker.version, 1);
  const codec = createDescriptionCodec(exiftoolPath);
  for (const [name, extension, description, altText] of [
    ['sample-exif.jpg', '.jpg', 'Edited synthetic JPEG.', ['Synthetic JPEG.', 'Synthetic JPEG.']],
    ['sample.png', '.png', 'Recovered synthetic PNG.', ['Image', 'Recovered synthetic PNG.']],
  ] as const) {
    const fixture = await readFile(path.join(vault, 'fixtures', name));
    assert.equal(sha256(fixture), marker.fixtures[name], 'Fixture changed');
    const expected = await codec.inspect(fixture);
    const imagePath = images.find(file => path.posix.basename(file) === expected.id + extension);
    assert.ok(imagePath, `Missing normalized image for ${name}`);
    const bytes = await readFile(path.join(vault, imagePath));
    const image = await codec.inspect(bytes);
    assert.deepEqual(image, {id: expected.id, description}, 'Embedded description or normalized hash differs');
    assert.notEqual(sha256(bytes), sha256(fixture), 'Description must change the file bytes');
    assert.deepEqual(await readExif(bytes), await readExif(fixture), 'Image metadata changed');
    for (const [index, note] of [sourceNote, otherNote].entries()) {
      const text = await readFile(path.join(vault, note), 'utf8');
      assert.equal(text.split(markdownEmbed({id: image.id, imagePath, description: altText[index]}, note)).length - 1, 1, 'Missing/duplicate image embed');
      const target = path.posix.relative(path.posix.dirname(note), imagePath).split('/').map(encodeURIComponent).join('/');
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.equal([...text.matchAll(new RegExp(`!\\[[^\\n]*\\]\\(${escaped}\\)`, 'g'))].length, 1, 'Duplicate image embed');
      assert.ok(!text.includes('[Image details]'), 'Record link created');
    }
  }
  for (const folder of ['staging', 'operations']) {
    const entries = await readdir(path.join(vault, '.image-ledger', folder)).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(entries, [], `Unfinished ${folder} files remain`);
  }
  assert.deepEqual(Object.keys(artifacts).sort(), [...artifactNames].sort());
  for (const file of artifactNames) {
    assert.equal(sha256(await readFile(path.join(vault, '.obsidian/plugins/image-ledger', file))), artifacts[file], 'Installed build changed');
    assert.equal(sha256(await readFile(path.join(repo, file))), artifacts[file], 'Source build changed during smoke test');
  }
  return {images: 2, pending: 0, staging: 0};
}

function readinessCode(config: Config, nonce: string, file: string): string {
  return `(()=>{const fs=require('node:fs'),assert=require('node:assert/strict'),c=${JSON.stringify(config)};if(typeof app==='undefined'||!app.vault?.adapter||!app.workspace)return 'STARTING';assert.equal(fs.realpathSync(app.vault.adapter.getBasePath()),c.vault,'Wrong vault during startup');if(!app.plugins?.plugins?.['image-ledger'])return 'STARTING';const result={runId:c.runId,phase:c.phase,nonce:${JSON.stringify(nonce)},vault:c.vault,status:'READY'},file=${JSON.stringify(file)};fs.writeFileSync(file+'.tmp',JSON.stringify(result));fs.renameSync(file+'.tmp',file);return 'READY'})()`;
}

function hostCode(config: Config, host: string): string {
  // The canonical path check runs before requiring any host module in the app.
  return `void (async()=>{const fs=require('node:fs'),p=require('node:path'),assert=require('node:assert/strict'),c=${JSON.stringify(config)};const end=Math.min(c.deadline,Date.now()+10000);while(Date.now()<end&&(!app.vault?.adapter||!app.workspace))await new Promise(r=>setTimeout(r,100));assert.equal(fs.realpathSync(app.vault.adapter.getBasePath()),c.vault,'Wrong vault; no host module loaded');const h=require(${JSON.stringify(host)});h.verifyVault(app,c);await h(app,c);})().catch(error=>{const fs=require('node:fs'),p=require('node:path'),c=${JSON.stringify(config)},file=p.join(c.vault,'.image-ledger-smoke',c.phase+'.json');let receipt={runId:c.runId,phase:c.phase,status:'FAIL'};try{receipt={...JSON.parse(fs.readFileSync(file,'utf8')),status:'FAIL'}}catch{}receipt.error=String(error.stack??error);fs.writeFileSync(file+'.tmp',JSON.stringify(receipt));fs.renameSync(file+'.tmp',file);})`;
}

async function runSmoke(): Promise<void> {
  assert.equal(process.platform, 'darwin', 'This smoke runner currently requires macOS Obsidian CLI');
  assert.equal(process.argv.length, 2, 'Usage: npm run test:obsidian');
  const started = Date.now(), deadline = started + timeoutMs, runId = randomUUID();
  let vault: string | undefined;
  const timer = setTimeout(() => {
    console.error(`Obsidian smoke exceeded 90s. Preserved vault: ${vault ?? '(build did not finish)'}`);
    process.exit(1);
  }, timeoutMs);
  try {
    const executable = process.env.EXIFTOOL;
    assert.ok(executable && path.isAbsolute(executable), 'Set EXIFTOOL to the absolute path of a supported ExifTool executable');
    const executablePath = await realpath(executable);
    const version = (await runCommand(executablePath, ['-config', '', '-ver'], deadline)).trim();
    assert.ok(SUPPORTED_EXIFTOOL_VERSIONS.includes(version), `Smoke requires ExifTool ${SUPPORTED_EXIFTOOL_VERSIONS.join(' or ')}`);
    const exiftool = {path: executablePath, sha256: sha256(await readFile(executablePath))};
    await runCommand('npm', ['run', 'build'], deadline, {cwd: repo, timeoutMs: 30_000});
    vault = await realpath(await createTestVault(undefined, executablePath));
    const directory = path.join(vault, '.image-ledger-smoke');
    await mkdir(directory);
    const host = path.join(directory, 'host.cjs');
    await copyFile(path.join(repo, 'scripts/obsidian-smoke-host.cjs'), host);
    const artifacts = Object.fromEntries(await Promise.all(artifactNames.map(async file => [file, sha256(await readFile(path.join(repo, file)))])));
    const standaloneCli = '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli';
    const binary = process.env.OBSIDIAN_BIN
      ?? (existsSync(standaloneCli) ? standaloneCli : '/Applications/Obsidian.app/Contents/MacOS/Obsidian');
    const invoke = async (code: string, selectedVault?: string, commandTimeout = 10_000) => {
      const command = cliInvocation(binary, selectedVault, code);
      return runCommand(command.command, command.args, deadline, {timeoutMs: commandTimeout});
    };
    console.log(`Obsidian smoke: ${vault}`);
    // Only the newly generated path is passed to the app's existing vault-open handler.
    const boot = `(()=>{const fs=require('node:fs'),p=require('node:path'),assert=require('node:assert/strict'),v=${JSON.stringify(vault)},m=JSON.parse(fs.readFileSync(p.join(v,${JSON.stringify(markerName)}),'utf8'));assert.equal(fs.realpathSync(v),v);assert.equal(m.version,1);for(const [name,hash] of Object.entries(m.fixtures)){assert.ok(['sample.png','sample-exif.jpg'].includes(name));assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(p.join(v,'fixtures',name))).digest('hex'),hash)}require('electron').ipcRenderer.sendSync('vault-open',v,false)})()`;
    await invoke(boot);
    const selection = cliCommand(binary, vault, ['vault', 'info=path']);
    await waitForSelectedVault(vault, Math.min(deadline, Date.now() + 10_000),
      limit => runCommand(selection.command, selection.args, deadline, {timeoutMs: limit}));
    await verifyTrustTarget(vault, artifacts, exiftool);
    const trust = cliCommand(binary, vault, ['plugins:restrict', 'off']);
    await runCommand(trust.command, trust.args, deadline);
    await writeFile(path.join(directory, 'trust.json'), JSON.stringify({runId, vault, status: 'TRUSTED_GENERATED_ONLY', plugin: 'image-ledger', artifacts}, null, 2) + '\n', {flag: 'wx'});
    const main: Config = {vault, runId, deadline, phase: 'main', artifacts, exiftool};
    const runPhase = async (config: Config, terminal: string) => {
      const ready = {runId, phase: config.phase, nonce: randomUUID(), vault: vault!};
      const readyPath = path.join(directory, config.phase + '-ready.json');
      await waitForReady(readyPath, ready, Math.min(deadline, Date.now() + 10_000), limit => invoke(readinessCode(config, ready.nonce, readyPath), vault, limit));
      const file = path.join(directory, config.phase + '.json');
      await invoke(hostCode(config, host), vault);
      await waitForReceipt(file, config, ['RUNNING', terminal], Math.min(deadline, Date.now() + 10_000));
      return waitForReceipt(file, config, [terminal], deadline);
    };
    await runPhase(main, 'AWAITING_RELOAD');
    const checkpoint = JSON.parse(await readFile(path.join(directory, 'checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.runId, runId, 'Reload checkpoint belongs to another run');
    await invoke(`(()=>{const fs=require('node:fs'),assert=require('node:assert/strict'),c=${JSON.stringify(main)};assert.equal(fs.realpathSync(app.vault.adapter.getBasePath()),c.vault);const h=require(${JSON.stringify(host)});h.verifyVault(app,c);assert.equal(app.commands.executeCommandById('app:reload'),true)})()`, vault);
    await runPhase({...main, phase: 'recovery'}, 'PASS');
    const files = await validateFinalVault(vault, artifacts, executablePath);
    const final = {runId, status: 'PASS', vault, durationMs: Date.now() - started, files, methods: 'Actual Obsidian plugin, editor, modal and menu handlers; generated paste/drop events. Native OS gestures not tested.', receipts: ['main.json', 'recovery.json']};
    await writeFile(path.join(directory, 'result.json'), JSON.stringify(final, null, 2) + '\n', {flag: 'wx'});
    console.log(`PASS in ${(final.durationMs / 1000).toFixed(1)}s. Receipts: ${directory}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (vault) await writeFile(path.join(vault, '.image-ledger-smoke/result.json'), JSON.stringify({runId, status: 'FAIL', vault, durationMs: Date.now() - started, error: message}, null, 2) + '\n', {flag: 'wx'}).catch(() => {});
    throw new Error(`${message}\nPreserved vault: ${vault ?? '(not created)'}`);
  } finally {clearTimeout(timer);}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSmoke().catch(error => {console.error(error.message); process.exitCode = 1;});
}
