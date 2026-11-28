import Database, { type Statement } from 'better-sqlite3';
import {
  errorCodes,
  parseCandidate,
  parseEvidenceEvent,
  parseObservation,
  type Candidate,
  type EvidenceEvent,
  type MemoryType,
  type Observation,
  TagaError,
} from '../../domain/src/index.js';
import { adoptProjectIdentity, normalizeProjectKey } from '../../project-context/src/index.js';
import { migrations, runMigrations, type Migration } from './migrations.js';

type SqliteDatabase = Database.Database;

export interface DatabaseOptions {
  readonly migrations?: readonly Migration[];
  readonly now?: () => Date;
  readonly busyTimeoutMs?: number;
}

export interface JobInput {
  readonly id: string;
  readonly kind: string;
  readonly payload: string;
  readonly availableAt?: string;
}

export interface JobRecord {
  readonly id: string;
  readonly kind: string;
  readonly payload: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';
  readonly attempts: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseUntil: string | null;
  readonly lastError: string | null;
}

export interface MemoryIndexEntry {
  readonly id: string;
  readonly type: MemoryType;
  readonly status: string;
  readonly visibility: string;
  readonly scopeKind: string;
  readonly scopeId: string | null;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly commands?: readonly string[];
  readonly errorCodes?: readonly string[];
  readonly aliases?: readonly string[];
  readonly sourceRefs?: readonly string[];
  readonly confidence: number;
  readonly sourceTrust: string;
  readonly contentHash: string;
  readonly updatedAt: string;
  readonly usefulCount?: number;
  readonly notUsefulCount?: number;
  readonly lastVerified?: string;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly integrity: readonly string[];
  readonly foreignKeys: readonly string[];
  readonly schemaVersion: number;
}

export interface AuditEventInput {
  readonly id: string;
  readonly eventType: string;
  readonly actor: string;
  readonly actorId?: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly eventHash: string;
  readonly prevHash?: string;
  readonly payload: string;
  readonly occurredAt: string;
}

export type StoredAuditEvent = AuditEventInput;

export interface StoredCursor {
  readonly offset: number;
  readonly sourceVersion: string;
  readonly updatedAt: string;
}

export interface SessionObservationInput {
  readonly id: string;
  readonly sessionId: string;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly kind: string;
  readonly summary: string;
  readonly body?: string;
  readonly memoryIds: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly contentHash: string;
  readonly visibility?: 'normal' | 'redacted' | 'excluded';
}

export interface SessionObservation extends SessionObservationInput {
  readonly createdAt: string;
  readonly visibility: 'normal' | 'redacted' | 'excluded';
}

export interface StoredProjectContext {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly source: string;
  readonly canonicalKey: string;
  readonly gitRemote?: string;
  readonly lastSeenAt: string;
}

export interface StoredSessionContext {
  readonly sessionId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly agentId: string;
  readonly source: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class DatabaseStore {
  private readonly database: SqliteDatabase;
  private readonly now: () => Date;

  constructor(path: string, options: DatabaseOptions = {}) {
    this.database = new Database(path);
    this.now = options.now ?? (() => new Date());
    this.database.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    runMigrations(this.database, options.migrations ?? migrations, () => this.now().toISOString());
  }

  transaction<T>(work: () => T): T {
    return this.database.transaction(work)();
  }

  upsertMetadata(key: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO metadata (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, this.now().toISOString());
  }

  getMetadata(key: string): string | null {
    const row = this.database
      .prepare('SELECT value FROM metadata WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  listMetadata(prefix?: string): readonly { key: string; value: string }[] {
    const rows = prefix === undefined
      ? this.database.prepare('SELECT key, value FROM metadata ORDER BY key').all()
      : this.database.prepare('SELECT key, value FROM metadata WHERE key LIKE ? ORDER BY key').all(`${prefix}%`);
    return rows.map((row) => row as { key: string; value: string });
  }

  saveCursor(id: string, offset: number, sourceVersion: string): void {
    if (!Number.isInteger(offset) || offset < 0) throw new TagaError(errorCodes.validationFailed, 'cursor offset must be a non-negative integer');
    this.upsertMetadata(`cursor:${id}`, JSON.stringify({ offset, sourceVersion, updatedAt: this.now().toISOString() }));
  }

  getCursor(id: string): StoredCursor | null {
    const value = this.getMetadata(`cursor:${id}`);
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value) as StoredCursor;
      return Number.isInteger(parsed.offset) && parsed.offset >= 0 && typeof parsed.sourceVersion === 'string' && typeof parsed.updatedAt === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  enqueueJob(input: JobInput): void {
    const timestamp = this.now().toISOString();
    this.database
      .prepare(
        `INSERT INTO jobs
          (id, kind, payload, status, attempts, available_at, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(input.id, input.kind, input.payload, input.availableAt ?? timestamp, timestamp, timestamp);
  }

  enqueueJobIfAbsent(input: JobInput): boolean {
    const timestamp = this.now().toISOString();
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO jobs
          (id, kind, payload, status, attempts, available_at, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(input.id, input.kind, input.payload, input.availableAt ?? timestamp, timestamp, timestamp);
    return result.changes === 1;
  }

  acquireJob(jobId: string, workerId: string, leaseMs: number): JobRecord | null {
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
      throw new TagaError(errorCodes.validationFailed, 'leaseMs must be a positive integer');
    }
    return this.transaction(() => {
      const current = this.getJob(jobId);
      if (current === null) {
        return null;
      }
      const now = this.now();
      const leaseExpired = current.leaseUntil !== null && current.leaseUntil <= now.toISOString();
      const available = current.availableAt <= now.toISOString();
      const claimable = available &&
        (current.status === 'queued' ||
          (current.status === 'running' && leaseExpired) ||
          (current.status === 'failed' && (current.leaseUntil === null || leaseExpired)));
      if (!claimable) {
        return null;
      }
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      this.database
        .prepare(
          `UPDATE jobs
           SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_until = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(workerId, leaseUntil, now.toISOString(), jobId);
      return this.getJob(jobId);
    });
  }

  completeJob(jobId: string, workerId: string): void {
    this.updateLeasedJob(jobId, workerId, 'succeeded', null);
  }

  /** Rewrites a queued job's payload (used to merge events into a batched job). */
  updateJobPayload(jobId: string, payload: string): boolean {
    const result = this.database
      .prepare("UPDATE jobs SET payload = ? WHERE id = ? AND status = 'queued'")
      .run(payload, jobId);
    return result.changes === 1;
  }

  failJob(jobId: string, workerId: string, error: string, retryAt?: string): void {
    this.updateLeasedJob(jobId, workerId, retryAt === undefined ? 'dead' : 'failed', error, retryAt);
  }

  getJob(jobId: string): JobRecord | null {
    const row = this.database
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get(jobId) as JobRow | undefined;
    return row === undefined ? null : toJobRecord(row);
  }

  deleteJobs(jobIds: readonly string[]): number {
    if (jobIds.length === 0) return 0;
    return this.transaction(() => {
      const statement = this.database.prepare('DELETE FROM jobs WHERE id = ?');
      let removed = 0;
      for (const jobId of jobIds) removed += statement.run(jobId).changes;
      return removed;
    });
  }

  upsertMemoryIndex(entry: MemoryIndexEntry): void {
    this.transaction(() => this.writeMemoryIndex(entry));
  }

  removeMemoryIndex(memoryId: string): void {
    this.transaction(() => {
      this.database.prepare('DELETE FROM memory_fts_v2 WHERE memory_id = ?').run(memoryId);
      this.database.prepare('DELETE FROM memory_fts_tri WHERE memory_id = ?').run(memoryId);
      this.database.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
    });
  }

  rebuildMemoryIndex(entries: readonly MemoryIndexEntry[]): void {
    const statements = this.memoryIndexStatements();
    this.transaction(() => {
      this.database.prepare('DELETE FROM memory_fts_v2').run();
      this.database.prepare('DELETE FROM memory_fts_tri').run();
      for (const entry of entries) {
        this.writeMemoryIndex(entry, statements, false);
      }
    });
  }
  searchMemoryIndex(query: string, limit: number): MemoryIndexMatch[] {
    return this.database
      .prepare(
        `SELECT m.payload AS payload, bm25(memory_fts_v2, 0, 8, 5, 1, 4, 6, 6, 5, 7, 3) AS rank
         FROM memory_fts_v2
         JOIN memories AS m ON m.id = memory_fts_v2.memory_id
         WHERE memory_fts_v2 MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit)
      .map((row) => toMemoryIndexMatch(row as { payload: string; rank: number }));
  }

  searchMemoryTrigram(query: string, limit: number): MemoryIndexMatch[] {
    return this.database
      .prepare(
        `SELECT m.payload AS payload, bm25(memory_fts_tri) AS rank
         FROM memory_fts_tri
         JOIN memories AS m ON m.id = memory_fts_tri.memory_id
         WHERE memory_fts_tri MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit)
      .map((row) => toMemoryIndexMatch(row as { payload: string; rank: number }));
  }
  getMemoryIndex(memoryId: string): MemoryIndexEntry | null {
    const row = this.database
      .prepare('SELECT payload FROM memories WHERE id = ?')
      .get(memoryId) as { payload: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.payload) as MemoryIndexEntry);
  }

  listMemoryIndex(): readonly MemoryIndexEntry[] {
    return this.database
      .prepare('SELECT payload FROM memories ORDER BY id')
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload) as MemoryIndexEntry);
  }

  listJobs(): readonly JobRecord[] {
    return this.database
      .prepare('SELECT * FROM jobs ORDER BY id')
      .all()
      .map((row) => toJobRecord(row as JobRow));
  }

  saveEvidence(event: EvidenceEvent): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO evidence_events
          (id, content_hash, source, sensitivity, payload, occurred_at, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.contentHash,
        event.source,
        event.sensitivity,
        JSON.stringify(event),
        event.occurredAt,
        event.capturedAt,
      );
    return result.changes === 1;
  }

  getEvidence(id: string): EvidenceEvent | null {
    const row = this.database
      .prepare('SELECT payload FROM evidence_events WHERE id = ?')
      .get(id) as { payload: string } | undefined;
    return row === undefined ? null : parseEvidenceEvent(JSON.parse(row.payload) as unknown);
  }

  listEvidence(): readonly EvidenceEvent[] {
    return this.database
      .prepare('SELECT payload FROM evidence_events ORDER BY rowid')
      .all()
      .map((row) => parseEvidenceEvent(JSON.parse((row as { payload: string }).payload) as unknown));
  }

  saveObservation(observation: Observation): boolean {
    const key = `observation:${observation.id}`;
    if (this.getMetadata(key) !== null) return false;
    this.upsertMetadata(key, JSON.stringify(observation));
    return true;
  }

  listObservations(): readonly Observation[] {
    return this.listMetadata('observation:')
      .map(({ value }) => parseObservation(JSON.parse(value) as unknown));
  }

  /** Persists the project and returns its effective id: an existing record of the same repository
   * under a different remote form (https vs ssh) is adopted so memories keep their binding. When
   * several stored rows match, the one that actually owns memories wins, then the oldest. */
  saveProjectContext(project: Omit<StoredProjectContext, 'lastSeenAt'>): string {
    const timestamp = this.now().toISOString();
    const incoming = normalizeProjectKey(project.canonicalKey);
    const matchesRemote = (key: string | undefined): boolean => typeof key === 'string' && key.length > 0 && normalizeProjectKey(key) === incoming;
    const memoryCount = this.database.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope_kind = 'project' AND scope_id = ?");
    const ranked = [...this.listProjectContexts()]
      .filter((row) => row.id !== project.id && (matchesRemote(row.canonicalKey) || matchesRemote(row.gitRemote)))
      .sort((left, right) =>
        ((memoryCount.get(right.id) as { n: number } | undefined)?.n ?? 0) - ((memoryCount.get(left.id) as { n: number } | undefined)?.n ?? 0)
        || (left.lastSeenAt ?? '').localeCompare(right.lastSeenAt ?? ''));
    const adoptedId = adoptProjectIdentity(project, ranked).id;
    const payload = JSON.stringify({ ...project, id: adoptedId, lastSeenAt: timestamp });
    this.database
      .prepare(
        `INSERT INTO projects (id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(adoptedId, payload, timestamp);
    this.database
      .prepare(
        `INSERT INTO project_roots (project_id, local_path, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, local_path) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(adoptedId, project.root, timestamp, timestamp);
    return adoptedId;
  }

  listProjectContexts(): readonly StoredProjectContext[] {
    return this.database
      .prepare('SELECT payload FROM projects ORDER BY updated_at DESC, id')
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload) as StoredProjectContext);
  }

  saveSessionContext(input: Omit<StoredSessionContext, 'createdAt' | 'updatedAt'>): StoredSessionContext {
    const timestamp = this.now().toISOString();
    this.database
      .prepare(
        `INSERT INTO session_contexts
          (session_id, project_id, project_root, cwd, agent_id, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           project_id = excluded.project_id,
           project_root = excluded.project_root,
           cwd = excluded.cwd,
           agent_id = excluded.agent_id,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run(input.sessionId, input.projectId, input.projectRoot, input.cwd, input.agentId, input.source, timestamp, timestamp);
    return this.getSessionContext(input.sessionId) as StoredSessionContext;
  }

  getSessionContext(sessionId: string): StoredSessionContext | null {
    const row = this.database
      .prepare('SELECT * FROM session_contexts WHERE session_id = ?')
      .get(sessionId) as SessionContextRow | undefined;
    return row === undefined ? null : toStoredSessionContext(row);
  }

  saveSessionObservation(input: SessionObservationInput): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO session_observations
          (id, session_id, task_id, project_id, occurred_at, sequence, kind, summary, body,
           memory_ids, source_refs, content_hash, visibility, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.taskId ?? null,
        input.projectId ?? null,
        input.occurredAt,
        input.sequence,
        input.kind,
        input.summary,
        input.body ?? null,
        JSON.stringify(input.memoryIds),
        JSON.stringify(input.sourceRefs),
        input.contentHash,
        input.visibility ?? 'normal',
        this.now().toISOString(),
      );
    return result.changes === 1;
  }

  listSessionObservations(options: {
    readonly sessionId?: string;
    readonly taskId?: string;
    readonly projectId?: string;
    readonly memoryId?: string;
    readonly limit?: number;
  } = {}): readonly SessionObservation[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (options.sessionId !== undefined) {
      clauses.push('session_id = ?');
      values.push(options.sessionId);
    }
    if (options.taskId !== undefined) {
      clauses.push('task_id = ?');
      values.push(options.taskId);
    }
    if (options.projectId !== undefined) {
      clauses.push('project_id = ?');
      values.push(options.projectId);
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = this.database
      .prepare(`SELECT * FROM session_observations ${where} ORDER BY occurred_at DESC, sequence DESC LIMIT ?`)
      .all(...values, limit) as SessionObservationRow[];
    return rows
      .map(toSessionObservation)
      .filter((item) => options.memoryId === undefined || item.memoryIds.includes(options.memoryId));
  }

  saveCandidate(candidate: Candidate): boolean {
    const key = `candidate:${candidate.id}`;
    const current = this.getMetadata(key);
    if (current === JSON.stringify(candidate)) return false;
    this.upsertMetadata(key, JSON.stringify(candidate));
    return true;
  }

  getCandidate(id: string): Candidate | null {
    const value = this.getMetadata(`candidate:${id}`);
    return value === null ? null : parseCandidate(JSON.parse(value) as unknown);
  }

  listCandidates(): readonly Candidate[] {
    return this.listMetadata('candidate:')
      .map(({ value }) => parseCandidate(JSON.parse(value) as unknown));
  }

  addTombstone(subjectType: string, subjectId: string, contentHash: string | null, reason: string): void {
    this.database
      .prepare(
        `INSERT INTO tombstones (identity, reason, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(identity) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`,
      )
      .run(`${subjectType}:${subjectId}`, contentHash === null ? reason : `${reason};${contentHash}`, this.now().toISOString());
  }

  hasTombstone(subjectType: string, subjectId: string): boolean {
    const row = this.database
      .prepare('SELECT 1 AS found FROM tombstones WHERE identity = ?')
      .get(`${subjectType}:${subjectId}`) as { found: number } | undefined;
    return row !== undefined;
  }

  listTombstones(): readonly string[] {
    return this.database
      .prepare('SELECT identity FROM tombstones ORDER BY identity')
      .all()
      .map((row) => (row as { identity: string }).identity);
  }

  lastAuditHash(): string | undefined {
    const row = this.database
      .prepare('SELECT event_hash FROM audit_events ORDER BY rowid DESC LIMIT 1')
      .get() as { event_hash: string } | undefined;
    return row?.event_hash;
  }

  appendAuditEvent(event: AuditEventInput): void {
    this.database
      .prepare(
        `INSERT INTO audit_events
          (id, event_type, actor, actor_id, subject_type, subject_id, event_hash, prev_hash, payload, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.eventType,
        event.actor,
        event.actorId ?? null,
        event.subjectType,
        event.subjectId,
        event.eventHash,
        event.prevHash ?? null,
        event.payload,
        event.occurredAt,
      );
  }

  listAuditEvents(): readonly StoredAuditEvent[] {
    return this.database
      .prepare('SELECT id, event_type, actor, actor_id, subject_type, subject_id, event_hash, prev_hash, payload, occurred_at FROM audit_events ORDER BY rowid')
      .all()
      .map((row) => {
        const value = row as {
          id: string;
          event_type: string;
          actor: string;
          actor_id: string | null;
          subject_type: string;
          subject_id: string;
          event_hash: string;
          prev_hash: string | null;
          payload: string;
          occurred_at: string;
        };
        return {
          id: value.id,
          eventType: value.event_type,
          actor: value.actor,
          ...(value.actor_id === null ? {} : { actorId: value.actor_id }),
          subjectType: value.subject_type,
          subjectId: value.subject_id,
          eventHash: value.event_hash,
          ...(value.prev_hash === null ? {} : { prevHash: value.prev_hash }),
          payload: value.payload,
          occurredAt: value.occurred_at,
        };
      });
  }

  integrityCheck(): IntegrityReport {
    const integrityRows = this.database.pragma('integrity_check') as Array<{
      integrity_check: string;
    }>;
    const integrity = integrityRows.map((row) => row.integrity_check);
    const foreignKeyRows = this.database.pragma('foreign_key_check') as Array<
      Record<string, unknown>
    >;
    const foreignKeys = foreignKeyRows.map((row) => JSON.stringify(row));
    const schema = this.database
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null };
    return {
      ok: integrity.length === 1 && integrity[0] === 'ok' && foreignKeys.length === 0,
      integrity,
      foreignKeys,
      schemaVersion: schema.version ?? 0,
    };
  }

  close(): void {
    this.database.close();
  }

  private writeMemoryIndex(
    entry: MemoryIndexEntry,
    statements: MemoryIndexStatements = this.memoryIndexStatements(),
    removeExisting = true,
  ): void {
    statements.upsert
      .run(
        entry.id,
        entry.status,
        entry.scopeKind,
        entry.scopeId,
        entry.contentHash,
        JSON.stringify(entry),
        entry.updatedAt,
        entry.updatedAt,
      );
    if (removeExisting) {
      statements.remove.run(entry.id);
      statements.removeTrigrams.run(entry.id);
    }
    statements.insert
      .run(
        entry.id,
        entry.title,
        entry.summary,
        entry.body,
        entry.tags.join(' '),
        (entry.paths ?? []).join(' '),
        (entry.symbols ?? []).join(' '),
        (entry.commands ?? []).join(' '),
        (entry.errorCodes ?? []).join(' '),
        (entry.aliases ?? []).join(' '),
      );
    statements.insertTrigrams.run(entry.id, buildTrigramText(entry));
  }

  private memoryIndexStatements(): MemoryIndexStatements {
    return {
      upsert: this.database.prepare(
        `INSERT INTO memories
          (id, status, scope_kind, scope_id, content_hash, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status,
           scope_kind = excluded.scope_kind, scope_id = excluded.scope_id,
           content_hash = excluded.content_hash, payload = excluded.payload,
           updated_at = excluded.updated_at`,
      ),
      remove: this.database.prepare('DELETE FROM memory_fts_v2 WHERE memory_id = ?'),
      removeTrigrams: this.database.prepare('DELETE FROM memory_fts_tri WHERE memory_id = ?'),
      insert: this.database.prepare(
        `INSERT INTO memory_fts_v2
          (memory_id, title, summary, body, tags, paths, symbols, commands, error_codes, aliases)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertTrigrams: this.database.prepare(
        'INSERT INTO memory_fts_tri (memory_id, trigrams) VALUES (?, ?)',
      ),
    };
  }
  private updateLeasedJob(
    jobId: string,
    workerId: string,
    status: JobRecord['status'],
    lastError: string | null,
    retryAt?: string,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE jobs
         SET status = ?, available_at = COALESCE(?, available_at), lease_owner = NULL,
             lease_until = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
      )
      .run(status, retryAt ?? null, lastError, this.now().toISOString(), jobId, workerId);
    if (result.changes !== 1) {
      throw new TagaError(errorCodes.conflict, 'job lease is not owned by worker', {
        jobId,
      });
    }
  }
}

interface JobRow {
  id: string;
  kind: string;
  payload: string;
  status: JobRecord['status'];
  attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_until: string | null;
  last_error: string | null;
}

interface SessionObservationRow {
  id: string;
  session_id: string;
  task_id: string | null;
  project_id: string | null;
  occurred_at: string;
  sequence: number;
  kind: string;
  summary: string;
  body: string | null;
  memory_ids: string;
  source_refs: string;
  content_hash: string;
  visibility: 'normal' | 'redacted' | 'excluded';
  created_at: string;
}

interface SessionContextRow {
  session_id: string;
  project_id: string;
  project_root: string;
  cwd: string;
  agent_id: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryIndexMatch {
  readonly entry: MemoryIndexEntry;
  readonly rank: number;
}

interface MemoryIndexStatements {
  readonly upsert: Statement;
  readonly remove: Statement;
  readonly removeTrigrams: Statement;
  readonly insert: Statement;
  readonly insertTrigrams: Statement;
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
  };
}
function toMemoryIndexMatch(row: { payload: string; rank: number }): MemoryIndexMatch {
  return {
    entry: JSON.parse(row.payload) as MemoryIndexEntry,
    rank: row.rank,
  };
}

function toSessionObservation(row: SessionObservationRow): SessionObservation {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    occurredAt: row.occurred_at,
    sequence: row.sequence,
    kind: row.kind,
    summary: row.summary,
    ...(row.body === null ? {} : { body: row.body }),
    memoryIds: parseStringArray(row.memory_ids),
    sourceRefs: parseStringArray(row.source_refs),
    contentHash: row.content_hash,
    visibility: row.visibility,
    createdAt: row.created_at,
  };
}

function toStoredSessionContext(row: SessionContextRow): StoredSessionContext {
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    projectRoot: row.project_root,
    cwd: row.cwd,
    agentId: row.agent_id,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function buildTrigramText(entry: MemoryIndexEntry): string {
  const text = [
    entry.title,
    ...entry.tags,
    ...(entry.paths ?? []),
    ...(entry.symbols ?? []),
    ...(entry.commands ?? []),
    ...(entry.errorCodes ?? []),
    ...(entry.aliases ?? []),
  ].join(' ').normalize('NFKC').toLocaleLowerCase();
  const terms = text.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const trigrams = new Set<string>();
  for (const term of terms) {
    const characters = Array.from(term);
    for (let index = 0; index <= characters.length - 3; index += 1) {
      trigrams.add(characters.slice(index, index + 3).join(''));
    }
  }
  return [...trigrams].join(' ');
}
