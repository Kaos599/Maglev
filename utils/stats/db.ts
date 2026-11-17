/** expo-sqlite binding for the stats store (docs/NATIVE_CONTRACT.md section 34.2). */
import * as SQLite from 'expo-sqlite';
import { STATS_DB_NAME, migrate, type StatsDb } from './schema.ts';

export async function openStatsDb(): Promise<StatsDb> {
  const db = await SQLite.openDatabaseAsync(STATS_DB_NAME);
  const adapter: StatsDb = {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params = []) => {
      const r = await db.runAsync(sql, params);
      return { changes: r.changes };
    },
    all: <T,>(sql: string, params: (string | number | null)[] = []) => db.getAllAsync<T>(sql, params) as Promise<T[]>,
  };
  await migrate(adapter);
  return adapter;
}
