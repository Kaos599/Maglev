package com.maglev.engine.update

import org.json.JSONArray
import org.json.JSONObject

/**
 * Which GitHub release to offer, for the background check. A line-by-line copy of `parseTag`, `parseVersion`,
 * `isNewer`, `abiForVersionCode`, `chooseAsset`, `parseRelease` and `pickRelease` in utils/update/check.ts, which stays
 * the one the tests run. Change both together: when the two disagree, the app's own check (the TypeScript one) wins
 * the next time Maglev opens, and the background job has at worst posted a notice or fetched a file early.
 */
object ReleasePicker {
    const val RELEASES_URL = "https://api.github.com/repos/Kaos599/Maglev/releases?per_page=20"
    private const val NOTES_MAX_CHARS = 4000
    /** versionCode % 10, as plugins/withAbiSplits.js assigns it. */
    private val ABI_BY_DIGIT = mapOf(4 to "arm64-v8a", 1 to "armeabi-v7a", 3 to "x86_64", 0 to "universal")
    private val TAG_RE = Regex("^v(\\d+)\\.(\\d+)(?:\\.(\\d+))?$")
    private val VERSION_RE = Regex("^(\\d+)\\.(\\d+)(?:\\.(\\d+))?$")
    private val DIGEST_RE = Regex("^sha256:([0-9a-fA-F]{64})$")

    /** The same fields as `UpdateInfo` in check.ts. */
    data class Release(
        val version: String,
        val tag: String,
        val notes: String,
        val pageUrl: String,
        val apkUrl: String,
        val sha256: String,
        val size: Long,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("version", version).put("tag", tag).put("notes", notes).put("pageUrl", pageUrl)
            .put("apkUrl", apkUrl).put("sha256", sha256).put("size", size)

        fun toMap(): Map<String, Any?> = linkedMapOf(
            "version" to version, "tag" to tag, "notes" to notes, "pageUrl" to pageUrl,
            "apkUrl" to apkUrl, "sha256" to sha256, "size" to size.toDouble(),
        )

        companion object {
            fun fromJson(o: JSONObject?): Release? {
                if (o == null) return null
                val sha = o.optString("sha256")
                if (!Regex("^[0-9a-f]{64}$").matches(sha)) return null
                val version = o.optString("version").ifEmpty { return null }
                val tag = o.optString("tag").ifEmpty { return null }
                val apkUrl = o.optString("apkUrl").ifEmpty { return null }
                val pageUrl = o.optString("pageUrl").ifEmpty { return null }
                return Release(version, tag, o.optString("notes"), pageUrl, apkUrl, sha, o.optLong("size", 0L).coerceAtLeast(0L))
            }
        }
    }

    private class Parsed(val major: Long, val minor: Long, val patch: Long)

    private fun parsed(m: MatchResult?): Parsed? {
        if (m == null) return null
        val major = m.groupValues[1].toLongOrNull() ?: return null
        val minor = m.groupValues[2].toLongOrNull() ?: return null
        // A missing third part is 0: 1.1 and 1.1.0 are the same version.
        val patch = if (m.groupValues[3].isEmpty()) 0L else m.groupValues[3].toLongOrNull() ?: return null
        return Parsed(major, minor, patch)
    }

    /** `^v(\d+)\.(\d+)(\.\d+)?$`. Anything else, such as `v0.21-beta`, is ignored. */
    fun parseTag(tag: Any?): Boolean = tag is String && parsed(TAG_RE.matchEntire(tag)) != null

    /** True when the tag is greater than the installed version, comparing each part as a number. */
    fun isNewer(tag: Any?, installedVersion: Any?): Boolean {
        val t = (tag as? String)?.let { parsed(TAG_RE.matchEntire(it)) } ?: return false
        val i = (installedVersion as? String)?.let { parsed(VERSION_RE.matchEntire(it)) } ?: return false
        if (t.major != i.major) return t.major > i.major
        if (t.minor != i.minor) return t.minor > i.minor
        return t.patch > i.patch
    }

    fun abiForVersionCode(versionCode: Long?): String? {
        if (versionCode == null || versionCode < 0) return null
        return ABI_BY_DIGIT[(versionCode % 10).toInt()]
    }

    /** The asset `Maglev-<tag>-<abi>.apk` with a `sha256:<64 hex>` digest. The first one with that name decides. */
    private fun chooseAsset(assets: Any?, tag: String, abi: String?): Triple<String, String, Long>? {
        if (abi == null || assets !is JSONArray) return null
        val wanted = "Maglev-$tag-$abi.apk"
        var a: JSONObject? = null
        for (k in 0 until assets.length()) {
            val x = assets.opt(k) as? JSONObject ?: continue
            if (x.opt("name") == wanted) { a = x; break }
        }
        if (a == null) return null
        val url = a.opt("browser_download_url") as? String ?: return null
        val digest = (a.opt("digest") as? String)?.let { DIGEST_RE.matchEntire(it) } ?: return null
        val rawSize = a.opt("size") as? Number
        val size = if (rawSize != null && rawSize.toDouble() > 0) rawSize.toLong() else 0L
        return Triple(url, digest.groupValues[1].lowercase(), size)
    }

    /** One release object to a [Release], or null when it is not newer, not a plain tag, or has no APK for this phone. */
    fun parseRelease(json: Any?, installedVersion: String, installedVersionCode: Long?): Release? {
        val r = json as? JSONObject ?: return null
        if (r.opt("draft") == true || r.opt("prerelease") == true) return null
        val tag = r.opt("tag_name") as? String ?: return null
        if (!parseTag(tag) || !isNewer(tag, installedVersion)) return null
        val asset = chooseAsset(r.opt("assets"), tag, abiForVersionCode(installedVersionCode)) ?: return null
        val body = r.opt("body") as? String
        val notes = body?.take(NOTES_MAX_CHARS) ?: ""
        val page = r.opt("html_url") as? String ?: "https://github.com/Kaos599/Maglev/releases/tag/$tag"
        return Release(tag.substring(1), tag, notes, page, asset.first, asset.second, asset.third)
    }

    /** The highest release in the list that [parseRelease] would offer. On a tie the earlier one in the list stays. */
    fun pick(list: JSONArray, installedVersion: String, installedVersionCode: Long?): Release? {
        var best: Release? = null
        for (k in 0 until list.length()) {
            val info = parseRelease(list.opt(k), installedVersion, installedVersionCode) ?: continue
            if (best == null || isNewer(info.tag, best.version)) best = info
        }
        return best
    }
}
