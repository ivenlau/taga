#!/usr/bin/env node
// Assembles the publishable single `taga` package (CLI + MCP binaries with the
// compiled tree) into ./npm-package, ready for `npm publish ./npm-package`.
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const outDir = join(root, 'npm-package');

const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtimeDependencyNames = ['@huggingface/transformers', '@zvec/zvec', 'better-sqlite3', 'yaml', 'zod'];
const dependencies = Object.fromEntries(
  runtimeDependencyNames.filter((name) => rootPackage.dependencies?.[name] !== undefined)
    .map((name) => [name, rootPackage.dependencies[name]]),
);

const missing = runtimeDependencyNames.filter((name) => rootPackage.dependencies?.[name] === undefined);
if (missing.length > 0) {
  console.error(`runtime dependencies missing from root package.json: ${missing.join(', ')}`);
  process.exit(1);
}

const packageManifest = {
  name: 'taga',
  version: rootPackage.version,
  description: rootPackage.description,
  license: rootPackage.license,
  repository: rootPackage.repository,
  keywords: rootPackage.keywords,
  type: 'module',
  engines: rootPackage.engines,
  bin: {
    taga: './dist/apps/cli/src/main.js',
    'taga-mcp': './dist/apps/mcp/src/main.js',
  },
  files: ['dist', 'README.md', 'LICENSE'],
  dependencies,
};

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'dist'), { recursive: true });
await cp(join(root, 'dist'), join(outDir, 'dist'), { recursive: true });
await cp(join(root, 'README.md'), join(outDir, 'README.md'));
try {
  await cp(join(root, 'LICENSE'), join(outDir, 'LICENSE'));
} catch {
  console.warn('warning: LICENSE file missing, package will publish without one');
}
await writeFile(join(outDir, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);

console.log(`npm package assembled at ./npm-package (taga@${packageManifest.version})`);
console.log('publish with: npm publish ./npm-package --access public');
