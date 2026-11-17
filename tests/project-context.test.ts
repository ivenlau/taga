import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolveProjectContext, stableProjectId } from '../packages/project-context/src/index.js';
import { DatabaseStore } from '../packages/storage/src/index.js';
import { createTemporaryDirectory } from '../packages/testkit/src/index.js';

const execFileAsync = promisify(execFile);

describe('runtime project context', () => {
  it('uses normalized Git origin and preserves the legacy project id algorithm', async () => {
    const fixture = await createTemporaryDirectory();
    await execFileAsync('git', ['init'], { cwd: fixture.path });
    await execFileAsync('git', ['remote', 'add', 'origin', 'HTTPS://GitHub.com/Example/Project.git'], { cwd: fixture.path });
    const context = await resolveProjectContext({ cwd: fixture.path });
    expect(context.source).toBe('git-origin');
    expect(context.id).toBe(stableProjectId('https://github.com/example/project'));
    expect(context.root).toBe(fixture.path);
    await fixture.cleanup();
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
    expect(rootContext.id).toBe(stableProjectId('https://github.com/example/mono'));
    expect(explicitContext.root).toBe(child);
    expect(explicitContext.id).toBe(stableProjectId('https://github.com/example/mono#packages/api'));
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
