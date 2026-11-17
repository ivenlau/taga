import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

export const BGE_M3_MODEL_ID = 'Xenova/bge-m3';
export const BGE_M3_MODEL_REVISION = '4de13258303883538bd53b696b452bf8099f0858';

export interface BgeM3ModelInspection {
  readonly path: string;
  readonly valid: boolean;
  readonly missingFiles: readonly string[];
}

export interface BgeM3DownloadProgress {
  readonly file: string;
  readonly fileLoaded: number;
  readonly fileTotal: number;
  readonly loaded: number;
  readonly total: number;
}

interface ModelFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface DownloadBgeM3ModelOptions {
  readonly brainPath: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BgeM3DownloadProgress) => void;
  readonly fetcher?: typeof fetch;
  readonly files?: readonly ModelFile[];
  readonly modelId?: string;
  readonly revision?: string;
}

const modelFiles: readonly ModelFile[] = [
  { path: 'config.json', size: 770, sha256: '734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95' },
  { path: 'onnx/model.onnx', size: 607_298, sha256: '5d89a0010dd39aa2cfa8b22bb49f06904c5bbf5877135f877da419480f40cde3' },
  { path: 'onnx/model.onnx_data', size: 2_266_820_608, sha256: '1eebfb28493f67bba03ce0ef64bfdc7fc5a3bd9d7493f818bb1d78cd798416b4' },
  { path: 'sentencepiece.bpe.model', size: 5_069_051, sha256: 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865' },
  { path: 'special_tokens_map.json', size: 964, sha256: '8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835' },
  { path: 'tokenizer.json', size: 17_082_821, sha256: '6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790' },
  { path: 'tokenizer_config.json', size: 1_173, sha256: '7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4' },
];

export const BGE_M3_DOWNLOAD_BYTES = modelFiles.reduce((total, file) => total + file.size, 0);

export function defaultBgeM3ModelPath(brainPath: string): string {
  return join(brainPath, 'models', ...safePathSegments(BGE_M3_MODEL_ID));
}

export async function inspectBgeM3Model(modelPath: string): Promise<BgeM3ModelInspection> {
  const missingFiles: string[] = [];
  for (const file of modelFiles) {
    const path = join(modelPath, ...file.path.split('/'));
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size !== file.size) missingFiles.push(file.path);
    } catch {
      missingFiles.push(file.path);
    }
  }
  return { path: modelPath, valid: missingFiles.length === 0, missingFiles };
}

export async function downloadBgeM3Model(options: DownloadBgeM3ModelOptions): Promise<string> {
  const files = options.files ?? modelFiles;
  const modelId = options.modelId ?? BGE_M3_MODEL_ID;
  const revision = options.revision ?? BGE_M3_MODEL_REVISION;
  const fetcher = options.fetcher ?? fetch;
  const cacheRoot = join(options.brainPath, 'models');
  const modelPath = join(cacheRoot, ...safePathSegments(modelId));
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;

  await mkdir(modelPath, { recursive: true });
  for (const file of files) {
    const fileSegments = safePathSegments(file.path);
    const target = join(modelPath, ...fileSegments);
    if (await isVerifiedFile(target, file)) {
      completed += file.size;
      options.onProgress?.({ file: file.path, fileLoaded: file.size, fileTotal: file.size, loaded: completed, total });
      continue;
    }
    const part = `${target}.part`;
    await mkdir(dirname(target), { recursive: true });
    let offset = await fileSize(part);
    if (offset > file.size) {
      await rm(part, { force: true });
      offset = 0;
    }
    if (offset === file.size) {
      if (await sha256File(part) === file.sha256) {
        await rm(target, { force: true });
        await rename(part, target);
        completed += file.size;
        options.onProgress?.({ file: file.path, fileLoaded: file.size, fileTotal: file.size, loaded: completed, total });
        continue;
      }
      await rm(part, { force: true });
      offset = 0;
    }
    const encodedModelId = safePathSegments(modelId).map(encodeURIComponent).join('/');
    const encodedFile = fileSegments.map(encodeURIComponent).join('/');
    const url = `https://huggingface.co/${encodedModelId}/resolve/${encodeURIComponent(revision)}/${encodedFile}`;
    const response = await fetcher(url, {
      redirect: 'follow',
      ...(offset === 0 ? {} : { headers: { Range: `bytes=${offset}-` } }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok && response.status !== 206) throw new Error(`BGE-M3 download failed for ${file.path}: HTTP ${response.status}`);
    if (response.body === null) throw new Error(`BGE-M3 download failed for ${file.path}: empty response body`);
    const append = offset > 0 && response.status === 206;
    if (!append) offset = 0;
    let fileLoaded = offset;
    const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
    source.on('data', (chunk: Buffer) => {
      fileLoaded += chunk.length;
      options.onProgress?.({ file: file.path, fileLoaded, fileTotal: file.size, loaded: completed + fileLoaded, total });
    });
    await pipeline(source, createWriteStream(part, { flags: append ? 'a' : 'w' }), { signal: options.signal });
    if (await fileSize(part) !== file.size) throw new Error(`BGE-M3 download is incomplete for ${file.path}`);
    if (await sha256File(part) !== file.sha256) {
      await rm(part, { force: true });
      throw new Error(`BGE-M3 checksum verification failed for ${file.path}`);
    }
    await rm(target, { force: true });
    await rename(part, target);
    completed += file.size;
    options.onProgress?.({ file: file.path, fileLoaded: file.size, fileTotal: file.size, loaded: completed, total });
  }

  return modelPath;
}

async function isVerifiedFile(path: string, file: ModelFile): Promise<boolean> {
  try {
    await access(path);
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size === file.size && await sha256File(path) === file.sha256;
  } catch {
    return false;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function safePathSegments(value: string): string[] {
  const segments = value.split('/');
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes(':'))) {
    throw new Error(`invalid model resource path: ${value}`);
  }
  return segments;
}
