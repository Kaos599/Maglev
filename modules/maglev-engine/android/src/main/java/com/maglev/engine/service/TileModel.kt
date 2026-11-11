package com.maglev.engine.service

enum class TileUiState { ACTIVE, INACTIVE }

enum class TileTap { PAUSE_ALL, RESUME_ALL, OPEN_APP }

/** What the Quick Settings tile shows and does for a [TransferSummary] (contract 13.3). Pure, no Android types. */
data class TileModel(val state: TileUiState, val subtitle: String, val tapAction: TileTap) {
    companion object {
        /** A null summary means the engine is not running. */
        fun from(s: TransferSummary?): TileModel {
            if (s == null) return TileModel(TileUiState.INACTIVE, "No transfers", TileTap.OPEN_APP)
            if (s.busy > 0) {
                val subtitle = when {
                    s.downloading > 0 -> "${s.downloading} downloading · ${Notifications.speed(s.downBps)}"
                    s.seeding > 0 -> "Seeding ${s.seeding}"
                    s.lookingForInfo -> "Looking for info"
                    s.checking > 0 -> "Checking files"
                    else -> "Waiting for a free slot"
                }
                return TileModel(TileUiState.ACTIVE, subtitle, TileTap.PAUSE_ALL)
            }
            val paused = s.pausedByUser + s.pausedByRules + s.pausedBySchedule
            if (paused == 0) return TileModel(TileUiState.INACTIVE, "No transfers", TileTap.OPEN_APP)
            val subtitle = when {
                s.pausedByUser == 0 && s.pausedByRules > 0 -> when (s.ruleReason) {
                    "battery" -> "Battery low"
                    "charging_only" -> "Waiting for charger"
                    else -> "Waiting for Wi-Fi"
                }
                s.pausedByUser == 0 && s.pausedBySchedule > 0 -> "Scheduled pause"
                else -> "Paused"
            }
            return TileModel(TileUiState.INACTIVE, subtitle, TileTap.RESUME_ALL)
        }
    }
}
