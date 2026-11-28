import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { adoptProjectIdentity, normalizeGitRemote, normalizeProjectKey, resolveProjectContext, stableProjectId } from '../packages/project-context/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const execFileAsync = promisify(execFile);

describe('runtime project context', () => {
  it('uses the transport-free Git origin identity', async () => {
    const fixture = await createTemporaryDirectory();
    await execFileAsync('git', ['init'], { cwd: fixture.path });
    await execFileAsync('git', ['remote', 'add', 'origin', 'HTTPS://GitHub.com/Example/Project.git'], { cwd: fixture.path });
    const context = await resolveProjectContext({ cwd: fixture.path });
    expect(context.source).toBe('git-origin');
    expect(context.canonicalKey).toBe('github.com/example/project');
    expect(context.id).toBe(stableProjectId('github.com/example/project'));
    expect(context.root).toBe(fixture.path);
    await fixture.cleanup();
  });

  it('keeps one identity across https, ssh, and scp remote forms', () => {
    expect(normalizeGitRemote('https://github.com/Example/Project.git')).toBe('github.com/example/project');
    expect(normalizeGitRemote('git@github.com:Example/Project.git')).toBe('github.com/example/project');
    expect(normalizeGitRemote('ssh://git@github.com/Example/Project.git')).toBe('github.com/example/project');
    expect(normalizeGitRemote('http://user@github.com/example/project')).toBe('github.com/example/project');
    expect(stableProjectId('github.com/example/project')).toBe(stableProjectId(normalizeGitRemote('git@github.com:example/project.git')));
    // Path-based identities and monorepo suffixes pass through with their suffix intact.
    expect(normalizeProjectKey('/work/repo')).toBe('/work/repo');
    expect(normalizeProjectKey('https://github.com/example/monorepo#packages/api')).toBe('github.com/example/monorepo#packages/api');
    // A different suffix is a different project even for the same remote.
    expect(normalizeProjectKey('github.com/example/monorepo#apps/web')).not.toBe('github.com/example/monorepo#packages/api');
  });

  it('adopts a stored project recorded under a different remote form', () => {
    const resolved = { id: stableProjectId('github.com/example/project'), root: '/repo', canonicalKey: 'github.com/example/project' };
    const legacyHttps = { id: 'project-legacy', canonicalKey: 'https://github.com/example/project', gitRemote: 'https://github.com/example/project.git' };
    expect(adoptProjectIdentity(resolved, [legacyHttps]).id).toBe('project-legacy');
    // Same identity under the new form already stored: no fork, and self-matches are no-ops.
    expect(adoptProjectIdentity(resolved, [{ id: resolved.id, canonicalKey: 'github.com/example/project' }]).id).toBe(resolved.id);
    // A different repository is not adopted, and suffix differences are respected.
    const monorepo = { id: 'project-monorepo-root', canonicalKey: 'github.com/example/monorepo' };
    expect(adoptProjectIdentity({ ...resolved, canonicalKey: 'github.com/example/monorepo#packages/api' }, [monorepo]).id).not.toBe('project-monorepo-root');
  });

  it('uses the nearest marker as a deterministic monorepo boundary', async () => {
    const fixture = await createTemporaryDirectory();
    const child = join(fixture.path, 'packages', 'api');
    await mkdir(join(child, '.taga'), { recursive: true });
    await writeFile(join(child, '.taga', 'project.yaml'), 'schemaVersion: 1\nname: api\nboundary: true\n', 'utf8');
    const nested = join(child, 'src');
    await mkdir(nested, { recursive: true });
    const context = await resolveProjectContext({ cwd: nested });
    expect(context.root).toBe(child);
    expect(context.name).toBe('api');
    expect(context.source).toBe('path');
    await fixture.cleanup();
  });

  it('uses an explicit project root as a monorepo boundary without changing the repository root identity', async () => {
    const fixture = await createTemporaryDirectory();
    await execFileAsync('git', ['init'], { cwd: fixture.path });
    await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/example/mono.git'], { cwd: fixture.path });
    const child = join(fixture.path, 'packages', 'api');
    await mkdir(join(child, '.taga'), { recursive: true });
    const rootContext = await resolveProjectContext({ cwd: child });
    const explicitContext = await resolveProjectContext({ cwd: child, projectRoot: child });
    expect(rootContext.id).toBe(stableProjectId('github.com/example/mono'));
    expect(explicitContext.root).toBe(child);
    expect(explicitContext.id).toBe(stableProjectId('github.com/example/mono#packages/api'));
    await fixture.cleanup();
  });

  it('persists known projects and session bindings', async () => {
    const fixture = await createTemporaryDirectory();
    const database = new DatabaseStore(join(fixture.path, 'taga.db'));
    database.saveProjectContext({ id: 'project-a', root: fixture.path, name: 'a', source: 'path', canonicalKey: fixture.path });
    database.saveSessionContext({ sessionId: 'session-a', projectId: 'project-a', projectRoot: fixture.path, cwd: fixture.path, agentId: 'local', source: 'path' });
    expect(database.listProjectContexts()[0]?.id).toBe('project-a');
    expect(database.getSessionContext('session-a')).toMatchObject({ projectId: 'project-a', projectRoot: fixture.path });
    database.close();
    await fixture.cleanup();
  });
});
