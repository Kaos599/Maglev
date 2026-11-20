package com.maglev.engine.storage

/**
 * Admission check for adding a torrent or link download (SM-35, NATIVE_CONTRACT 10.3). Pure JVM, no android.* imports.
 * Port of `utils/admission.ts`; `scripts/fixtures/admission-vectors.json` drives both.
 */
object Admission {
    /** Keep this much free for the system. */
    const val RESERVE_BYTES = 200L * 1024 * 1024

    /** Tight is the band of less than this left over the budget. */
    const val TIGHT_BAND_BYTES = 1024L * 1024 * 1024

    enum class Result { Fits, Tight, DoesntFit }

    data class Outcome(val result: Result, val need: Long, val budget: Long, val leftAfter: Long)

    /**
     * Fits: need <= budget - 1 GB. Tight: need <= budget. Else DoesntFit.
     * [freeBytes] is the smaller of the folder and the SAF target when staged, [pendingNeed] is what unfinished
     * torrents and link downloads still have to write ([pendingNeedFromList]), [stagingFactor] is 2 when staged else 1.
     */
    fun admit(freeBytes: Long, pendingNeed: Long, stagingFactor: Int, selectionBytes: Long): Outcome {
        val need = selectionBytes * stagingFactor
        val budget = freeBytes - pendingNeed - RESERVE_BYTES
        val result = when {
            need <= budget - TIGHT_BAND_BYTES -> Result.Fits
            need <= budget -> Result.Tight
            else -> Result.DoesntFit
        }
        return Outcome(result, need, budget, budget - need)
    }

    /** Same set as `AutoRetry.RETRY_STATUSES`: an HTTP error worth another try (NATIVE_CONTRACT 10.3). */
    private val RETRYABLE_STATUSES = setOf(408, 429, 500, 502, 503, 504)

    /** An unfinished torrent still needs (included - downloaded), never below 0. */
    fun torrentNeed(finished: Boolean, includedBytes: Long, downloadedBytes: Long): Long =
        if (finished) 0L else (includedBytes - downloadedBytes).coerceAtLeast(0L)

    /**
     * Will a link download still write bytes? queued, resolving, downloading and paused (any `paused_by`) will.
     * `error` only when auto-retry would retry it. finished, verifying, needs_link and other errors will not.
     * Port of `downloadStillWrites` in `utils/admission.ts`.
     */
    fun downloadStillWrites(state: String?, errorCode: String?, httpStatus: Int?): Boolean = when (state) {
        "queued", "resolving", "downloading", "paused" -> true
        "error" -> errorCode == "NETWORK" || errorCode == "STALLED" ||
            (errorCode == "HTTP_STATUS" && httpStatus != null && httpStatus in RETRYABLE_STATUSES)
        else -> false
    }

    /** A link download still needs (size - downloaded) when it will write and the size is known (> 0); else 0. */
    fun downloadNeed(state: String?, size: Long?, downloaded: Long, errorCode: String?, httpStatus: Int?): Long {
        if (!downloadStillWrites(state, errorCode, httpStatus) || size == null || size <= 0L) return 0L
        return (size - downloaded).coerceAtLeast(0L)
    }

    /**
     * SM-35 pending need from a native list (`nativeListTorrents()` result): unfinished torrents plus link
     * downloads, in the raw snake_case shape. No staging factor: only the new selection is multiplied.
     */
    fun pendingNeedFromList(list: Map<String, Any?>): Long {
        var need = 0L
        for (t in maps(list["torrents"])) {
            val total = num(t["total_bytes"]) ?: 0L
            val progress = num(t["progress_bytes"]) ?: 0L
            val finished = (t["finished"] as? Boolean) ?: (total > 0 && progress >= total)
            need += torrentNeed(finished, total, progress)
        }
        for (d in maps(list["downloads"])) {
            val err = d["error"] as? Map<*, *>
            need += downloadNeed(
                d["state"] as? String, num(d["size"]), num(d["downloaded"]) ?: 0L,
                err?.get("code") as? String, (err?.get("http_status") as? Number)?.toInt(),
            )
        }
        return need
    }

    private fun num(v: Any?): Long? = (v as? Number)?.toLong()

    @Suppress("UNCHECKED_CAST")
    private fun maps(v: Any?): List<Map<String, Any?>> =
        (v as? List<*>)?.filterIsInstance<Map<*, *>>()?.map { it as Map<String, Any?> } ?: emptyList()
}
