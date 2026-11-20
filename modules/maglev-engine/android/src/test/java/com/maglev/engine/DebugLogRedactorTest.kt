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

    @Test fun capBytesKeepsTheEndAtALineStart() {
        val text = (1..1000).joinToString("\n") { "line $it" }
        val out = r.capBytes(text, 500)
        assertTrue(out.toByteArray().size <= 500)
        assertTrue(out.endsWith("line 1000"))
        assertTrue(out.startsWith("line "))
    }
}
