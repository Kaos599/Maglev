package com.maglev.engine.browser

/**
 * The "registrable part" of a host, a heuristic with no public suffix list:
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
    fun same(a: String?, b: String?): Boolean {
        val x = of(a)
        return x.isNotEmpty() && x == of(b)
    }
}

/** Pop-up policy decisions, mirrored from `utils/browser/popups.ts`. Pure. */
object PopupRules {
    const val OPEN = "open"
    const val BLOCK = "block"
    const val ASK = "ask"

    /**
     * Mirrors decideNewWindow in utils/browser/popups.ts: block list > allow list > policy.
     * [policy] is "ask", "block" or "allow". [allowed] is true when the page host is in popupAllowHosts, [blocked] when
     * it is in popupBlockHosts. [kind] is "window", "redirect" or "app". An untapped app request is always blocked, and
     * so is any app request from a blocked site. OPEN means "go ahead" (a new tab for a window, the load for a redirect,
     * the app for an app). [gesture] must already be the trusted tap (see trusted()).
     */
    fun decide(policy: String, allowed: Boolean, blocked: Boolean, gesture: Boolean, kind: String): String {
        if (kind == "app" && !gesture) return BLOCK
        if (kind == "app" && blocked) return BLOCK
        // A window or redirect the user really tapped is not a pop-up: it goes ahead whatever the lists say.
        if (kind != "app" && gesture) return OPEN
        if (blocked) return BLOCK
        if (allowed || policy == "allow") return OPEN
        return if (policy == "block") BLOCK else ASK
    }

    /**
     * The form a site is kept in (mirrors normalizeSiteHost): trimmed, lower case, no dots at the ends and no single
     * leading "www." or "m.". Returns "" when nothing is left.
     */
    fun normalizeSite(input: String?): String {
        var h = input?.trim()?.lowercase()?.trim('.') ?: return ""
        h = when {
            h.startsWith("www.") -> h.substring(4)
            h.startsWith("m.") -> h.substring(2)
            else -> h
        }
        return h.trimStart('.')
    }

    /** True when [host] is one of [list] or under one, on a label boundary (mirrors hostAllowed). Both sides normalised. */
    fun hostListed(host: String?, list: List<String>): Boolean {
        val h = normalizeSite(host)
        if (h.isEmpty()) return false
        return list.any { entry ->
            val n = normalizeSite(entry)
            n.isNotEmpty() && (h == n || h.endsWith(".$n"))
        }
    }

    /** How long a tap vouches for a link, in ms. Mirrors TAP_MS in utils/browser/popups.ts. */
    const val TAP_MS = 3000L

    /** The tapped link (host, or "*" for an image link, null for no link) leads to [targetHost]'s site. Mirrors tapMatchesLink. */
    fun tapMatchesLink(tapLinkHost: String?, targetHost: String?): Boolean =
        tapLinkHost != null && (tapLinkHost == "*" || RegistrableHost.same(tapLinkHost, targetHost))

    /** A tap is the user's own only when it is the first of its kind and to this site or on a link there. Mirrors trustedTap. */
    fun trusted(gesture: Boolean, sameSite: Boolean, onMatchingLink: Boolean, nthInGesture: Int): Boolean =
        gesture && nthInGesture == 0 && (sameSite || onMatchingLink)
}
