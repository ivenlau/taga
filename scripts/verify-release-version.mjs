#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const version = packageJson.version;
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const semverTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (typeof version !== 'string' || !semverTag.test(`v${version}`)) {
  console.error(`package.json version is not valid semver: ${String(version)}`);
  process.exit(1);
}
if (typeof tag !== 'string' || tag.length === 0) {
  console.error('release tag is required; pass it as the first argument or set GITHUB_REF_NAME');
  process.exit(1);
}
if (!semverTag.test(tag)) {
  console.error(`release tag must be a semver tag such as v1.2.3: ${tag}`);
  process.exit(1);
}
const expected = `v${version}`;
if (tag !== expected) {
  console.error(`release tag ${tag} does not match package.json version ${expected}`);
  process.exit(1);
}
console.log(`release version verified: ${tag}`);
