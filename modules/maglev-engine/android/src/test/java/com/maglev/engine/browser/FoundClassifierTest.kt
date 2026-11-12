package com.maglev.engine.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FoundClassifierTest {
    private fun net(url: String, accept: String? = null, range: Boolean = false, hls: Boolean = false) =
        FoundClassifier.classifyNetwork(url, accept, range, hls)

    private fun page(url: String, hint: String? = null) = FoundClassifier.classifyPage(url, hint)

    // ---- network: video and audio ----

    @Test fun networkVideoExtensions() {
        for (e in listOf("mp4", "m4v", "webm", "mkv", "mov", "avi", "ts")) {
            val c = net("https://cdn.example.com/v/clip.$e")
            assertNotNull(e, c)
            assertEquals(e, "video", c!!.kind)
            assertEquals(e, e, c.ext)
            assertNull(e, c.stream)
        }
    }

    @Test fun networkAudioExtensions() {
        for (e in listOf("mp3", "m4a", "aac", "flac", "ogg", "opus", "wav")) {
            val c = net("https://cdn.example.com/a/track.$e")
            assertNotNull(e, c)
            assertEquals(e, "audio", c!!.kind)
        }
    }

    @Test fun hlsPlaylistIsAVideoStream() {
        val c = net("https://cdn.example.com/live/master.m3u8")!!
        assertEquals("video", c.kind)
        assertEquals("hls", c.stream)
    }

    @Test fun dashManifestIsAVideoStream() {
        val c = net("https://cdn.example.com/live/manifest.mpd")!!
        assertEquals("video", c.kind)
        assertEquals("dash", c.stream)
    }

    @Test fun tsIsIgnoredOnceAnHlsPlaylistWasSeen() {
        assertNull(net("https://cdn.example.com/seg/0001.ts", hls = true))
        assertNotNull(net("https://cdn.example.com/seg/0001.ts", hls = false))
    }

    @Test fun networkIgnoresImagesDocumentsAndOthers() {
        for (e in listOf("jpg", "png", "gif", "webp", "svg", "pdf", "zip", "js", "css", "html", "json")) {
            assertNull(e, net("https://cdn.example.com/x/file.$e"))
        }
    }

    @Test fun networkUsesAcceptOnRangedRequestsWithoutExtension() {
        assertEquals("video", net("https://cdn.example.com/stream/12345", accept = "video/mp4", range = true)!!.kind)
        assertEquals("audio", net("https://cdn.example.com/stream/12345", accept = "audio/mpeg", range = true)!!.kind)
        assertNull(net("https://cdn.example.com/stream/12345", accept = "video/mp4", range = false))
        assertNull(net("https://cdn.example.com/stream/12345", accept = "*/*", range = true))
    }

    @Test fun networkSkipsBlobDataAndOtherSchemes() {
        assertNull(net("blob:https://example.com/3f2a"))
        assertNull(net("data:video/mp4;base64,AAAA"))
        assertNull(net("ftp://example.com/a.mp4"))
    }

    // ---- extension, query and fragment ----

    @Test fun extensionIgnoresQueryAndFragment() {
        assertEquals("mp4", FoundClassifier.extensionOf("https://e.com/a/b.mp4?token=1.2.3"))
        assertEquals("mp4", FoundClassifier.extensionOf("https://e.com/a/b.MP4#t=10"))
        assertEquals("mp4", FoundClassifier.extensionOf("https://e.com/a/b.mp4?x=y#frag"))
    }

    @Test fun extensionTakesTheLastSuffix() = assertEquals("gz", FoundClassifier.extensionOf("https://e.com/a.tar.gz"))

    @Test fun extensionIsNullWithoutADotInTheLastSegment() {
        assertNull(FoundClassifier.extensionOf("https://e.com/v1.2/stream"))
        assertNull(FoundClassifier.extensionOf("https://e.com/"))
        assertNull(FoundClassifier.extensionOf("https://e.com/file."))
    }

    @Test fun extensionDotInQueryDoesNotCount() = assertNull(FoundClassifier.extensionOf("https://e.com/watch?v=a.mp4"))

    // ---- page scan: every extension of section 24.3 ----

    @Test fun pageDocumentExtensions() {
        for (e in listOf("pdf", "epub", "mobi", "djvu", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "txt", "rtf", "csv", "md")) {
            val c = page("https://e.com/files/book.$e")
            assertNotNull(e, c)
            assertEquals(e, "document", c!!.kind)
            assertFalse(e, c.installer)
        }
    }

    @Test fun pageOtherExtensions() {
        for (e in listOf("zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "torrent", "srt", "vtt", "ass")) {
            val c = page("https://e.com/files/pack.$e")
            assertNotNull(e, c)
            assertEquals(e, "other", c!!.kind)
            assertFalse(e, c.installer)
        }
    }

    @Test fun pageImageExtensions() {
        for (e in listOf("jpg", "jpeg", "png", "gif", "webp", "avif")) {
            assertEquals(e, "image", page("https://e.com/p/pic.$e")!!.kind)
        }
    }

    @Test fun pageVideoAndAudioLinks() {
        assertEquals("video", page("https://e.com/m/movie.mkv")!!.kind)
        assertEquals("audio", page("https://e.com/m/song.flac")!!.kind)
        assertEquals("hls", page("https://e.com/m/live.m3u8")!!.stream)
        assertEquals("dash", page("https://e.com/m/live.mpd")!!.stream)
    }

    @Test fun installersAreOtherWithTheFlag() {
        for (e in listOf("apk", "exe", "msi", "dmg", "bat", "cmd", "scr")) {
            val c = page("https://e.com/get/setup.$e")
            assertNotNull(e, c)
            assertEquals(e, "other", c!!.kind)
            assertTrue(e, c.installer)
        }
    }

    @Test fun installerFlagReachesTheItem() {
        val c = page("https://e.com/get/setup.exe")!!
        val item = FoundClassifier.item("https://e.com/get/setup.exe", c, "page", "https://e.com/", "Page")!!
        assertEquals("other", item.kind)
        assertTrue(item.installer)
    }

    @Test fun pageLinkWithoutKnownExtensionIsIgnored() {
        assertNull(page("https://e.com/about"))
        assertNull(page("https://e.com/page.html"))
    }

    @Test fun pageHintGivesAKindForUnknownExtensions() {
        assertEquals("video", page("https://e.com/stream/123", "video")!!.kind)
        assertEquals("audio", page("https://e.com/stream/123", "audio")!!.kind)
        assertEquals("image", page("https://e.com/img/123", "image")!!.kind)
        assertNull(page("https://e.com/stream/123", "link"))
    }

    @Test fun pageSkipsBlobAndDataUrls() {
        assertNull(page("blob:https://e.com/3f2a", "video"))
        assertNull(page("data:image/png;base64,AAAA", "image"))
    }

    // ---- normalization and dedupe ----

    @Test fun normalizeLowercasesSchemeAndHostAndDropsFragment() =
        assertEquals("https://example.com/Path/A.mp4?x=1", FoundClassifier.normalize("HTTPS://Example.COM/Path/A.mp4?x=1#t=5"))

    @Test fun normalizeDropsRangeAndBytesParameters() {
        assertEquals("https://e.com/a.mp4?id=7", FoundClassifier.normalize("https://e.com/a.mp4?id=7&range=0-1023"))
        assertEquals("https://e.com/a.mp4?id=7", FoundClassifier.normalize("https://e.com/a.mp4?bytes=0-99&id=7"))
        assertEquals("https://e.com/a.mp4", FoundClassifier.normalize("https://e.com/a.mp4?Range=0-1&BYTES=2"))
    }

    @Test fun normalizeKeepsOtherQueryParametersInOrder() =
        assertEquals("https://e.com/a.mp4?b=2&a=1", FoundClassifier.normalize("https://e.com/a.mp4?b=2&a=1"))

    @Test fun normalizeAddsASlashForAnEmptyPath() = assertEquals("https://e.com/", FoundClassifier.normalize("https://e.com"))

    @Test fun normalizeRejectsOtherSchemes() {
        assertNull(FoundClassifier.normalize("blob:https://e.com/x"))
        assertNull(FoundClassifier.normalize("data:text/plain,hi"))
        assertNull(FoundClassifier.normalize("ftp://e.com/a"))
        assertNull(FoundClassifier.normalize("javascript:alert(1)"))
        assertNull(FoundClassifier.normalize(null))
        assertNull(FoundClassifier.normalize("https://"))
    }

    @Test fun sameFileWithDifferentRangeGetsTheSameId() {
        val a = FoundClassifier.idOf(FoundClassifier.normalize("https://E.com/a.mp4?range=0-10#x")!!)
        val b = FoundClassifier.idOf(FoundClassifier.normalize("https://e.com/a.mp4")!!)
        assertEquals(a, b)
        assertEquals(16, a.length)
    }

    @Test fun differentQueryGetsADifferentId() {
        val a = FoundClassifier.idOf(FoundClassifier.normalize("https://e.com/a.mp4?id=1")!!)
        val b = FoundClassifier.idOf(FoundClassifier.normalize("https://e.com/a.mp4?id=2")!!)
        assertNotEquals(a, b)
    }

    @Test fun nameIsTheDecodedLastSegment() {
        assertEquals("My Movie.mp4", FoundClassifier.nameOf("https://e.com/v/My%20Movie.mp4?x=1"))
        assertEquals("e.com", FoundClassifier.nameOf("https://e.com/"))
    }

    // ---- tracker ----

    private fun it(i: Int) = FoundClassifier.item("https://e.com/v$i.mp4", Classified("video", "mp4", null, false), "network", "https://e.com/", "P")!!

    @Test fun trackerDedupesById() {
        val t = FoundTracker()
        assertTrue(t.add(it(1)))
        assertFalse(t.add(it(1)))
        assertEquals(1, t.size())
    }

    @Test fun trackerDrainReturnsOnlyNewItemsOnce() {
        val t = FoundTracker()
        t.add(it(1))
        t.add(it(2))
        assertEquals(2, t.drain().size)
        assertEquals(0, t.drain().size)
        t.add(it(3))
        assertEquals(listOf("v3.mp4"), t.drain().map { x -> x.name })
    }

    @Test fun trackerKeepsTheNewestFiveHundred() {
        val t = FoundTracker()
        for (i in 1..510) t.add(it(i))
        assertEquals(FoundClassifier.MAX_ITEMS, t.size())
        val names = t.drain().map { x -> x.name }
        assertEquals(500, names.size)
        assertEquals("v11.mp4", names.first())
        assertEquals("v510.mp4", names.last())
    }

    @Test fun trackerClearForgetsEverything() {
        val t = FoundTracker()
        t.add(it(1))
        t.clear()
        assertEquals(0, t.size())
        assertTrue(t.add(it(1)))
    }
}
