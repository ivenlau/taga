#!/usr/bin/env node
// tsc only compiles TypeScript, so the web workbench's static assets are copied into
// dist/apps/web/public here; the npm package then ships them with the rest of dist.
import { cp, access } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const source = join(root, 'apps', 'web', 'public');
const target = join(root, 'dist', 'apps', 'web', 'public');

try {
  await access(source);
} catch {
  console.error(`web public assets missing at ${source}`);
  process.exit(1);
}
await cp(source, target, { recursive: true });
console.log(`copied web public assets to ${target}`);
