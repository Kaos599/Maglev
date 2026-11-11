package com.maglev.engine.feeds

data class FeedSource(val id: String, val url: String, val name: String)

data class FeedConfig(
    val enabled: Boolean,
    val intervalMins: Int,
    val feeds: List<FeedSource>,
    val rules: List<FeedRule>,
) {
    companion object {
        val DISABLED = FeedConfig(false, 60, emptyList(), emptyList())

        /** Reads the JS config. Entries without an id are dropped. The interval snaps to 15, 30 or 60. */
        fun fromMap(m: Map<String, Any?>?): FeedConfig {
            if (m == null) return DISABLED
            val interval = when ((m["intervalMins"] as? Number)?.toInt()) {
                15 -> 15
                30 -> 30
                else -> 60
            }
            val feeds = ((m["feeds"] as? List<*>) ?: emptyList<Any?>()).mapNotNull { f ->
                val fm = f as? Map<*, *> ?: return@mapNotNull null
                val id = fm["id"]?.toString() ?: return@mapNotNull null
                val url = fm["url"]?.toString() ?: return@mapNotNull null
                FeedSource(id, url, fm["name"]?.toString() ?: url)
            }
            val rules = ((m["rules"] as? List<*>) ?: emptyList<Any?>()).mapNotNull { r ->
                val rm = r as? Map<*, *> ?: return@mapNotNull null
                val id = rm["id"]?.toString() ?: return@mapNotNull null
                FeedRule(
                    id = id,
                    name = rm["name"]?.toString() ?: id,
                    feedIds = ((rm["feedIds"] as? List<*>) ?: emptyList<Any?>()).mapNotNull { it?.toString() }.toSet(),
                    include = rm["include"]?.toString() ?: "",
                    exclude = rm["exclude"]?.toString() ?: "",
                    episodes = if (rm["episodes"] == "new_only") "new_only" else "all",
                    startPaused = rm["startPaused"] == true,
                    enabled = rm["enabled"] != false,
                )
            }
            return FeedConfig(m["enabled"] == true, interval, feeds, rules)
        }
    }
}
