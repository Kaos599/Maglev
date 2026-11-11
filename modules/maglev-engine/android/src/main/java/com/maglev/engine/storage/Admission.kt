package com.maglev.engine.storage

/**
 * Admission check for adding a torrent (SM-35, NATIVE_CONTRACT 10.3). Pure JVM, no android.* imports.
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
     * [freeBytes] is the smaller of the folder and the SAF target when staged, [pendingNeed] is the sum over
     * unfinished torrents of (included bytes - downloaded bytes), [stagingFactor] is 2 when staged else 1.
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
}
