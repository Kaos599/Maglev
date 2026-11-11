package com.maglev.engine.service

/** One torrent as the health logic sees it. Built from a native snapshot map. */
data class HealthTorrent(
    val id: String,
    val name: String,
    val state: String?,
    val health: String?,
    val pausedBy: String?,
    val folder: String?,
    val includedBytes: Long,
    val progressBytes: Long,
    val errorCode: String? = null,
) {
    companion object {
        /** Reads the snake_case snapshot map. Returns null when there is no id. */
        fun from(t: Map<String, Any?>): HealthTorrent? {
            val id = t["id"] as? String ?: return null
            val err = t["error"] as? Map<*, *>
            return HealthTorrent(
                id = id,
                name = (t["name"] as? String)?.takeIf { it.isNotBlank() } ?: "Torrent",
                state = t["state"] as? String,
                health = t["health"] as? String,
                pausedBy = t["paused_by"] as? String,
                folder = t["output_folder"] as? String,
                includedBytes = (t["included_bytes"] as? Number)?.toLong() ?: 0L,
                progressBytes = (t["progress_bytes"] as? Number)?.toLong() ?: 0L,
                errorCode = err?.get("code") as? String,
            )
        }
    }
}

/**
 * Pure SM-33 decisions (contract 18.5). No android.* imports.
 * A user pause wins: a torrent with pausedBy "user" is never counted as paused by this machine.
 */
object StorageHealth {
    const val FULL = "storage_full"
    const val UNAVAILABLE = "storage_unavailable"
    const val MARGIN_BYTES = 200L * 1024 * 1024
    const val POLL_MS = 60_000L

    fun remainingNeed(includedBytes: Long, progressBytes: Long): Long = maxOf(0L, includedBytes - progressBytes)

    /** Full to Recovering: free space covers what is left plus the 200 MB margin. */
    fun hasRoom(freeBytes: Long, includedBytes: Long, progressBytes: Long): Boolean =
        freeBytes >= remainingNeed(includedBytes, progressBytes) + MARGIN_BYTES

    /** True when [folder] is the volume root or lives under it. Compares whole path segments. */
    fun onVolume(folder: String?, volumeRoot: String?): Boolean {
        if (folder.isNullOrEmpty() || volumeRoot.isNullOrEmpty()) return false
        val root = volumeRoot.trimEnd('/')
        if (root.isEmpty()) return false
        return folder == root || folder.startsWith("$root/")
    }

    /** MediaUnmounted/MediaEject: torrents on that volume that carry no health tag yet. */
    fun unmountTargets(torrents: List<HealthTorrent>, volumeRoot: String?): List<String> =
        torrents.filter { it.health == null && onVolume(it.folder, volumeRoot) }.map { it.id }

    /** MediaMounted: torrents tagged unavailable on that same volume. */
    fun mountTargets(torrents: List<HealthTorrent>, volumeRoot: String?): List<String> =
        torrents.filter { it.health == UNAVAILABLE && onVolume(it.folder, volumeRoot) }.map { it.id }

    /** FreeSpacePoll: storage_full torrents whose folder now has room. [freeBytes] returns null when unknown. */
    fun recoveryTargets(torrents: List<HealthTorrent>, freeBytes: (String) -> Long?): List<String> =
        torrents.filter { it.health == FULL }.filter { t ->
            val free = t.folder?.let(freeBytes) ?: return@filter false
            hasRoom(free, t.includedBytes, t.progressBytes)
        }.map { it.id }

    fun countPaused(torrents: List<HealthTorrent>, tag: String): Int =
        torrents.count { it.health == tag && it.pausedBy != "user" }

    private fun plural(n: Int) = if (n == 1) "1 download paused" else "$n downloads paused"

    fun fullTitle(n: Int) = "Storage full · ${plural(n)}"
    fun removedTitle(n: Int) = "SD card removed · ${plural(n)}"
}

/** Pure SM-36 background error notice (contract 18.5, last bullet). */
object ErrorNotice {
    /** Fires once on the edge into ERROR, never for a torrent first seen already in ERROR, never with the app in front. */
    fun shouldNotify(prevState: String?, state: String?, seenBefore: Boolean, appInFront: Boolean): Boolean =
        !appInFront && seenBefore && state == "ERROR" && prevState != "ERROR"

    /** Plain-English message per SM-36. */
    fun message(code: String?): String = when (code) {
        "DISK_FULL" -> "Storage full."
        "PERMISSION" -> "Maglev can't write to this folder."
        "FILES_MISSING" -> "Some files are missing."
        "NETWORK" -> "Can't reach anyone right now."
        else -> "Something went wrong."
    }

    fun title(name: String, code: String?): String = "$name stopped: ${message(code)}"
}
