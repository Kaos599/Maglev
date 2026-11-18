package com.maglev.engine.subtitles

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.zip.ZipException
import java.util.zip.ZipInputStream

/** In-memory unzip for subtitle archives (NATIVE_CONTRACT 36.6). Never touches the disk. */
object SubtitleZip {
    const val MAX_ENTRIES = 200
    const val MAX_ENTRY_BYTES = 5 * 1024 * 1024
    const val MAX_RATIO = 100L
    private val KEEP = listOf(".srt", ".ass", ".ssa", ".vtt")

    class Entry(val name: String, val bytes: ByteArray)

    fun isSubtitleName(name: String): Boolean {
        val lower = name.lowercase()
        return KEEP.any { lower.endsWith(it) }
    }

    private fun unsafe(why: String) = SubtitleException("ARCHIVE_UNSAFE", why)

    /**
     * Keeps `.srt/.ass/.ssa/.vtt` members by base name. At most [MAX_ENTRIES] entries are read and a kept entry may not
     * pass [MAX_ENTRY_BYTES]. Uncompressed bytes read may not pass [MAX_RATIO] times the archive size.
     * Anything over a limit, or not a zip, throws ARCHIVE_UNSAFE.
     */
    fun unzip(zip: ByteArray): List<Entry> {
        if (zip.isEmpty()) throw unsafe("The archive is empty")
        val allowedTotal = MAX_RATIO * zip.size.toLong()
        var total = 0L
        var count = 0
        val out = ArrayList<Entry>()
        val buf = ByteArray(16 * 1024)
        try {
            ZipInputStream(ByteArrayInputStream(zip)).use { zin ->
                while (true) {
                    val entry = zin.nextEntry ?: break
                    count++
                    if (count > MAX_ENTRIES) throw unsafe("The archive has too many files")
                    val base = entry.name.substringAfterLast('/').substringAfterLast('\\')
                    val keep = !entry.isDirectory && base.isNotEmpty() && isSubtitleName(base)
                    val sink = if (keep) ByteArrayOutputStream() else null
                    var size = 0L
                    while (true) {
                        val n = zin.read(buf)
                        if (n < 0) break
                        size += n
                        total += n
                        if (total > allowedTotal) throw unsafe("The archive expands too much")
                        if (keep && size > MAX_ENTRY_BYTES) throw unsafe("A file in the archive is too big")
                        sink?.write(buf, 0, n)
                    }
                    if (sink != null) out.add(Entry(base, sink.toByteArray()))
                }
            }
        } catch (e: SubtitleException) {
            throw e
        } catch (e: ZipException) {
            throw unsafe("This is not a readable zip")
        } catch (e: IOException) {
            throw unsafe("This is not a readable zip")
        }
        return out
    }
}
