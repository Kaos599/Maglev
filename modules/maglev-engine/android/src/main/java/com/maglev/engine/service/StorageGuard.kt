package com.maglev.engine.service

/**
 * Pure low-storage reserve math (docs/contracts-0.19/play-and-storage.md section 2). No android.* imports.
 * Port of native/maglev-core/src/storage_guard.rs; both pass scripts/fixtures/storage-reserve-vectors.json.
 */
object StorageGuard {
    const val FLOOR_BYTES = 500L * 1024 * 1024
    const val DIVISOR = 50L
    /** Largest reserve: 2% of a 256 GB phone is 5 GB, which paused every download on a phone with 4 GB free. */
    const val CAP_BYTES = 1024L * 1024 * 1024
    const val HYSTERESIS_BYTES = 200L * 1024 * 1024
    const val POLL_MS = 15_000L

    /** `min(1 GiB, max(500 MiB, 2% of the volume))`. An unknown size (0) gives the floor. */
    fun reserve(total: Long): Long = minOf(CAP_BYTES, maxOf(FLOOR_BYTES, total / DIVISOR))

    /** Not blocked: block under the reserve. Blocked: stay blocked until reserve plus 200 MiB is free. */
    fun next(blocked: Boolean, free: Long, total: Long): Boolean {
        val r = reserve(total)
        return if (blocked) free < r + HYSTERESIS_BYTES else free < r
    }

    /**
     * Free space to hand to `Admission.admit` on the share card: [free] less the part of the reserve Admission
     * does not already keep (it keeps 200 MiB), so a "Download" the card offers is not paused at once.
     */
    fun shareCardFree(free: Long, total: Long): Long =
        (free - (reserve(total) - com.maglev.engine.storage.Admission.RESERVE_BYTES).coerceAtLeast(0L)).coerceAtLeast(0L)

    /** Notification title and text while storage pauses everything (contract section 2). */
    const val PAUSED_TITLE = "Paused: phone storage is almost full"
    const val PAUSED_TEXT = "Free up space"
}
