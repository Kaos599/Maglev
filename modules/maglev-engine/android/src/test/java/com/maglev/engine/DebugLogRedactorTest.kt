package com.maglev.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DebugLogRedactorTest {
    private val r = DebugLogRedactor

    @Test fun urlQueryBecomesEllipsis() =
        assertEquals("GET https://cdn.example.com/a/b.mp4?… ok", r.redact("GET https://cdn.example.com/a/b.mp4?token=abc&x=1 ok"))

    @Test fun urlWithoutQueryIsKept() = assertEquals("https://example.com/a/b.mp4", r.redact("https://example.com/a/b.mp4"))

    @Test fun everyUrlInALineIsCleaned() =
        assertEquals("a http://h/x?… b https://h2/y?…", r.redact("a http://h/x?k=1 b https://h2/y?z=2"))

    @Test fun magnetLinksAreCut() = assertEquals("add magnet:?… done", r.redact("add magnet:?xt=urn:btih:abcdef&dn=Name done"))

    @Test fun cookieAndAuthorizationValuesAreRemoved() {
        assertEquals("Cookie: [removed]", r.redact("Cookie: sid=1; other=2"))
        assertEquals("authorization: [removed]", r.redact("authorization: Basic dXNlcjpwYXNz"))
        assertEquals("Set-Cookie: [removed]", r.redact("Set-Cookie: a=b; Path=/"))
    }

    @Test fun bearerTokenIsRemoved() = assertEquals("x Bearer [removed] y", r.redact("x Bearer abc.def-123 y"))

    @Test fun apiKeysAreRemoved() {
        assertFalse(r.redact("key sk-or-v1-0123456789abcdef0123456789abcdef end").contains("0123456789abcdef"))
        assertTrue(r.redact("key sk-0123456789abcdefABCD end").contains("[removed]"))
    }

    @Test fun shortSkWordsStay() = assertEquals("task-sk-1 sk-x", r.redact("task-sk-1 sk-x"))

    @Test fun configSecretsAreRemovedAndOthersKept() {
        val cfg = mapOf(
            "proxy_password" to "hunter2",
            "proxy_host" to "10.0.0.1",
            "feeds" to listOf(mapOf("cookie" to "sid=9", "url" to "https://f.example/rss?auth=1")),
            "port" to 6881L,
        )
        @Suppress("UNCHECKED_CAST")
        val out = r.redactConfig(cfg) as Map<String, Any?>
        assertEquals("[removed]", out["proxy_password"])
        assertEquals("10.0.0.1", out["proxy_host"])
        assertEquals(6881L, out["port"])
        @Suppress("UNCHECKED_CAST")
        val feed = (out["feeds"] as List<Map<String, Any?>>)[0]
        assertEquals("[removed]", feed["cookie"])
        assertEquals("https://f.example/rss?…", feed["url"])
    }

    @Test fun proxyUrlKeepsHostAndPortButLosesCredentials() {
        @Suppress("UNCHECKED_CAST")
        val out = r.redactConfig(mapOf("proxy_url" to "socks5://bob:hunter2@10.0.0.2:1080")) as Map<String, Any?>
        val v = out["proxy_url"] as String
        assertFalse(v.contains("bob"))
        assertFalse(v.contains("hunter2"))
        assertTrue(v.contains("10.0.0.2:1080"))
        assertEquals("socks5://…@10.0.0.2:1080", v)
    }

    @Test fun proxyUrlWithoutSchemeLosesCredentials() {
        @Suppress("UNCHECKED_CAST")
        val out = r.redactConfig(mapOf("proxy_url" to "bob:hunter2@10.0.0.2:1080")) as Map<String, Any?>
        assertEquals("…@10.0.0.2:1080", out["proxy_url"])
    }

    @Test fun userInfoIsStrippedFromUrlsInText() {
        assertEquals("via https://…@host.example:8080/x ok", r.redact("via https://bob:hunter2@host.example:8080/x ok"))
    }

    @Test fun atSignInAQueryIsNotUserInfo() =
        assertEquals("https://example.com/a?…", r.redact("https://example.com/a?mail=a@b.com"))

    @Test fun fragmentsAreCut() {
        assertEquals("cb https://a.example/cb#… done", r.redact("cb https://a.example/cb#access_token=abc&x=1 done"))
        assertEquals("https://a.example/p?…", r.redact("https://a.example/p?x=1#access_token=abc"))
    }

    @Test fun passkeyPathSegmentIsCut() {
        assertEquals(
            "http://tracker.example/…/announce",
            r.redact("http://tracker.example/0123456789abcdef0123456789abcdef/announce"),
        )
    }

    @Test fun ordinaryPathsAndFileNamesStay() {
        val url = "https://releases.example/iso/ubuntu-24.04-desktop-amd64.iso"
        assertEquals(url, r.redact(url))
        assertEquals("saved ubuntu-24.04-desktop-amd64.iso", r.redact("saved ubuntu-24.04-desktop-amd64.iso"))
        val words = "https://example.com/documentation/getting-started/announce"
        assertEquals(words, r.redact(words))
    }

    @Test fun jsonQuotedHeadersAreRemoved() {
        assertEquals("""{"Cookie":[removed]}""", r.redact("""{"Cookie":"a=b"}"""))
        assertEquals("""{"Authorization": [removed]}""", r.redact("""{"Authorization": "Bearer x"}"""))
        assertFalse(r.redact("""{"Set-Cookie":"sid=9; Path=/","n":1}""").contains("sid=9"))
    }

    @Test fun capBytesKeepsTheEndAtALineStart() {
        val text = (1..1000).joinToString("\n") { "line $it" }
        val out = r.capBytes(text, 500)
        assertTrue(out.toByteArray().size <= 500)
        assertTrue(out.endsWith("line 1000"))
        assertTrue(out.startsWith("line "))
    }
}
