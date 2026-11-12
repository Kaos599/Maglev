package com.maglev.engine.browser

/**
 * "Is this host on the local network?" for main-frame navigation (docs/NATIVE_CONTRACT.md section 24.5).
 * Mirrors `is_lan_host` / `is_local_ip` / `looks_like_lan_name` in native/maglev-core/src/http_dl/rules.rs (section 17.w).
 * Pure Kotlin. It never resolves names: a public name that points at a LAN address is not caught here.
 */
object LocalHost {
    /** True for a LAN IP literal or a LAN-looking name. [host] may be a bracketed IPv6 literal. */
    fun isLanHost(host: String?): Boolean {
        if (host.isNullOrBlank()) return false
        val h = host.trim().trimStart('[').trimEnd(']').trimEnd('.').lowercase()
        if (h.isEmpty()) return false
        val v6 = if (h.contains(':')) parseV6(h) else null
        if (v6 != null) return isLocalV6(v6)
        if (h.contains(':')) return false
        val v4 = parseV4(h)
        if (v4 != null) return isLocalV4(v4)
        return looksLikeLanName(h)
    }

    /** `localhost`, `*.local`, `*.localhost`, `*.lan`, `*.home.arpa`, `*.localdomain` or a single word. */
    fun looksLikeLanName(h: String): Boolean {
        if (h.isEmpty()) return false
        if (h == "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true
        return !h.contains('.') || h.endsWith(".lan") || h.endsWith(".home.arpa") || h.endsWith(".localdomain")
    }

    /**
     * inet_aton style: 1 to 4 parts, each decimal, octal (leading 0) or hex (0x); the last part fills the remaining
     * bytes. Browsers read `2130706433`, `0x7f.1` and `127.1` as loopback, so they must count as IP literals.
     * Returns the 32-bit address in a Long, or null when [h] is not such a literal.
     */
    fun parseV4(h: String): Long? {
        val parts = h.split('.')
        if (parts.isEmpty() || parts.size > 4) return null
        val nums = ArrayList<Long>(parts.size)
        for (p in parts) {
            nums.add(parsePart(p) ?: return null)
        }
        for (i in 0 until nums.size - 1) if (nums[i] > 255) return null
        val last = nums.last()
        val remaining = 4 - (nums.size - 1)
        val limit = 1L shl (8 * remaining)
        if (last >= limit) return null
        var addr = 0L
        for (i in 0 until nums.size - 1) addr = addr or (nums[i] shl (8 * (3 - i)))
        return addr or last
    }

    private fun parsePart(p: String): Long? {
        if (p.isEmpty()) return null
        return try {
            when {
                p.startsWith("0x") || p.startsWith("0X") -> if (p.length == 2) null else java.lang.Long.parseLong(p.substring(2), 16)
                p.length > 1 && p.startsWith("0") -> java.lang.Long.parseLong(p.substring(1), 8)
                else -> if (p.all { it in '0'..'9' }) java.lang.Long.parseLong(p, 10) else null
            }
        } catch (_: NumberFormatException) {
            null
        }
    }

    private fun isLocalV4(a: Long): Boolean {
        val o0 = ((a shr 24) and 0xff).toInt()
        val o1 = ((a shr 16) and 0xff).toInt()
        return o0 == 0 || o0 == 127 || o0 == 10 ||
            (o0 == 172 && o1 in 16..31) ||
            (o0 == 192 && o1 == 168) ||
            (o0 == 169 && o1 == 254) ||
            (o0 == 100 && (o1 and 0xc0) == 64) ||
            o0 >= 224 // multicast (224/4), reserved and broadcast
    }

    /** Eight 16-bit groups, or null when [h] is not an IPv6 literal. Accepts `::` and an embedded IPv4 tail. */
    fun parseV6(h: String): IntArray? {
        var s = h.substringBefore('%')
        if (s.isEmpty() || s.count { it == ':' } < 2) return null
        var tail: Long? = null
        if (s.contains('.')) {
            val idx = s.lastIndexOf(':')
            tail = parseV4(s.substring(idx + 1)) ?: return null
            s = s.substring(0, idx + 1) + "0:0"
        }
        val dbl = s.indexOf("::")
        if (dbl >= 0 && s.indexOf("::", dbl + 1) >= 0) return null
        val left: List<String>
        val right: List<String>
        if (dbl >= 0) {
            left = s.substring(0, dbl).split(':').filter { it.isNotEmpty() }
            right = s.substring(dbl + 2).split(':').filter { it.isNotEmpty() }
            if (left.size + right.size > 7) return null
        } else {
            left = s.split(':')
            right = emptyList()
            if (left.size != 8) return null
        }
        val groups = IntArray(8)
        fun hex(g: String): Int? = if (g.length in 1..4 && g.all { Character.digit(it, 16) >= 0 }) g.toInt(16) else null
        for ((i, g) in left.withIndex()) groups[i] = hex(g) ?: return null
        for ((i, g) in right.withIndex()) groups[8 - right.size + i] = hex(g) ?: return null
        if (tail != null) {
            groups[6] = ((tail shr 16) and 0xffff).toInt()
            groups[7] = (tail and 0xffff).toInt()
        }
        return groups
    }

    private fun isLocalV6(g: IntArray): Boolean {
        val first6Zero = g[0] == 0 && g[1] == 0 && g[2] == 0 && g[3] == 0 && g[4] == 0
        // ::1 and ::
        if (first6Zero && g[5] == 0 && g[6] == 0 && (g[7] == 0 || g[7] == 1)) return true
        // IPv4-mapped ::ffff:a.b.c.d
        if (first6Zero && g[5] == 0xffff) return isLocalV4((g[6].toLong() shl 16) or g[7].toLong())
        // NAT64 64:ff9b::/96
        if (g[0] == 0x64 && g[1] == 0xff9b && g[2] == 0 && g[3] == 0 && g[4] == 0 && g[5] == 0) {
            return isLocalV4((g[6].toLong() shl 16) or g[7].toLong())
        }
        return (g[0] and 0xffc0) == 0xfe80 || (g[0] and 0xfe00) == 0xfc00 || (g[0] and 0xff00) == 0xff00
    }
}
