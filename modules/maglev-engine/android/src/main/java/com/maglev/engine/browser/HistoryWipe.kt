package com.maglev.engine.browser

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File

/**
 * "Clear history when I close Maglev" (docs/NATIVE_CONTRACT.md section 24.9).
 * JS owns the history table (expo-sqlite, `<filesDir>/SQLite/maglev-history.db`); native only keeps the flag and, when the app
 * closes, empties the table. JS also empties it on the next cold start, which covers a kill that has no callback.
 */
object HistoryWipe {
    private const val PREFS = "maglev.history"
    private const val KEY = "wipeOnClose"
    private const val DB_NAME = "maglev-history.db"

    fun setArmed(context: Context, enabled: Boolean) {
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, enabled).apply()
    }

    fun isArmed(context: Context): Boolean =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, false)

    /** Opens the database file (never creates it) and deletes every page. A missing file or any error is ignored. */
    fun wipeIfArmed(context: Context) {
        if (!isArmed(context)) return
        try {
            val file = File(File(context.applicationContext.filesDir, "SQLite"), DB_NAME)
            if (!file.exists()) return
            val db = SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE)
            try {
                db.execSQL("DELETE FROM pages")
            } finally {
                db.close()
            }
        } catch (_: Throwable) {
        }
    }
}
