import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string };
const script = `${root}scripts/verify-release-version.mjs`;

describe('release pipeline validation', () => {
  it('accepts the package version tag', () => {
    const result = spawnSync(process.execPath, [script, `v${packageJson.version}`], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`v${packageJson.version}`);
  });

  it('rejects mismatched and non-semver tags', () => {
    const mismatch = spawnSync(process.execPath, [script, 'v9.9.9'], { encoding: 'utf8' });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain('does not match');

    const invalid = spawnSync(process.execPath, [script, 'v-not-semver'], { encoding: 'utf8' });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('must be a semver tag');
  });
});
