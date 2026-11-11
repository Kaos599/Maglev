package com.maglev.engine.schedule

/**
 * Pure schedule logic (contract section 11.5). No android.* imports, so it runs on the plain JVM.
 *
 * The contract names java.time.LocalDateTime. minSdk is 24 and java.time needs API 26, and this build does not
 * enable core library desugaring, so time is modelled as minutes of the week instead: [WallTime].
 * Day numbers are 0 = Monday ... 6 = Sunday.
 */

/** Local wall-clock time reduced to what the schedule needs. */
data class WallTime(val dayOfWeek: Int, val minuteOfDay: Int) {
    init {
        require(dayOfWeek in 0..6) { "dayOfWeek must be 0..6" }
        require(minuteOfDay in 0..1439) { "minuteOfDay must be 0..1439" }
    }

    val minuteOfWeek: Int get() = dayOfWeek * MINUTES_PER_DAY + minuteOfDay
}

data class ScheduleRule(
    val id: String,
    val days: Set<Int>,
    /** Minute of day, 0..1439. */
    val startMin: Int,
    val endMin: Int,
    /** "pause" or "limit". */
    val action: String,
    /** Bytes per second, 0 or null = no limit in that direction. */
    val downBps: Long? = null,
    val upBps: Long? = null,
)

data class ScheduleConfig(val enabled: Boolean, val rules: List<ScheduleRule>) {
    companion object {
        val DISABLED = ScheduleConfig(false, emptyList())

        /**
         * Reads the JS config map. Invalid rules (bad time, unknown action, no valid day) are dropped,
         * so a bad rule never takes down the rest of the schedule.
         */
        fun fromMap(m: Map<String, Any?>?): ScheduleConfig {
            if (m == null) return DISABLED
            val rules = ArrayList<ScheduleRule>()
            for (r in (m["rules"] as? List<*>) ?: emptyList<Any?>()) {
                val rm = r as? Map<*, *> ?: continue
                val id = rm["id"]?.toString() ?: continue
                val action = rm["action"]?.toString()
                if (action != "pause" && action != "limit") continue
                val start = parseTime(rm["start"]?.toString()) ?: continue
                val end = parseTime(rm["end"]?.toString()) ?: continue
                val days = ((rm["days"] as? List<*>) ?: emptyList<Any?>())
                    .mapNotNull { (it as? Number)?.toInt() }.filter { it in 0..6 }.toSet()
                if (days.isEmpty()) continue
                rules.add(
                    ScheduleRule(
                        id, days, start, end, action,
                        (rm["downBps"] as? Number)?.toLong()?.takeIf { it > 0 },
                        (rm["upBps"] as? Number)?.toLong()?.takeIf { it > 0 },
                    ),
                )
            }
            return ScheduleConfig(m["enabled"] == true, rules)
        }

        /** "HH:MM" to minute of day, or null. */
        fun parseTime(s: String?): Int? {
            if (s == null) return null
            val m = Regex("^(\\d{1,2}):(\\d{2})$").matchEntire(s.trim()) ?: return null
            val h = m.groupValues[1].toInt()
            val min = m.groupValues[2].toInt()
            return if (h in 0..23 && min in 0..59) h * 60 + min else null
        }

        fun toMap(c: ScheduleConfig): Map<String, Any?> = linkedMapOf(
            "enabled" to c.enabled,
            "rules" to c.rules.map {
                linkedMapOf<String, Any?>(
                    "id" to it.id,
                    "days" to it.days.sorted(),
                    "start" to formatTime(it.startMin),
                    "end" to formatTime(it.endMin),
                    "action" to it.action,
                    "downBps" to it.downBps,
                    "upBps" to it.upBps,
                )
            },
        )

        fun formatTime(min: Int): String = "%02d:%02d".format(min / 60, min % 60)
    }
}

/**
 * Result of an evaluation. When [paused] is true the limits are null, because a pause beats any limit.
 * [nextBoundaryMinutes] is the distance in whole minutes to the soonest rule start or end, or null.
 */
data class ScheduleState(
    val paused: Boolean,
    val downBps: Long?,
    val upBps: Long?,
    val activeRuleIds: List<String>,
    val nextBoundaryMinutes: Int?,
) {
    /** Calendar days from today to the boundary, given the time it was computed for. */
    fun boundaryDaysAhead(now: WallTime): Int? =
        nextBoundaryMinutes?.let { (now.minuteOfWeek + it) / MINUTES_PER_DAY - now.dayOfWeek }

    fun boundaryMinuteOfDay(now: WallTime): Int? =
        nextBoundaryMinutes?.let { (now.minuteOfWeek + it) % MINUTES_PER_DAY }
}

const val MINUTES_PER_DAY = 1440
const val MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY

object ScheduleEvaluator {

    /**
     * - `end <= start` runs past midnight, and `days` names the day the window starts.
     * - `start == end` means the whole calendar day.
     * - Overlaps: pause wins. Among limits the lowest non-zero value wins per direction.
     * - The next boundary is strictly after [now] and looks at most one week ahead.
     */
    fun evaluate(config: ScheduleConfig, now: WallTime): ScheduleState {
        if (!config.enabled || config.rules.isEmpty()) return ScheduleState(false, null, null, emptyList(), null)
        val t = now.minuteOfWeek
        val active = ArrayList<ScheduleRule>()
        var best: Int? = null
        for (rule in config.rules) {
            for (d in rule.days) {
                val (from, to) = interval(rule, d)
                if (contains(from, to, t)) {
                    if (active.none { it.id == rule.id }) active.add(rule)
                }
                for (b in intArrayOf(from, to)) {
                    var delta = Math.floorMod(b - t, MINUTES_PER_WEEK)
                    if (delta == 0) delta = MINUTES_PER_WEEK
                    if (best == null || delta < best) best = delta
                }
            }
        }
        val paused = active.any { it.action == "pause" }
        val ids = active.map { it.id }
        if (paused) return ScheduleState(true, null, null, ids, best)
        val down = active.mapNotNull { it.downBps }.minOrNull()
        val up = active.mapNotNull { it.upBps }.minOrNull()
        return ScheduleState(false, down, up, ids, best)
    }

    /** Window as [from, to) in minutes since Monday 00:00. `to` may exceed one week. */
    private fun interval(rule: ScheduleRule, day: Int): Pair<Int, Int> {
        val base = day * MINUTES_PER_DAY
        return when {
            rule.startMin == rule.endMin -> base to base + MINUTES_PER_DAY
            rule.endMin > rule.startMin -> base + rule.startMin to base + rule.endMin
            else -> base + rule.startMin to base + MINUTES_PER_DAY + rule.endMin
        }
    }

    /** True when [t] or [t] plus one week lies in [from, to). Handles a window that wraps past Sunday. */
    private fun contains(from: Int, to: Int, t: Int): Boolean =
        (t >= from && t < to) || (t + MINUTES_PER_WEEK >= from && t + MINUTES_PER_WEEK < to)

    /** Effective limit per direction: the lower non-zero value of the global and schedule limit. 0 means none. */
    fun effectiveLimit(global: Long, schedule: Long?): Long {
        val g = if (global > 0) global else 0L
        val s = if (schedule != null && schedule > 0) schedule else 0L
        return when {
            g == 0L -> s
            s == 0L -> g
            else -> minOf(g, s)
        }
    }
}
