#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageDir = resolve(process.argv[2] ?? join(root, 'npm-package'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmOptions = { shell: process.platform === 'win32' };
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
const requiredBins = ['taga', 'taga-mcp'];

if (manifest.name !== 'taga' || typeof manifest.version !== 'string') {
  throw new Error('npm package manifest must define name=taga and a version');
}
for (const name of requiredBins) {
  const relativePath = manifest.bin?.[name];
  if (typeof relativePath !== 'string') throw new Error(`npm package is missing bin.${name}`);
  const entryPath = join(packageDir, relativePath);
  await readFile(entryPath);
}

const smokeRoot = await mkdtemp(join(tmpdir(), 'taga-npm-smoke-'));
const packDir = join(smokeRoot, 'pack');
const installDir = join(smokeRoot, 'install');
const cacheDir = join(smokeRoot, 'npm-cache');
await Promise.all([mkdir(packDir), mkdir(installDir), mkdir(cacheDir)]);
await writeFile(join(installDir, 'package.json'), '{"private":true}\n', 'utf8');

try {
  const packed = spawnSync(npmCommand, ['pack', packageDir, '--pack-destination', packDir, '--json', '--cache', cacheDir], { encoding: 'utf8', ...npmOptions });
  if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.error?.message ?? packed.stderr ?? 'unknown error'}`);
  const tarballName = (await readdir(packDir)).find((file) => file.endsWith('.tgz'));
  if (tarballName === undefined) throw new Error('npm pack did not produce a tarball');
  const tarballPath = join(packDir, tarballName);

  const installed = spawnSync(npmCommand, ['install', '--no-save', '--prefix', installDir, tarballPath, '--cache', cacheDir], {
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false' },
    ...npmOptions,
  });
  if (installed.status !== 0) throw new Error(`npm install failed:\n${installed.error?.message ?? installed.stderr ?? 'unknown error'}`);

  const installedPackageDir = join(installDir, 'node_modules', 'taga');
  const brainPath = join(smokeRoot, 'brain');
  const cliEntry = join(installedPackageDir, manifest.bin.taga);
  const cli = spawnSync(process.execPath, [cliEntry, 'config', 'validate', '--json', `--brain=${brainPath}`], { encoding: 'utf8' });
  if (cli.status !== 0) throw new Error(`installed taga failed:\n${cli.stderr}`);
  const cliResponse = JSON.parse(cli.stdout);
  if (cliResponse.ok !== true || cliResponse.code !== 'CONFIG_VALID') throw new Error('installed taga returned an invalid config response');

  const mcpEntry = join(installedPackageDir, manifest.bin['taga-mcp']);
  const mcp = spawn(process.execPath, [mcpEntry], {
    cwd: installDir,
    env: { ...process.env, TAGA_BRAIN: brainPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const mcpResponse = await new Promise((resolveResponse, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      mcp.kill();
      reject(new Error('installed taga-mcp did not respond within 10 seconds'));
    }, 10_000);
    const stopMcp = () => new Promise((resolveStop) => {
      if (mcp.exitCode !== null) {
        resolveStop();
        return;
      }
      mcp.once('close', resolveStop);
      mcp.kill();
    });
    mcp.stdout.setEncoding('utf8');
    mcp.stdout.on('data', async (chunk) => {
      output += chunk;
      const line = output.split(/\r?\n/u).find((candidate) => candidate.length > 0);
      if (line === undefined) return;
      clearTimeout(timer);
      try {
        const response = JSON.parse(line);
        await stopMcp();
        resolveResponse(response);
      } catch (error) {
        await stopMcp();
        reject(error);
      }
    });
    mcp.on('error', reject);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  });
  if (mcpResponse?.result?.tools === undefined) throw new Error('installed taga-mcp returned an invalid tools/list response');

  console.log(`npm package smoke test passed: taga@${manifest.version}`);
} finally {
  await rm(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
