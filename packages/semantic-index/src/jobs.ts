import { createHash } from 'node:crypto';
import type { DatabaseStore } from '../../storage/src/index.js';

export type SemanticJobKind = 'semantic.upsert' | 'semantic.remove' | 'semantic.rebuild' | 'semantic.optimize';

export interface SemanticJobPayload {
  readonly memoryId: string;
  readonly contentHash?: string;
}

export interface SemanticRebuildJobPayload {
  readonly requestedAt: string;
}

export function enqueueSemanticUpsert(database: DatabaseStore, memoryId: string, contentHash: string): boolean {
  return enqueue(database, 'semantic.upsert', { memoryId, contentHash });
}

export function enqueueSemanticRemove(database: DatabaseStore, memoryId: string): boolean {
  return enqueue(database, 'semantic.remove', { memoryId });
}

export function enqueueSemanticRebuild(database: DatabaseStore): boolean {
  const payload: SemanticRebuildJobPayload = { requestedAt: new Date().toISOString() };
  const id = `semantic-rebuild-${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
  return database.enqueueJobIfAbsent({ id, kind: 'semantic.rebuild', payload: JSON.stringify(payload) });
}

export function enqueueSemanticOptimize(database: DatabaseStore): boolean {
  const payload = { requestedAt: new Date().toISOString() };
  const id = `semantic-optimize-${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
  return database.enqueueJobIfAbsent({ id, kind: 'semantic.optimize', payload: JSON.stringify(payload) });
}

function enqueue(database: DatabaseStore, kind: SemanticJobKind, payload: SemanticJobPayload): boolean {
  const id = `semantic-${kind.slice('semantic.'.length)}-${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
  return database.enqueueJobIfAbsent({ id, kind, payload: JSON.stringify(payload) });
}
