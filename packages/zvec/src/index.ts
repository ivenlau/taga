import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type {
  ZVecCollection,
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecStatus,
} from '@zvec/zvec';

export type ZvecAccessMode = 'load-only' | 'read-only' | 'read-write';
export type ZvecRuntimeStatus = 'available' | 'not-configured' | 'unavailable' | 'incompatible' | 'busy' | 'corrupt' | 'unknown';
export type ZvecRuntimeFailureCode = Exclude<ZvecRuntimeStatus, 'available' | 'not-configured'>;

export type ZvecRuntimeModule = {
  readonly ZVecCollectionSchema: new (...args: ConstructorParameters<typeof ZVecCollectionSchema>) => ZVecCollectionSchema;
  readonly ZVecCreateAndOpen: (path: string, schema: ZVecCollectionSchema, options?: { readonly readOnly?: boolean }) => ZVecCollection;
  readonly ZVecDataType: { readonly STRING: ZVecDataType; readonly INT64: ZVecDataType; readonly VECTOR_FP32: ZVecDataType };
  readonly ZVecIndexType: { readonly HNSW: 1 };
  readonly ZVecMetricType: { readonly COSINE: 3 };
  readonly ZVecOpen: (path: string, options?: { readonly readOnly?: boolean }) => ZVecCollection;
};

export type ZvecModuleLoader = () => Promise<ZvecRuntimeModule>;

export interface ZvecRuntimeReport {
  readonly runtimeAvailable: boolean;
  readonly status: ZvecRuntimeStatus;
  readonly packageVersion: string | null;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly accessMode: ZvecAccessMode;
  readonly collectionPath: string | null;
  readonly docCount: number | null;
  readonly detail?: string;
}

export interface ZvecLifecycleReport {
  readonly packageVersion: string | null;
  readonly inserted: number;
  readonly queryHitIds: readonly string[];
  readonly remainingAfterDelete: number;
  readonly reopenedDocCount: number;
}

export class ZvecRuntimeError extends Error {
  constructor(
    readonly code: ZvecRuntimeFailureCode,
    message: string,
    readonly causeCode?: string,
  ) {
    super(message);
    this.name = 'ZvecRuntimeError';
  }
}

const require = createRequire(import.meta.url);
const defaultLoader: ZvecModuleLoader = async () => import('@zvec/zvec');

export class ZvecRuntimeAdapter {
  private modulePromise: Promise<ZvecRuntimeModule> | undefined;

  constructor(private readonly loader: ZvecModuleLoader = defaultLoader) {}

  get loaded(): boolean {
    return this.modulePromise !== undefined;
  }

  async load(): Promise<ZvecRuntimeModule> {
    if (this.modulePromise === undefined) {
      this.modulePromise = this.loader().catch((error: unknown) => {
        this.modulePromise = undefined;
        throw classifyZvecFailure(error);
      });
    }
    return this.modulePromise;
  }

  async open(collectionPath: string, accessMode: Exclude<ZvecAccessMode, 'load-only'>): Promise<ZVecCollection> {
    const runtime = await this.load();
    try {
      return runtime.ZVecOpen(collectionPath, { readOnly: accessMode === 'read-only' });
    } catch (error) {
      throw classifyZvecFailure(error);
    }
  }

  async createAndOpen(collectionPath: string, schema: ZVecCollectionSchema): Promise<ZVecCollection> {
    const runtime = await this.load();
    try {
      return runtime.ZVecCreateAndOpen(collectionPath, schema, { readOnly: false });
    } catch (error) {
      throw classifyZvecFailure(error);
    }
  }

  async probe(options: { readonly collectionPath?: string; readonly accessMode?: Exclude<ZvecAccessMode, 'load-only'> } = {}): Promise<ZvecRuntimeReport> {
    const packageVersion = await readZvecPackageVersion();
    const accessMode: ZvecAccessMode = options.collectionPath === undefined ? 'load-only' : options.accessMode ?? 'read-only';
    try {
      await this.load();
      if (options.collectionPath === undefined) {
        return baseReport(true, 'available', packageVersion, accessMode, null, null);
      }
      if (!await pathExists(options.collectionPath)) {
        return baseReport(true, 'not-configured', packageVersion, accessMode, options.collectionPath, null);
      }
      const collection = await this.open(options.collectionPath, options.accessMode ?? 'read-only');
      try {
        return baseReport(true, 'available', packageVersion, accessMode, options.collectionPath, collection.stats.docCount);
      } finally {
        collection.closeSync();
      }
    } catch (error) {
      const failure = classifyZvecFailure(error);
      return baseReport(this.loaded, failure.code, packageVersion, accessMode, options.collectionPath ?? null, null, failure.message);
    }
  }
}

const defaultRuntime = new ZvecRuntimeAdapter();

export function isZvecRuntimeLoaded(): boolean {
  return defaultRuntime.loaded;
}

export function probeZvecRuntime(options: { readonly collectionPath?: string; readonly accessMode?: Exclude<ZvecAccessMode, 'load-only'> } = {}): Promise<ZvecRuntimeReport> {
  return defaultRuntime.probe(options);
}

export async function runZvecLifecycleProbe(collectionPath: string, adapter = new ZvecRuntimeAdapter()): Promise<ZvecLifecycleReport> {
  const runtime = await adapter.load();
  const schema = new runtime.ZVecCollectionSchema({
    name: 'taga_runtime_probe',
    fields: { name: 'label', dataType: runtime.ZVecDataType.STRING },
    vectors: { name: 'embedding', dataType: runtime.ZVecDataType.VECTOR_FP32, dimension: 4 },
  });
  const collection = await adapter.createAndOpen(collectionPath, schema);
  let queryHitIds: readonly string[] = [];
  let remainingAfterDelete = 0;
  try {
    assertStatuses(collection.upsertSync([
      { id: 'alpha', fields: { label: 'alpha' }, vectors: { embedding: [1, 0, 0, 0] } },
      { id: 'beta', fields: { label: 'beta' }, vectors: { embedding: [0, 1, 0, 0] } },
    ]));
    queryHitIds = collection.querySync({ fieldName: 'embedding', vector: [1, 0, 0, 0], topk: 2, includeVector: false, outputFields: ['label'] }).map((document) => document.id);
    assertStatuses(collection.deleteSync('beta'));
    remainingAfterDelete = collection.stats.docCount;
  } finally {
    collection.closeSync();
  }
  const reopened = await adapter.open(collectionPath, 'read-only');
  try {
    return {
      packageVersion: await readZvecPackageVersion(),
      inserted: 2,
      queryHitIds,
      remainingAfterDelete,
      reopenedDocCount: reopened.stats.docCount,
    };
  } finally {
    reopened.closeSync();
  }
}

export function classifyZvecFailure(error: unknown): ZvecRuntimeError {
  if (error instanceof ZvecRuntimeError) return error;
  const message = errorMessage(error);
  const causeCode = errorCode(error);
  const normalized = `${causeCode ?? ''} ${message}`.toLocaleLowerCase();
  if (/can't lock|cannot lock|locked|resource busy|busy/.test(normalized)) {
    return new ZvecRuntimeError('busy', message, causeCode);
  }
  if (/err_dlopen_failed|failed to load prebuilt|no prebuilt|not supported|node_module_version|valid win32|dynamic link|shared object|dll/.test(normalized)) {
    return new ZvecRuntimeError('incompatible', message, causeCode);
  }
  if (/corrupt|checksum|manifest|malformed|wal/.test(normalized)) {
    return new ZvecRuntimeError('corrupt', message, causeCode);
  }
  if (causeCode === 'ERR_MODULE_NOT_FOUND' || causeCode === 'MODULE_NOT_FOUND' || causeCode === 'ZVEC_NOT_FOUND' || causeCode === 'ZVEC_UNAVAILABLE' || causeCode === 'ZVEC_PERMISSION_DENIED') {
    return new ZvecRuntimeError('unavailable', message, causeCode);
  }
  return new ZvecRuntimeError('unknown', message, causeCode);
}

async function readZvecPackageVersion(): Promise<string | null> {
  try {
    const entryPath = require.resolve('@zvec/zvec');
    const packagePath = join(dirname(dirname(entryPath)), 'package.json');
    const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function assertStatuses(status: ZVecStatus | readonly ZVecStatus[]): void {
  const statuses: readonly ZVecStatus[] = Array.isArray(status) ? status : [status];
  const failures = statuses.filter((item) => !item.ok);
  if (failures.length > 0) {
    const first = failures[0];
    throw new ZvecRuntimeError('unknown', first?.message ?? 'Zvec operation failed', first?.code);
  }
}

function baseReport(
  runtimeAvailable: boolean,
  status: ZvecRuntimeStatus,
  packageVersion: string | null,
  accessMode: ZvecAccessMode,
  collectionPath: string | null,
  docCount: number | null,
  detail?: string,
): ZvecRuntimeReport {
  return {
    runtimeAvailable,
    status,
    packageVersion,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    accessMode,
    collectionPath,
    docCount,
    ...(detail === undefined ? {} : { detail }),
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}
