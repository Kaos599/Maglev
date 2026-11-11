package com.maglev.engine.schedule

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScheduleEvaluatorTest {
    private val MON = 0
    private val TUE = 1
    private val SAT = 5
    private val SUN = 6

    private fun t(day: Int, hhmm: String) = WallTime(day, ScheduleConfig.parseTime(hhmm)!!)
    private fun rule(
        id: String, days: List<Int>, start: String, end: String, action: String = "pause", down: Long? = null, up: Long? = null,
    ) = ScheduleRule(id, days.toSet(), ScheduleConfig.parseTime(start)!!, ScheduleConfig.parseTime(end)!!, action, down, up)

    private fun cfg(vararg r: ScheduleRule, enabled: Boolean = true) = ScheduleConfig(enabled, r.toList())

    @Test fun disabledOrEmptyIsIdle() {
        val s = ScheduleEvaluator.evaluate(cfg(rule("a", listOf(MON), "00:00", "23:00"), enabled = false), t(MON, "10:00"))
        assertFalse(s.paused); assertNull(s.nextBoundaryMinutes)
        assertFalse(ScheduleEvaluator.evaluate(cfg(), t(MON, "10:00")).paused)
    }

    @Test fun sameDayWindowIsHalfOpen() {
        val c = cfg(rule("a", listOf(MON), "09:00", "17:00"))
        assertFalse(ScheduleEvaluator.evaluate(c, t(MON, "08:59")).paused)
        assertTrue(ScheduleEvaluator.evaluate(c, t(MON, "09:00")).paused)
        assertTrue(ScheduleEvaluator.evaluate(c, t(MON, "16:59")).paused)
        assertFalse(ScheduleEvaluator.evaluate(c, t(MON, "17:00")).paused)
        assertFalse(ScheduleEvaluator.evaluate(c, t(TUE, "10:00")).paused)
    }

    @Test fun overnightWindowBelongsToStartDay() {
        val c = cfg(rule("n", listOf(MON), "23:00", "01:00"))
        assertTrue(ScheduleEvaluator.evaluate(c, t(MON, "23:30")).paused)
        assertTrue(ScheduleEvaluator.evaluate(c, t(TUE, "00:30")).paused)
        assertFalse(ScheduleEvaluator.evaluate(c, t(TUE, "01:00")).paused)
        // Monday 00:30 is the tail of a window that started on Sunday, which is not listed.
        assertFalse(ScheduleEvaluator.evaluate(c, t(MON, "00:30")).paused)
    }

    @Test fun overnightWindowWrapsPastSunday() {
        val c = cfg(rule("n", listOf(SUN), "22:00", "06:00"))
        assertTrue(ScheduleEvaluator.evaluate(c, t(SUN, "23:00")).paused)
        assertTrue(ScheduleEvaluator.evaluate(c, t(MON, "05:59")).paused)
        assertFalse(ScheduleEvaluator.evaluate(c, t(MON, "06:00")).paused)
    }

    @Test fun startEqualsEndIsAllDay() {
        val c = cfg(rule("d", listOf(SAT), "08:00", "08:00"))
        assertTrue(ScheduleEvaluator.evaluate(c, t(SAT, "00:00")).paused)
        assertTrue(ScheduleEvaluator.evaluate(c, t(SAT, "23:59")).paused)
        assertFalse(ScheduleEvaluator.evaluate(c, t(SUN, "00:00")).paused)
        assertFalse(ScheduleEvaluator.evaluate(c, t(MON, "12:00")).paused)
    }

    @Test fun pauseBeatsLimit() {
        val c = cfg(
            rule("l", listOf(MON), "00:00", "23:00", "limit", down = 1000),
            rule("p", listOf(MON), "10:00", "11:00", "pause"),
        )
        val s = ScheduleEvaluator.evaluate(c, t(MON, "10:30"))
        assertTrue(s.paused); assertNull(s.downBps); assertEquals(listOf("l", "p"), s.activeRuleIds)
        val before = ScheduleEvaluator.evaluate(c, t(MON, "09:00"))
        assertFalse(before.paused); assertEquals(1000L, before.downBps)
    }

    @Test fun lowestNonZeroLimitWinsPerDirection() {
        val c = cfg(
            rule("a", listOf(MON), "08:00", "20:00", "limit", down = 5000, up = 900),
            rule("b", listOf(MON), "09:00", "10:00", "limit", down = 2000),
            rule("c", listOf(MON), "09:00", "10:00", "limit", down = 0, up = 0),
        )
        val s = ScheduleEvaluator.evaluate(c, t(MON, "09:30"))
        assertEquals(2000L, s.downBps); assertEquals(900L, s.upBps)
        assertEquals(5000L, ScheduleEvaluator.evaluate(c, t(MON, "12:00")).downBps)
    }

    @Test fun nextBoundaryIsStrictlyLaterAndNearest() {
        val c = cfg(rule("a", listOf(MON), "09:00", "17:00"))
        assertEquals(60, ScheduleEvaluator.evaluate(c, t(MON, "08:00")).nextBoundaryMinutes)
        assertEquals(480, ScheduleEvaluator.evaluate(c, t(MON, "09:00")).nextBoundaryMinutes)
        // After the last boundary of the week the next one is next Monday 09:00.
        val s = ScheduleEvaluator.evaluate(c, t(MON, "17:00"))
        assertEquals(7 * 1440 - 8 * 60, s.nextBoundaryMinutes)
    }

    @Test fun nextBoundaryCalendarFields() {
        val c = cfg(rule("n", listOf(SUN), "22:00", "06:00"))
        val now = t(SUN, "23:00")
        val s = ScheduleEvaluator.evaluate(c, now)
        assertEquals(7 * 60, s.nextBoundaryMinutes)
        assertEquals(1, s.boundaryDaysAhead(now))
        assertEquals(6 * 60, s.boundaryMinuteOfDay(now))
    }

    @Test fun parserDropsBadRulesKeepsGoodOnes() {
        val m = mapOf(
            "enabled" to true,
            "rules" to listOf(
                mapOf("id" to "ok", "days" to listOf(0, 9), "start" to "01:00", "end" to "02:30", "action" to "limit", "downBps" to 100.0),
                mapOf("id" to "bad-time", "days" to listOf(0), "start" to "25:00", "end" to "02:00", "action" to "pause"),
                mapOf("id" to "bad-action", "days" to listOf(0), "start" to "01:00", "end" to "02:00", "action" to "nope"),
                mapOf("id" to "no-days", "days" to emptyList<Int>(), "start" to "01:00", "end" to "02:00", "action" to "pause"),
            ),
        )
        val c = ScheduleConfig.fromMap(m)
        assertEquals(1, c.rules.size)
        assertEquals(setOf(0), c.rules[0].days)
        assertEquals(100L, c.rules[0].downBps)
    }

    @Test fun effectiveLimitIsLowerNonZero() {
        assertEquals(0L, ScheduleEvaluator.effectiveLimit(0, null))
        assertEquals(500L, ScheduleEvaluator.effectiveLimit(0, 500))
        assertEquals(800L, ScheduleEvaluator.effectiveLimit(800, null))
        assertEquals(300L, ScheduleEvaluator.effectiveLimit(800, 300))
        assertEquals(300L, ScheduleEvaluator.effectiveLimit(300, 800))
    }
}
