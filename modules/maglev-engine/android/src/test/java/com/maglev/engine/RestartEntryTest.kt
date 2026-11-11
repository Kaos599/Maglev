package com.maglev.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RestartEntryTest {
    private fun input(shutdown: Boolean = false, pausedAll: Boolean = false, held: Boolean = false, active: Int = 2) =
        RestartInput(shutdown, pausedAll, held, active)

    private fun plan(
        kind: RestartEntryKind = RestartEntryKind.BootCompleted,
        i: RestartInput = input(),
        setting: Boolean = true,
        special: Boolean = true,
        sdk: Int = 35,
    ) = RestartEntryPolicy.plan(kind, i, setting, special, sdk)

    @Test fun bootWithSpecialUseStarts() = assertEquals(RestartPlan(start = true, remind = true), plan())
    @Test fun packageReplacedWithSpecialUseStarts() =
        assertEquals(RestartPlan(true, true), plan(kind = RestartEntryKind.PackageReplaced))
    @Test fun dataSyncBuildOnAndroid15OnlyReminds() =
        assertEquals(RestartPlan(start = false, remind = true), plan(special = false, sdk = 35))
    @Test fun dataSyncBuildBelowAndroid15StillStarts() = assertTrue(plan(special = false, sdk = 34).start)
    @Test fun userShutdownDoesNothing() = assertEquals(RestartPlan(false, false), plan(i = input(shutdown = true)))
    @Test fun userPausedAllDoesNothing() = assertEquals(RestartPlan(false, false), plan(i = input(pausedAll = true)))
    @Test fun scheduleHeldDoesNothing() = assertEquals(RestartPlan(false, false), plan(i = input(held = true)))
    @Test fun nothingActiveDoesNothing() = assertEquals(RestartPlan(false, false), plan(i = input(active = 0)))
    @Test fun settingOffDoesNothing() = assertEquals(RestartPlan(false, false), plan(setting = false))
    @Test fun unknownCountStillStarts() =
        assertTrue(plan(i = input(active = RestartPolicy.UNKNOWN_COUNT)).start)
    @Test fun stickyRestartNeverStartsAgain() = assertEquals(RestartPlan(false, false), plan(kind = RestartEntryKind.StickyRestart))
    @Test fun appOpenHasItsOwnCheck() = assertEquals(RestartPlan(false, false), plan(kind = RestartEntryKind.AppOpen))

    @Test fun reminderCopy() {
        assertEquals("Tap to continue 1 download", RestartEntryPolicy.reminderTitle(1))
        assertEquals("Tap to continue 3 downloads", RestartEntryPolicy.reminderTitle(3))
        assertEquals("Tap to continue your downloads", RestartEntryPolicy.reminderTitle(RestartPolicy.UNKNOWN_COUNT))
    }

    private val now = 10_000_000L

    @Test fun noticeWhenGapRunningAndServiceDown() =
        assertTrue(RestartEntryPolicy.shouldShowStoppedNotice(now, now - 130_000, wasRunning = true, serviceRunning = false))
    @Test fun noNoticeWithinTwoMinutes() =
        assertFalse(RestartEntryPolicy.shouldShowStoppedNotice(now, now - 119_000, true, false))
    @Test fun noNoticeWhenNotRunningBefore() =
        assertFalse(RestartEntryPolicy.shouldShowStoppedNotice(now, now - 600_000, false, false))
    @Test fun noNoticeWhenServiceAlive() =
        assertFalse(RestartEntryPolicy.shouldShowStoppedNotice(now, now - 600_000, true, true))
    @Test fun noNoticeWithoutHeartbeat() =
        assertFalse(RestartEntryPolicy.shouldShowStoppedNotice(now, 0L, true, false))
}
