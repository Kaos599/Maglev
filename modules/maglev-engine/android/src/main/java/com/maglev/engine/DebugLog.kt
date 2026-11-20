package com.maglev.engine

import android.content.Context
import android.os.Build
import android.os.Process
import androidx.core.content.FileProvider
import com.maglev.engine.storage.FileActions
import com.maglev.engine.util.Json
import java.io.File
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/** Text cleaning for the debug log. Pure, so it is unit tested on the JVM. */
object DebugLogRedactor {
    private val urlWithQuery = Regex("""([A-Za-z][A-Za-z0-9+.\-]*://[^\s?#"'<>]*)\?[^\s"'<>]*""")
    private val magnet = Regex("""magnet:\?[^\s"'<>]*""", RegexOption.IGNORE_CASE)
    private val headerValue =
        Regex("""\b(Proxy-Authorization|Authorization|Set-Cookie|Cookie)(\s*[:=]\s*)[^\r\n]*""", RegexOption.IGNORE_CASE)
    private val bearer = Regex("""\bBearer\s+[A-Za-z0-9._~+/=\-]+""", RegexOption.IGNORE_CASE)
    private val apiKey = Regex("""\bsk-[A-Za-z0-9_\-]{16,}""")
    private val secretKeyName = Regex("password|passwd|cookie|api_?key|token|secret|authorization", RegexOption.IGNORE_CASE)

    /** Removes URL queries, magnet links, Cookie/Authorization values and API keys from [text]. */
    fun redact(text: String): String {
        var out = urlWithQuery.replace(text) { it.groupValues[1] + "?…" }
        out = magnet.replace(out, "magnet:?…")
        out = headerValue.replace(out) { it.groupValues[1] + it.groupValues[2] + "[removed]" }
        out = bearer.replace(out, "Bearer [removed]")
        out = apiKey.replace(out, "[removed]")
        return out
    }

    /** Whether a config key holds a secret (proxy password, cookies, API keys, tokens). */
    fun isSecretKey(key: String): Boolean = secretKeyName.containsMatchIn(key)

    /** Copy of a parsed config with secret values replaced and every string run through [redact]. */
    fun redactConfig(value: Any?, key: String = ""): Any? = when (value) {
        is Map<*, *> -> value.entries.associateTo(linkedMapOf<String, Any?>()) { (k, v) ->
            k.toString() to redactConfig(v, k.toString())
        }
        is List<*> -> value.map { redactConfig(it, key) }
        is String -> if (value.isNotEmpty() && isSecretKey(key)) "[removed]" else redact(value)
        else -> value
    }

    /** Keeps the tail of [text] that fits in [maxBytes] of UTF-8, cut at a line start. */
    fun capBytes(text: String, maxBytes: Int): String {
        var s = text
        while (s.toByteArray(Charsets.UTF_8).size > maxBytes) {
            val cut = s.length / 10 + 1
            val nl = s.indexOf('\n', cut)
            s = if (nl < 0) s.substring(cut) else s.substring(nl + 1)
        }
        return s
    }
}

/** JS exportDebugLog: writes one text file to the app cache and returns a content:// uri for the share sheet. */
object DebugLog {
    private const val MAX_LOGCAT_LINES = 2000
    private const val MAX_BYTES = 2 * 1024 * 1024
    private const val DIR = "debug"

    fun export(c: Context, effectiveConfigJson: String): Map<String, Any?> {
        val dir = File(c.cacheDir, DIR)
        if (!dir.isDirectory && !dir.mkdirs()) return Json.failure("INTERNAL", "Couldn't make the debug log.")
        dir.listFiles()?.forEach { it.delete() }

        val body = StringBuilder()
        body.append(header(c)).append("\n\n== Settings (secrets removed) ==\n")
        body.append(configText(effectiveConfigJson))
        body.append("\n\n== Log (last ").append(MAX_LOGCAT_LINES).append(" lines) ==\n")
        body.append(logcat())
        val text = DebugLogRedactor.capBytes(DebugLogRedactor.redact(body.toString()), MAX_BYTES)

        val file = File(dir, "maglev-log-${System.currentTimeMillis()}.txt")
        file.writeText(text, Charsets.UTF_8)
        val uri = FileProvider.getUriForFile(c, FileActions.authority(c), file)
        return linkedMapOf("ok" to true, "uri" to uri.toString())
    }

    private fun header(c: Context): String {
        val info = c.packageManager.getPackageInfo(c.packageName, 0)
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
        return buildString {
            append("Maglev ").append(info.versionName).append(" (").append(code).append(")\n")
            append("Device: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n')
            append("Android ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append(")")
        }
    }

    private fun configText(json: String): String = try {
        val parsed = Json.parseObject(json)
        JSONObject(Json.toJson(DebugLogRedactor.redactConfig(parsed))).toString(2)
    } catch (e: Exception) {
        "(settings unavailable)"
    }

    private fun logcat(): String {
        val lines = ArrayDeque<String>()
        try {
            val p = ProcessBuilder("logcat", "-d", "-v", "threadtime", "--pid", Process.myPid().toString())
                .redirectErrorStream(true)
                .start()
            p.inputStream.bufferedReader(Charsets.UTF_8).useLines { seq ->
                for (line in seq) {
                    lines.addLast(line)
                    if (lines.size > MAX_LOGCAT_LINES) lines.removeFirst()
                }
            }
            if (!p.waitFor(5, TimeUnit.SECONDS)) p.destroy()
        } catch (e: Exception) {
            lines.addLast("(logcat unavailable: ${e.javaClass.simpleName})")
        }
        return lines.joinToString("\n")
    }
}
