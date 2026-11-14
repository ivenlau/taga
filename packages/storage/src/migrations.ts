import type Database from 'better-sqlite3';

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(database: Database.Database): void;
}

export const migration001: Migration = {
  version: 1,
  name: 'initial',
  up(database): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evidence_events (
        id TEXT PRIMARY KEY NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        payload TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY NOT NULL,
        observation_id TEXT NOT NULL REFERENCES observations(id),
        decision TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id TEXT,
        content_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_id TEXT,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE,
        prev_hash TEXT,
        payload TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tombstones (
        identity TEXT PRIMARY KEY NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, available_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        title,
        summary,
        body,
        tags
      );
    `);
  },
};

export const migration002: Migration = {
  version: 2,
  name: 'audit actor identity',
  up(database): void {
    const columns = database.prepare('PRAGMA table_info(audit_events)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'actor_id')) {
      database.exec('ALTER TABLE audit_events ADD COLUMN actor_id TEXT');
    }
  },
};

export const migration003: Migration = {
  version: 3,
  name: 'offline lexical retrieval indexes',
  up(database): void {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_v2 USING fts5(
        memory_id UNINDEXED,
        title,
        summary,
        body,
        tags,
        paths,
        symbols,
        commands,
        error_codes,
        aliases
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_tri USING fts5(
        memory_id UNINDEXED,
        trigrams
      );
    `);

    database.exec(`
      INSERT OR IGNORE INTO memory_fts_v2
        (memory_id, title, summary, body, tags, paths, symbols, commands, error_codes, aliases)
      SELECT memory_id, title, summary, body, tags, '', '', '', '', tags
      FROM memory_fts;
    `);
  },
};

export const migration004: Migration = {
  version: 4,
  name: 'session observations',
  up(database): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS session_observations (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT,
        project_id TEXT,
        occurred_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT,
        memory_ids TEXT NOT NULL,
        source_refs TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        visibility TEXT NOT NULL DEFAULT 'normal',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_observations_session
        ON session_observations(session_id, occurred_at, sequence);
      CREATE INDEX IF NOT EXISTS idx_session_observations_project
        ON session_observations(project_id, occurred_at);
    `);
  },
};

export const migrations: readonly Migration[] = [migration001, migration002, migration003, migration004];

export function runMigrations(
  database: Database.Database,
  migrationList: readonly Migration[] = migrations,
  now: () => string = () => new Date().toISOString(),
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => Number((row as { version: number }).version)),
  );

  for (const migration of migrationList) {
    if (applied.has(migration.version)) {
      continue;
    }
    database.transaction(() => {
      migration.up(database);
      database
        .prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        )
        .run(migration.version, migration.name, now());
    })();
  }
}
