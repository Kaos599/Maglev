package com.maglev.engine

/**
 * Pure decision for a sticky (headless) service restart, contract section 11.7. No android.* imports.
 *
 * The persisted intent always wins: a user shutdown, a user "pause all" and a schedule pause keep the service
 * stopped. [RestartInput.activeTorrents] is the count of torrents that are busy or paused by a rule.
 * [UNKNOWN_COUNT] means the engine has not been started yet, so the count cannot veto a restart.
 */
data class RestartInput(
    val userShutdown: Boolean,
    val userPausedAll: Boolean,
    val scheduleHeld: Boolean,
    val activeTorrents: Int,
)

sealed class RestartDecision {
    object Resume : RestartDecision() {
        override fun toString() = "Resume"
    }

    object StayStopped : RestartDecision() {
        override fun toString() = "StayStopped"
    }
}

object RestartPolicy {
    const val UNKNOWN_COUNT = -1

    fun decide(input: RestartInput): RestartDecision = when {
        input.userShutdown || input.userPausedAll || input.scheduleHeld -> RestartDecision.StayStopped
        input.activeTorrents == 0 -> RestartDecision.StayStopped
        else -> RestartDecision.Resume
    }
}
