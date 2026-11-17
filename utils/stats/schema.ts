/**
 * Local stats schema (docs/NATIVE_CONTRACT.md section 34.2). Pure: the database is injected.
 * Its own file (`maglev-stats.db`): the browser history wipe deletes `maglev-history.db`, and a wipe must never take stats with it.
 */

export interface StatsDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: (string | number | null)[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: (string | number | null)[]): Promise<T[]>;
}

export const STATS_DB_NAME = 'maglev-stats.db';

/** One entry per schema version, oldest first. Never edit a shipped entry: add a new one. */
/** A step is SQL, or a function for a change SQL cannot make safely twice (ALTER TABLE ADD COLUMN). */
export type Step = string | ((db: StatsDb) => Promise<void>);

async function addColumn(db: StatsDb, table: string, column: string, ddl: string): Promise<void> {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export const MIGRATIONS: readonly (readonly Step[])[] = [
  [
    `CREATE TABLE IF NOT EXISTS stats (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      source TEXT,
      active_secs INTEGER NOT NULL DEFAULT 0,
      session_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded INTEGER NOT NULL DEFAULT 0,
      bytes_wifi INTEGER NOT NULL DEFAULT 0,
      bytes_mobile INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL DEFAULT 0,
      finished_at INTEGER NOT NULL,
      retries INTEGER NOT NULL DEFAULT 0
    )`,
    'CREATE INDEX IF NOT EXISTS stats_finished ON stats(finished_at)',
    `CREATE TABLE IF NOT EXISTS stats_daily (
      day TEXT PRIMARY KEY,
      downloaded INTEGER NOT NULL DEFAULT 0,
      uploaded INTEGER NOT NULL DEFAULT 0,
      mobile INTEGER NOT NULL DEFAULT 0,
      wifi INTEGER NOT NULL DEFAULT 0,
      finished INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      cancelled INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS stats_monthly (
      month TEXT PRIMARY KEY,
      downloaded INTEGER NOT NULL DEFAULT 0,
      uploaded INTEGER NOT NULL DEFAULT 0,
      wifi INTEGER NOT NULL DEFAULT 0,
      mobile INTEGER NOT NULL DEFAULT 0,
      finished INTEGER NOT NULL DEFAULT 0,
      active_secs INTEGER NOT NULL DEFAULT 0,
      retried INTEGER NOT NULL DEFAULT 0
    )`,
  ],
  // 0.27: live time. Old rows read 0; a crash between the ALTER and the version bump is harmless because the column is checked first.
  [(db) => addColumn(db, 'stats_daily', 'active_secs', 'INTEGER NOT NULL DEFAULT 0')],
];

export const STATS_VERSION = MIGRATIONS.length;

/** Runs every migration the database has not seen. Safe to call on every start. */
export async function migrate(db: StatsDb): Promise<void> {
  const rows = await db.all<{ user_version: number }>('PRAGMA user_version');
  let current = Number(rows[0]?.user_version ?? 0);
  while (current < STATS_VERSION) {
    for (const step of MIGRATIONS[current]) await (typeof step === 'string' ? db.exec(step) : step(db));
    current++;
    await db.exec(`PRAGMA user_version = ${current}`);
  }
}
