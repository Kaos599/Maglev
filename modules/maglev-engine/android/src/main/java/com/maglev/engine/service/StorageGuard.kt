package com.maglev.engine.service

/**
 * Pure low-storage reserve math (docs/contracts-0.19/play-and-storage.md section 2). No android.* imports.
 * Port of native/maglev-core/src/storage_guard.rs; both pass scripts/fixtures/storage-reserve-vectors.json.
 */
object StorageGuard {
    const val FLOOR_BYTES = 500L * 1024 * 1024
    const val DIVISOR = 50L
    const val HYSTERESIS_BYTES = 200L * 1024 * 1024
    const val POLL_MS = 15_000L

    /** `max(500 MiB, 2% of the volume)`. An unknown size (0) gives the floor. */
    fun reserve(total: Long): Long = maxOf(FLOOR_BYTES, total / DIVISOR)

    /** Not blocked: block under the reserve. Blocked: stay blocked until reserve plus 200 MiB is free. */
    fun next(blocked: Boolean, free: Long, total: Long): Boolean {
        val r = reserve(total)
        return if (blocked) free < r + HYSTERESIS_BYTES else free < r
    }

    /** Notification title and text while storage pauses everything (contract section 2). */
    const val PAUSED_TITLE = "Paused: phone storage is almost full"
    const val PAUSED_TEXT = "Free up space"
}
