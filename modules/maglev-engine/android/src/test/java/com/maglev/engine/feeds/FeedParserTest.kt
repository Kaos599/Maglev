package com.maglev.engine.feeds

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.kxml2.io.KXmlParser
import java.io.StringReader

class FeedParserTest {
    private fun parse(xml: String): List<FeedItem> {
        val p = KXmlParser()
        p.setInput(StringReader(xml))
        return FeedParser.parse(p)
    }

    @Test fun rssWithMagnetLink() {
        val items = parse(
            """<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><link>https://x.test/</link>
            <item><title>Show S01E02 1080p</title><guid isPermaLink="false">g-1</guid>
            <link>magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</link></item>
            <item><title><![CDATA[Other & more]]></title><link>https://x.test/page/2</link>
            <enclosure url="https://x.test/t/2.torrent" type="application/x-bittorrent" length="1"/></item>
            </channel></rss>""",
        )
        assertEquals(2, items.size)
        assertEquals("Show S01E02 1080p", items[0].title)
        assertEquals("g-1", items[0].guid)
        assertEquals("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", items[0].source)
        assertEquals("Other & more", items[1].title)
        assertEquals("https://x.test/page/2", items[1].guid) // no guid: link is the key
        assertEquals("https://x.test/t/2.torrent", items[1].source)
    }

    @Test fun rssItemWithOnlyAPageLinkHasNoSource() {
        val items = parse("<rss><channel><item><title>T</title><link>https://x.test/page</link></item></channel></rss>")
        assertEquals(1, items.size)
        assertNull(items[0].source)
    }

    @Test fun atomEntryWithEnclosureLink() {
        val items = parse(
            """<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><link href="https://x.test/feed"/>
            <entry><title>Frieren - 12 (1080p)</title><id>tag:x,1</id>
            <link rel="alternate" href="https://x.test/view/1"/>
            <link rel="enclosure" type="application/x-bittorrent" href="https://x.test/dl/1.torrent"/></entry>
            <entry><title>Magnet entry</title><id>tag:x,2</id><link href="magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"/></entry>
            </feed>""",
        )
        assertEquals(2, items.size)
        assertEquals("tag:x,1", items[0].guid)
        assertEquals("https://x.test/dl/1.torrent", items[0].source)
        assertEquals("magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", items[1].source)
    }

    @Test fun torznabMagnetAttrWinsOverEnclosure() {
        val items = parse(
            """<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>Movie 2024</title>
            <guid>https://idx.test/details/9</guid><link>https://idx.test/details/9</link>
            <enclosure url="https://idx.test/dl/9" type="application/x-bittorrent"/>
            <torznab:attr name="seeders" value="12"/>
            <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&amp;dn=Movie"/>
            </item></channel></rss>""",
        )
        assertEquals("magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=Movie", items[0].source)
    }

    @Test fun torznabInfohashBuildsMagnet() {
        val items = parse(
            """<rss xmlns:torznab="x"><channel><item><title>A B</title><guid>g</guid>
            <torznab:attr name="infohash" value="DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"/></item></channel></rss>""",
        )
        assertEquals("magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd&dn=A+B", items[0].source)
    }

    @Test fun invalidInfohashIsIgnored() {
        val items = parse("""<rss xmlns:torznab="x"><channel><item><title>A</title><guid>g</guid><torznab:attr name="infohash" value="zz"/></item></channel></rss>""")
        assertNull(items[0].source)
    }

    @Test fun nonTorrentEnclosureIsIgnored() {
        val items = parse("""<rss><channel><item><title>Podcast</title><guid>p</guid><enclosure url="https://x.test/a.mp3" type="audio/mpeg"/></item></channel></rss>""")
        assertNull(items[0].source)
    }
}
