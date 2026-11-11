package com.maglev.engine.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompletionPolicyTest {
    @Test fun notifiesOnEdgeAfterDownloading() = assertTrue(CompletionPolicy.shouldNotify(false, true, true))
    @Test fun recheckNeverNotifies() = assertFalse(CompletionPolicy.shouldNotify(false, true, false))
    @Test fun firstSightingNeverNotifies() = assertFalse(CompletionPolicy.shouldNotify(null, true, true))
    @Test fun alreadyFinishedNeverNotifies() = assertFalse(CompletionPolicy.shouldNotify(true, true, true))
    @Test fun stillUnfinishedNeverNotifies() = assertFalse(CompletionPolicy.shouldNotify(false, false, true))

    @Test fun bodyWithSize() = assertEquals("Downloaded · 1.5 GB", CompletionPolicy.body(1_610_612_736L))
    @Test fun bodyMegabytes() = assertEquals("Downloaded · 700.0 MB", CompletionPolicy.body(700L * 1024 * 1024))
    @Test fun bodyKilobytes() = assertEquals("Downloaded · 2 KB", CompletionPolicy.body(2048))
    @Test fun bodyBytes() = assertEquals("Downloaded · 12 B", CompletionPolicy.body(12))
    @Test fun bodyUnknownSize() = assertEquals("Downloaded", CompletionPolicy.body(0))
    @Test fun summaryTitle() = assertEquals("3 downloads finished", CompletionPolicy.summaryTitle(3))
    @Test fun summaryTitleOne() = assertEquals("1 download finished", CompletionPolicy.summaryTitle(1))
}
