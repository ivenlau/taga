import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TemporaryDirectory {
  readonly path: string;
  cleanup(): Promise<void>;
}

export async function createTemporaryDirectory(
  prefix = 'taga-test-',
): Promise<TemporaryDirectory> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  let cleaned = false;

  return {
    path,
    async cleanup(): Promise<void> {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await rm(path, { recursive: true, force: true });
    },
  };
}
