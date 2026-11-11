package com.maglev.engine.service

import org.junit.Assert.assertEquals
import org.junit.Test

class TileModelTest {
    private fun m(s: TransferSummary?) = TileModel.from(s)

    @Test fun engineNotRunning() =
        assertEquals(TileModel(TileUiState.INACTIVE, "No transfers", TileTap.OPEN_APP), m(null))

    @Test fun noTorrents() =
        assertEquals(TileModel(TileUiState.INACTIVE, "No transfers", TileTap.OPEN_APP), m(TransferSummary()))

    @Test fun downloading() = assertEquals(
        TileModel(TileUiState.ACTIVE, "2 downloading · 4.1 MB/s", TileTap.PAUSE_ALL),
        m(TransferSummary(downloading = 2, downBps = (4.1 * 1024 * 1024).toLong())),
    )

    @Test fun seedingOnly() =
        assertEquals(TileModel(TileUiState.ACTIVE, "Seeding 3", TileTap.PAUSE_ALL), m(TransferSummary(seeding = 3)))

    @Test fun downloadingBeatsSeeding() = assertEquals(
        TileModel(TileUiState.ACTIVE, "1 downloading · 10 B/s", TileTap.PAUSE_ALL),
        m(TransferSummary(downloading = 1, seeding = 2, downBps = 10)),
    )

    @Test fun queuedCountsAsActive() =
        assertEquals(TileModel(TileUiState.ACTIVE, "Waiting for a free slot", TileTap.PAUSE_ALL), m(TransferSummary(queued = 1)))

    @Test fun pausedByUser() =
        assertEquals(TileModel(TileUiState.INACTIVE, "Paused", TileTap.RESUME_ALL), m(TransferSummary(pausedByUser = 2)))

    @Test fun pausedByWifiRule() = assertEquals(
        TileModel(TileUiState.INACTIVE, "Waiting for Wi-Fi", TileTap.RESUME_ALL),
        m(TransferSummary(pausedByRules = 1, ruleReason = "wifi_only")),
    )

    @Test fun pausedByBatteryRule() = assertEquals(
        TileModel(TileUiState.INACTIVE, "Battery low", TileTap.RESUME_ALL),
        m(TransferSummary(pausedByRules = 1, ruleReason = "battery")),
    )

    @Test fun userPauseBeatsRule() = assertEquals(
        TileModel(TileUiState.INACTIVE, "Paused", TileTap.RESUME_ALL),
        m(TransferSummary(pausedByUser = 1, pausedByRules = 1, ruleReason = "wifi_only")),
    )

    @Test fun scheduledPause() =
        assertEquals(TileModel(TileUiState.INACTIVE, "Scheduled pause", TileTap.RESUME_ALL), m(TransferSummary(pausedBySchedule = 1)))
}
