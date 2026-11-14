package com.maglev.engine.browser

/**
 * The "registrable part" of a host (docs/NATIVE_CONTRACT.md section 24.10), a heuristic with no public suffix list:
 * the last two labels, or the last three when the last is a 2-letter country code and the second-to-last is one of
 * [SECOND_LEVEL] (`co.uk`, `com.au`). IP addresses are returned whole. Pure, no Android types.
 */
object RegistrableHost {
    /** Mirrors SECOND_LEVEL in utils/browser/popups.ts. */
    val SECOND_LEVEL = setOf("co", "com", "net", "org", "gov", "edu", "ac", "mil", "nic", "ne", "or", "go", "gob", "gv", "ltd", "plc", "sch", "nhs", "res", "me", "info", "biz")

    fun of(host: String?): String {
        val h = host?.trim()?.lowercase()?.trimEnd('.') ?: return ""
        if (h.isEmpty()) return ""
        // IPv6 literal or IPv4 address: no registrable part to cut.
        if (h.contains(':') || h.all { it.isDigit() || it == '.' }) return h
        val labels = h.split('.').filter { it.isNotEmpty() }
        if (labels.size <= 2) return labels.joinToString(".")
        val last = labels[labels.size - 1]
        val second = labels[labels.size - 2]
        val ccTld = last.length == 2 && last.all { it in 'a'..'z' }
        // Only generic second-level labels count, so `www.ard.de` and `ard.de` stay one site.
        val take = if (ccTld && second in SECOND_LEVEL) 3 else 2
        return labels.takeLast(take).joinToString(".")
    }

    /** True when both hosts share the same registrable part. */
    fun same(a: String?, b: String?): Boolean = of(a) == of(b)
}

/** Pop-up policy decisions (24.10 state machine T4), mirrored from `utils/browser/popups.ts`. Pure. */
object PopupRules {
    const val OPEN = "open"
    const val BLOCK = "block"
    const val ASK = "ask"

    /**
     * [policy] is "ask", "block" or "allow". [allowed] is true when the page host is in popupAllowHosts.
     * [kind] is "window", "redirect" or "app". An untapped app request is always blocked.
     */
    fun decide(policy: String, allowed: Boolean, gesture: Boolean, kind: String): String {
        if (kind == "app" && !gesture) return BLOCK
        if (kind == "window" && gesture) return OPEN
        if (allowed || policy == "allow") return OPEN
        return if (policy == "block") BLOCK else ASK
    }
}
