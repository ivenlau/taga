import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);

export interface ProjectContext {
  readonly id: string;
  readonly root: string;
  readonly cwd: string;
  readonly name: string;
  readonly source: 'explicit' | 'git-origin' | 'git-path' | 'path';
  readonly canonicalKey: string;
  readonly gitRoot?: string;
  readonly gitRemote?: string;
  readonly markerPath?: string;
}

export interface ResolveProjectInput {
  readonly cwd?: string;
  readonly projectRoot?: string;
  readonly projectId?: string;
  readonly markerFile?: string;
  readonly preferGitRoot?: boolean;
  readonly preferGitRemote?: boolean;
}

export async function resolveProjectContext(input: ResolveProjectInput): Promise<ProjectContext> {
  const cwd = await canonicalPath(input.cwd ?? process.cwd());
  const requestedRoot = await canonicalPath(input.projectRoot ?? cwd);
  const gitRoot = await findGitRoot(requestedRoot);
  const marker = await findProjectMarker(requestedRoot, gitRoot, input.markerFile ?? join('.taga', 'project.yaml'));
  const root = marker?.root ?? (input.projectRoot !== undefined || input.preferGitRoot === false ? requestedRoot : gitRoot ?? requestedRoot);
  const remote = gitRoot === undefined || input.preferGitRemote === false ? undefined : await gitOrigin(gitRoot);
  const normalizedRemote = remote === undefined ? undefined : normalizeGitRemote(remote);
  const projectRelativePath = gitRoot === undefined ? '' : relative(gitRoot, root).replaceAll('\\', '/');
  const projectSuffix = projectRelativePath.length === 0 ? '' : `#${projectRelativePath}`;
  const canonicalKey = normalizedRemote === undefined
    ? root.replaceAll('\\', '/')
    : `${normalizedRemote}${projectSuffix}`;
  const id = input.projectId ?? stableProjectId(canonicalKey);
  const source = input.projectId !== undefined
    ? 'explicit'
    : normalizedRemote !== undefined
      ? 'git-origin'
      : gitRoot !== undefined && input.preferGitRoot !== false
        ? 'git-path'
        : 'path';
  return {
    id,
    root,
    cwd,
    name: marker?.name ?? basename(root),
    source,
    canonicalKey,
    ...(gitRoot === undefined ? {} : { gitRoot }),
    ...(remote === undefined ? {} : { gitRemote: remote }),
    ...(marker === undefined ? {} : { markerPath: marker.path }),
  };
}

export function stableProjectId(identity: string): string {
  return `project-${contentHash(identity).slice(-16)}`;
}

export function normalizeGitRemote(remote: string): string {
  return remote.trim().toLowerCase().replace(/\.git$/u, '');
}

async function findGitRoot(path: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['-C', path, 'rev-parse', '--show-toplevel']);
    const root = result.stdout.trim();
    return root.length === 0 ? undefined : canonicalPath(root);
  } catch {
    return undefined;
  }
}

async function gitOrigin(root: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['-C', root, 'remote', 'get-url', 'origin']);
    const remote = result.stdout.trim();
    return remote.length === 0 ? undefined : remote;
  } catch {
    return undefined;
  }
}

async function findProjectMarker(start: string, gitRoot: string | undefined, markerFile: string): Promise<{ readonly root: string; readonly path: string; readonly name?: string } | undefined> {
  let current = start;
  const boundary = gitRoot ?? parseRoot(start);
  while (true) {
    const path = join(current, markerFile);
    try {
      await access(path);
      const raw = parseYaml(await readFile(path, 'utf8')) as unknown;
      if (isMarker(raw)) return { root: current, path, ...(raw.name === undefined ? {} : { name: raw.name }) };
    } catch {
      // Missing or invalid markers do not prevent normal project discovery.
    }
    if (samePath(current, boundary)) return undefined;
    const parent = dirname(current);
    if (samePath(parent, current)) return undefined;
    current = parent;
  }
}

function isMarker(value: unknown): value is { readonly boundary: true; readonly name?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const marker = value as { readonly schemaVersion?: unknown; readonly boundary?: unknown; readonly name?: unknown };
  return marker.schemaVersion === 1 && marker.boundary === true && (marker.name === undefined || typeof marker.name === 'string');
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function parseRoot(path: string): string {
  let current = path;
  while (dirname(current) !== current) current = dirname(current);
  return current;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function contentHash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
