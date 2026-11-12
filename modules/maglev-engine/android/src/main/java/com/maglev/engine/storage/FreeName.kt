package com.maglev.engine.storage

/** Picks a name that is not taken: `a.zip`, then `a (1).zip`, `a (2).zip`, ... Pure, so it is unit tested. */
object FreeName {
    fun pick(name: String, taken: (String) -> Boolean): String {
        if (!taken(name)) return name
        val dot = name.lastIndexOf('.')
        val hasExt = dot > 0
        val base = if (hasExt) name.substring(0, dot) else name
        val ext = if (hasExt) name.substring(dot) else ""
        var n = 1
        while (true) {
            val candidate = "$base ($n)$ext"
            if (!taken(candidate)) return candidate
            n++
        }
    }
}
