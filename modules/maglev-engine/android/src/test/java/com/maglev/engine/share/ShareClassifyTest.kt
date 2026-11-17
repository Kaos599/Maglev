package com.maglev.engine.share

import java.io.File
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs the vectors in `modules/maglev-engine/src/shareClassify.fixture.json`, the same file the node test reads. */
class ShareClassifyTest {
    private fun fixture(): JSONArray {
        val candidates = listOf(
            "../src/shareClassify.fixture.json", // Gradle runs unit tests from the android/ folder
            "src/shareClassify.fixture.json",
            "modules/maglev-engine/src/shareClassify.fixture.json",
        )
        val f = candidates.map { File(it) }.firstOrNull { it.exists() }
            ?: error("shareClassify.fixture.json not found from ${File(".").absolutePath}")
        return JSONArray(f.readText())
    }

    private fun str(o: org.json.JSONObject, k: String): String? = if (o.isNull(k)) null else o.getString(k)

    @Test fun everyVector() {
        val v = fixture()
        assertTrue(v.length() > 20)
        for (i in 0 until v.length()) {
            val o = v.getJSONObject(i)
            val got = ShareClassify.classify(str(o, "text"), str(o, "mime"))
            val label = o.getString("label")
            assertEquals(label, o.getString("kind").uppercase(), got.kind.name)
            assertEquals("$label source", str(o, "source"), got.source)
            assertEquals("$label name", str(o, "name"), got.name)
            assertEquals("$label infoHash", str(o, "infoHash"), got.infoHash)
        }
    }

    // Contract section 8.1 (issue #89): Kiwi sends VIEW <url> with the file name in com.android.extra.filename.
    private fun page(url: String) = ShareClassify.classify(url, null)

    @Test fun handOffNameTurnsAPageLinkIntoAFile() {
        val c = ShareClassify.withHandOffName(page("https://cdn.example.com/dl?id=5"), "Report 2026.pdf")
        assertEquals(ShareKind.FILE_LINK, c.kind)
        assertEquals("https://cdn.example.com/dl?id=5", c.source)
        assertEquals("Report 2026.pdf", c.name)
    }

    @Test fun handOffNameFillsAMissingName() {
        val typed = ShareClassify.classify("https://x.example/get", "application/octet-stream")
        assertEquals(null, typed.name)
        assertEquals("disk.iso", ShareClassify.withHandOffName(typed, "disk.iso").name)
    }

    @Test fun handOffNameKeepsTheLinkName() {
        val c = ShareClassify.withHandOffName(page("https://x.example/a/movie.mkv"), "other.mkv")
        assertEquals(ShareKind.FILE_LINK, c.kind)
        assertEquals("movie.mkv", c.name)
    }

    @Test fun handOffTorrentName() {
        val c = ShareClassify.withHandOffName(page("https://x.example/t?id=9"), "ubuntu.torrent")
        assertEquals(ShareKind.TORRENT_FILE, c.kind)
        assertEquals("ubuntu", c.name)
    }

    @Test fun handOffNameIsOnlyTheLastSegment() {
        assertEquals("evil.zip", ShareClassify.withHandOffName(page("https://x.example/d"), "../../evil.zip").name)
    }

    @Test fun noOrBlankHandOffNameChangesNothing() {
        val p = page("https://x.example/news/article")
        assertEquals(p, ShareClassify.withHandOffName(p, null))
        assertEquals(p, ShareClassify.withHandOffName(p, "  "))
        val m = ShareClassify.classify("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567", null)
        assertEquals(m, ShareClassify.withHandOffName(m, "x.zip"))
    }

    @Test fun nullTextIsNone() = assertEquals(ShareKind.NONE, ShareClassify.classify(null, null).kind)
}
