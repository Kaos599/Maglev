/** expo-sqlite binding for the history store (docs/NATIVE_CONTRACT.md section 24.9). */
import * as SQLite from 'expo-sqlite';
import type { HistoryDb } from './store.ts';

/** Same name and folder the native wipe uses (modules/.../browser/HistoryWipe.kt). */
export const HISTORY_DB_NAME = 'maglev-history.db';

export async function openHistoryDb(): Promise<HistoryDb> {
  const db = await SQLite.openDatabaseAsync(HISTORY_DB_NAME);
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params = []) => {
      const r = await db.runAsync(sql, params);
      return { changes: r.changes };
    },
    all: <T,>(sql: string, params: (string | number)[] = []) => db.getAllAsync<T>(sql, params) as Promise<T[]>,
  };
}
