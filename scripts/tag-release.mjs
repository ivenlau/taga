#!/usr/bin/env node
// Tags the current commit as v{version} (from package.json) and pushes the tag,
// which triggers the release workflow (build + test + npm publish).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tag = `v${version}`;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const existing = git(['tag', '-l', tag]);
if (existing === tag) {
  console.error(`tag ${tag} already exists; bump the version in package.json first`);
  process.exit(1);
}
const dirty = git(['status', '--porcelain']);
if (dirty.length > 0) {
  console.error('working tree is not clean; commit or stash before tagging a release');
  process.exit(1);
}
git(['tag', tag]);
git(['push', 'origin', tag]);
console.log(`tag ${tag} pushed; the release workflow will build, test and publish`);
