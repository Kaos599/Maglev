package com.maglev.engine.browser

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalHostTest {
    private fun lan(h: String?) = LocalHost.isLanHost(h)

    @Test fun privateAndLoopbackV4() {
        for (h in listOf("127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0")) {
            assertTrue(h, lan(h))
        }
    }

    @Test fun publicV4() {
        for (h in listOf("8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "93.184.216.34")) {
            assertFalse(h, lan(h))
        }
    }

    @Test fun shortAndNumericIpForms() {
        assertTrue(lan("127.1"))
        assertTrue(lan("2130706433"))
        assertTrue(lan("0x7f.0.0.1"))
        assertTrue(lan("0177.0.0.1"))
        assertFalse(lan("134744072"))
    }

    @Test fun ipv6Forms() {
        assertTrue(lan("[::1]"))
        assertTrue(lan("::"))
        assertTrue(lan("[fe80::1]"))
        assertTrue(lan("[fd00::1234]"))
        assertTrue(lan("[::ffff:192.168.1.1]"))
        assertTrue(lan("[64:ff9b::c0a8:101]"))
        assertFalse(lan("[2606:4700:4700::1111]"))
        assertFalse(lan("[::ffff:8.8.8.8]"))
    }

    @Test fun lanNames() {
        for (h in listOf("localhost", "LOCALHOST", "a.localhost", "printer.local", "nas", "router.lan", "x.home.arpa", "box.localdomain")) {
            assertTrue(h, lan(h))
        }
    }

    @Test fun publicNames() {
        for (h in listOf("example.com", "a.b.example.org", "sub.example.co.uk")) assertFalse(h, lan(h))
    }

    @Test fun trailingDotAndEmpty() {
        assertTrue(lan("localhost."))
        assertFalse(lan(""))
        assertFalse(lan(null))
    }
}
