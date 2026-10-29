import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { extractMetadata, sha256 } from '../src/images/media';
import { markdownEmbed, parseRecord, parseRecordSnapshot, serializeSidecar } from '../src/images/records';
import { createTestVault, markerName, sourceNote, otherNote } from './test-vault';
import { PNG, jpegWithExif } from '../tests/fixtures';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactNames = ['main.js', 'manifest.json', 'styles.css'];
const timeoutMs = 90_000;
type Phase = 'main' | 'recovery';
export interface SmokeReceipt { runId: string; phase: Phase; status: string; error?: string; [key: string]: unknown }
interface Config { vault: string; runId: string; deadline: number; phase: Phase; artifacts: Record<string, string> }

export function cliInvocation(binary: string, vault: string | undefined, code: string): {command: string; args: string[]} {
  const args = vault ? [`vault=${path.basename(vault)}`] : [];
  return {command: '/usr/bin/script', args: ['-q', '/dev/null', binary, ...args, 'eval', `code=${code}`]};
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

export async function verifyTrustTarget(vault: string, artifacts: Record<string, string>): Promise<void> {
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
}

export async function validateFinalVault(vault: string, artifacts: Record<string, string>): Promise<{records: number; pending: number; missing: number; staging: number}> {
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
  const recordFiles = files.filter(file => /(?:^|\/)image-records\/[^/]+\.md$/.test(file));
  const images = files.filter(file => /(?:^|\/)images\/[^/]+\.(jpg|png)$/.test(file));
  assert.equal(recordFiles.length, 2, 'Expected one JPEG record and one PNG record');
  assert.equal(images.length, 2, 'Expected exactly two managed payloads');
  const marker = JSON.parse(await readFile(path.join(vault, markerName), 'utf8'));
  assert.equal(marker.version, 1);
  const fixtureHashes = new Set<string>();
  for (const name of ['sample-exif.jpg', 'sample.png']) {
    const hash = sha256(await readFile(path.join(vault, 'fixtures', name)));
    assert.equal(hash, marker.fixtures[name], 'Fixture changed'); fixtureHashes.add(hash);
  }
  const recordHashes = new Set<string>();
  for (const file of recordFiles) {
    const text = await readFile(path.join(vault, file), 'utf8');
    const record = parseRecord(text);
    assert.ok(record, `Invalid record: ${file}`);
    assert.equal(path.posix.dirname(file), 'Archive/image-records', 'Record did not remain in the renamed folder');
    assert.deepEqual(record, parseRecordSnapshot(text), 'Frontmatter and snapshot differ');
    assert.equal(record.recordPath, file);
    assert.equal(record.captionStatus, 'confirmed', 'Unfinished description');
    const expectedSources = [sourceNote, otherNote];
    if (record.format === 'png') expectedSources.push('Closed-editor.md');
    assert.deepEqual(new Set(record.sourceNotes), new Set(expectedSources), 'Capture note backlinks must match');
    const bytes = await readFile(path.join(vault, record.imagePath));
    assert.equal(sha256(bytes), record.sha256); assert.equal(bytes.length, record.bytes);
    assert.deepEqual(await extractMetadata(bytes), record.metadata, 'Payload metadata differs from record');
    assert.equal(await readFile(path.join(vault, record.sidecarPath), 'utf8'), serializeSidecar(record), 'XMP differs from record');
    assert.ok(images.includes(record.imagePath), 'Payload path is outside managed images');
    recordHashes.add(record.sha256);
    for (const note of record.sourceNotes) {
      const text = await readFile(path.join(vault, note), 'utf8');
      assert.equal(text.split(markdownEmbed(record, note)).length - 1, 1, 'Missing/duplicate current image embed');
      const target = path.posix.relative(path.posix.dirname(note), record.imagePath).split('/').map(encodeURIComponent).join('/');
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.equal([...text.matchAll(new RegExp(`!\\[[^\\n]*\\]\\(${escaped}\\)`, 'g'))].length, 1, 'Stale/multiple alt labels');
    }
  }
  assert.deepEqual(recordHashes, fixtureHashes, 'Managed images must match both fixtures');
  assert.deepEqual(await readdir(path.join(vault, '.image-ledger/staging')), [], 'Staging is not empty');
  assert.deepEqual(await readdir(path.join(vault, '.image-ledger/operations')), [], 'Description operations are not empty');
  assert.deepEqual(Object.keys(artifacts).sort(), [...artifactNames].sort());
  for (const file of artifactNames) {
    assert.equal(sha256(await readFile(path.join(vault, '.obsidian/plugins/image-ledger', file))), artifacts[file], 'Installed build changed');
    assert.equal(sha256(await readFile(path.join(repo, file))), artifacts[file], 'Source build changed during smoke test');
  }
  return {records: 2, pending: 0, missing: 0, staging: 0};
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
    await runCommand('npm', ['run', 'build'], deadline, {cwd: repo, timeoutMs: 30_000});
    vault = await realpath(await createTestVault());
    const directory = path.join(vault, '.image-ledger-smoke');
    await mkdir(directory);
    const host = path.join(directory, 'host.cjs');
    await copyFile(path.join(repo, 'scripts/obsidian-smoke-host.cjs'), host);
    const artifacts = Object.fromEntries(await Promise.all(artifactNames.map(async file => [file, sha256(await readFile(path.join(repo, file)))])));
    const binary = process.env.OBSIDIAN_BIN ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
    const invoke = async (code: string, selectedVault?: string, commandTimeout = 10_000) => {
      const command = cliInvocation(binary, selectedVault, code);
      return runCommand(command.command, command.args, deadline, {timeoutMs: commandTimeout});
    };
    console.log(`Obsidian smoke: ${vault}`);
    // Only the newly generated path is passed to the app's existing vault-open handler.
    const boot = `(()=>{const fs=require('node:fs'),p=require('node:path'),assert=require('node:assert/strict'),v=${JSON.stringify(vault)},m=JSON.parse(fs.readFileSync(p.join(v,${JSON.stringify(markerName)}),'utf8'));assert.equal(fs.realpathSync(v),v);assert.equal(m.version,1);for(const [name,hash] of Object.entries(m.fixtures)){assert.ok(['sample.png','sample-exif.jpg'].includes(name));assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(p.join(v,'fixtures',name))).digest('hex'),hash)}require('electron').ipcRenderer.sendSync('vault-open',v,false)})()`;
    await invoke(boot);
    const selected = `vault=${path.basename(vault)}`;
    await waitForSelectedVault(vault, Math.min(deadline, Date.now() + 10_000), limit => runCommand('/usr/bin/script', ['-q', '/dev/null', binary, selected, 'vault', 'info=path'], deadline, {timeoutMs: limit}));
    await verifyTrustTarget(vault, artifacts);
    await runCommand('/usr/bin/script', ['-q', '/dev/null', binary, selected, 'plugins:restrict', 'off'], deadline);
    await writeFile(path.join(directory, 'trust.json'), JSON.stringify({runId, vault, status: 'TRUSTED_GENERATED_ONLY', plugin: 'image-ledger', artifacts}, null, 2) + '\n', {flag: 'wx'});
    const main: Config = {vault, runId, deadline, phase: 'main', artifacts};
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
    const files = await validateFinalVault(vault, artifacts);
    const final = {runId, status: 'PASS', vault, durationMs: Date.now() - started, files, methods: 'Actual Obsidian plugin/editor/modal/Bases controls; generated paste/drop events. Native OS gestures not tested.', receipts: ['main.json', 'recovery.json']};
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
