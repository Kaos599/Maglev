package com.maglev.engine

import org.junit.Assert.assertEquals
import org.junit.Test

class RestartPolicyTest {
    private fun d(shutdown: Boolean = false, pausedAll: Boolean = false, held: Boolean = false, active: Int = 1) =
        RestartPolicy.decide(RestartInput(shutdown, pausedAll, held, active))

    @Test fun resumesWithActiveTorrents() = assertEquals(RestartDecision.Resume, d())
    @Test fun resumesWhenCountUnknown() = assertEquals(RestartDecision.Resume, d(active = RestartPolicy.UNKNOWN_COUNT))
    @Test fun userShutdownStaysStopped() = assertEquals(RestartDecision.StayStopped, d(shutdown = true))
    @Test fun userPausedAllStaysStopped() = assertEquals(RestartDecision.StayStopped, d(pausedAll = true))
    @Test fun scheduleHeldStaysStopped() = assertEquals(RestartDecision.StayStopped, d(held = true))
    @Test fun nothingActiveStaysStopped() = assertEquals(RestartDecision.StayStopped, d(active = 0))
    @Test fun intentBeatsActiveCount() = assertEquals(RestartDecision.StayStopped, d(shutdown = true, pausedAll = true, held = true, active = 9))
}
