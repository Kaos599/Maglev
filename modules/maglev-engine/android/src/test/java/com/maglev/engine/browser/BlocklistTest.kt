package com.maglev.engine.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream

class BlocklistTest {
    private fun line(s: String) = BlocklistParser.parseLine(s)

    @Test fun hostsLineWithZeroAddress() = assertEquals(listOf("ads.example.com"), line("0.0.0.0 ads.example.com"))
    @Test fun hostsLineWithLoopbackAddress() = assertEquals(listOf("track.example.net"), line("127.0.0.1   track.example.net"))
    @Test fun hostsLineWithTrailingComment() = assertEquals(listOf("ads.example.com"), line("0.0.0.0 ads.example.com # tracker"))
    @Test fun hostsLineWithSeveralNames() = assertEquals(listOf("a.example.com", "b.example.com"), line("0.0.0.0 a.example.com b.example.com"))
    @Test fun hostsLineWithOtherAddressIsIgnored() = assertEquals(emptyList<String>(), line("192.168.1.1 router.example.com"))
    @Test fun hostsLineIsLowercased() = assertEquals(listOf("ads.example.com"), line("0.0.0.0 ADS.Example.COM"))

    @Test fun adblockDomainRule() = assertEquals(listOf("ads.example.com"), line("||ads.example.com^"))
    @Test fun adblockRuleWithOptionsIsIgnored() = assertEquals(emptyList<String>(), line("||ads.example.com^\$third-party"))
    @Test fun adblockRuleWithPathIsIgnored() = assertEquals(emptyList<String>(), line("||example.com/ads/banner.js^"))
    @Test fun adblockRuleWithoutCaretIsIgnored() = assertEquals(emptyList<String>(), line("||example.com"))
    @Test fun adblockRuleWithWildcardIsIgnored() = assertEquals(emptyList<String>(), line("||ads*.example.com^"))
    @Test fun adblockExceptionIsIgnored() = assertEquals(emptyList<String>(), line("@@||ads.example.com^"))
    @Test fun cosmeticRuleIsIgnored() = assertEquals(emptyList<String>(), line("example.com##.ad-banner"))
    @Test fun cosmeticExceptionIsIgnored() = assertEquals(emptyList<String>(), line("example.com#@#.ad-banner"))
    @Test fun adblockCommentAndHeaderAreIgnored() {
        assertEquals(emptyList<String>(), line("! Title: some list"))
        assertEquals(emptyList<String>(), line("[Adblock Plus 2.0]"))
    }

    @Test fun plainDomainLine() = assertEquals(listOf("ads.example.com"), line("  ads.example.com  "))
    @Test fun plainLineWithTrailingDot() = assertEquals(listOf("ads.example.com"), line("ads.example.com."))
    @Test fun hashCommentsAndBlankLinesAreIgnored() {
        assertEquals(emptyList<String>(), line("# a comment"))
        assertEquals(emptyList<String>(), line("   "))
        assertEquals(emptyList<String>(), line(""))
    }

    @Test fun invalidHostsAreIgnored() {
        assertEquals(emptyList<String>(), line("0.0.0.0 -bad.example.com"))
        assertEquals(emptyList<String>(), line("0.0.0.0 bad_name.example.com"))
        assertEquals(emptyList<String>(), line("0.0.0.0 exa mple"))
        assertEquals(emptyList<String>(), line("0.0.0.0 example..com"))
        assertEquals(emptyList<String>(), line("0.0.0.0 " + "a".repeat(64) + ".com"))
        assertEquals(emptyList<String>(), line("0.0.0.0 " + "a.".repeat(130) + "com"))
        assertEquals(emptyList<String>(), line("example.com/path"))
    }

    @Test fun bareTopLevelNamesAreIgnored() {
        assertEquals(emptyList<String>(), line("com"))
        assertEquals(emptyList<String>(), line("0.0.0.0 com"))
    }

    @Test fun ipAddressesAreNotDomains() {
        assertEquals(emptyList<String>(), line("0.0.0.0 1.2.3.4"))
        assertEquals(emptyList<String>(), line("1.2.3.4"))
    }

    @Test fun localhostTypeNamesAreIgnored() {
        for (n in listOf("localhost", "localhost.localdomain", "local", "broadcasthost", "ip6-localhost", "ip6-allnodes", "my.localhost", "printer.local", "nas.lan", "x.home.arpa", "host.localdomain")) {
            assertEquals("0.0.0.0 $n", emptyList<String>(), line("0.0.0.0 $n"))
        }
        assertEquals(emptyList<String>(), line("127.0.0.1 localhost"))
        assertEquals(emptyList<String>(), line("::1 localhost"))
    }

    @Test fun punycodeLabelsAreValid() = assertEquals(listOf("xn--e1afmkfd.example"), line("0.0.0.0 xn--e1afmkfd.example"))

    @Test fun parseCollectsFromAllFormatsAndDedupes() {
        val text = """
            # hosts
            127.0.0.1 localhost
            0.0.0.0 a.example.com
            0.0.0.0 a.example.com
            ! adblock
            ||b.example.com^
            c.example.com
            example.org##.x
        """.trimIndent()
        assertEquals(setOf("a.example.com", "b.example.com", "c.example.com"), BlocklistParser.parse(text))
    }

    @Test fun parseHandlesWindowsLineEndings() =
        assertEquals(setOf("a.example.com", "b.example.com"), BlocklistParser.parse("0.0.0.0 a.example.com\r\n0.0.0.0 b.example.com\r\n"))

    @Test fun fewerThanOneThousandDomainsIsInvalid() {
        val set = (1 until BlocklistParser.MIN_DOMAINS).map { "d$it.example.com" }.toSet()
        try {
            BlocklistParser.requireEnough(set)
            fail("expected LIST_INVALID")
        } catch (e: BlocklistException) {
            assertEquals("LIST_INVALID", e.code)
            assertEquals("That list doesn't look like a block list.", e.message)
        }
    }

    @Test fun oneThousandDomainsIsEnough() {
        val set = (0 until BlocklistParser.MIN_DOMAINS).map { "d$it.example.com" }.toSet()
        BlocklistParser.requireEnough(set)
    }

    @Test fun readCappedReturnsTextUnderTheCap() =
        assertEquals("hello", BlocklistParser.readCapped(ByteArrayInputStream("hello".toByteArray()), 10))

    @Test fun readCappedAcceptsExactlyTheCap() =
        assertEquals(10, BlocklistParser.readCapped(ByteArrayInputStream(ByteArray(10) { 'a'.code.toByte() }), 10).length)

    @Test fun readCappedRejectsOneByteOver() {
        try {
            BlocklistParser.readCapped(ByteArrayInputStream(ByteArray(11) { 'a'.code.toByte() }), 10)
            fail("expected LIST_TOO_LARGE")
        } catch (e: BlocklistException) {
            assertEquals("LIST_TOO_LARGE", e.code)
        }
    }

    @Test fun onlyHttpsAddressesAreAccepted() {
        assertTrue(BlocklistParser.isHttpsUrl("https://example.com/list.txt"))
        assertTrue(BlocklistParser.isHttpsUrl("HTTPS://example.com/list.txt"))
        assertFalse(BlocklistParser.isHttpsUrl("http://example.com/list.txt"))
        assertFalse(BlocklistParser.isHttpsUrl("ftp://example.com/list.txt"))
        assertFalse(BlocklistParser.isHttpsUrl("https://"))
        assertFalse(BlocklistParser.isHttpsUrl("example.com/list.txt"))
    }

    // ---- matcher ----

    private val set = DomainSet(setOf("ads.com", "tracker.example.net"))

    @Test fun matchesTheDomainItself() = assertTrue(set.matches("ads.com"))
    @Test fun matchesASubdomain() = assertTrue(set.matches("a.b.ads.com"))
    @Test fun matchIsCaseInsensitive() = assertTrue(set.matches("CDN.Ads.COM"))
    @Test fun matchIgnoresTrailingDot() = assertTrue(set.matches("x.ads.com."))
    @Test fun doesNotMatchASiblingWithTheSameSuffixText() = assertFalse(set.matches("notads.com"))
    @Test fun doesNotMatchAParentOfAnEntry() {
        assertFalse(set.matches("example.net"))
        assertFalse(set.matches("net"))
    }
    @Test fun doesNotMatchUnrelatedHosts() = assertFalse(set.matches("example.org"))
    @Test fun nullAndEmptyHostsDoNotMatch() {
        assertFalse(set.matches(null))
        assertFalse(set.matches(""))
    }
    @Test fun emptySetMatchesNothing() = assertFalse(DomainSet.EMPTY.matches("ads.com"))
    @Test fun sizeCountsDomains() = assertEquals(2, set.size)
}
