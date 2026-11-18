package com.maglev.engine.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PopupRulesTest {
    @Test fun noGestureIsNeverTrusted() {
        assertFalse(PopupRules.trusted(false, true, true, 0))
    }

    @Test fun linkTapOrOwnSiteIsTrusted() {
        assertTrue(PopupRules.trusted(true, false, true, 0))
        assertTrue(PopupRules.trusted(true, true, false, 0))
    }

    @Test fun overlayTapToAnotherSiteIsNotTrusted() {
        assertFalse(PopupRules.trusted(true, false, false, 0))
    }

    @Test fun secondWindowFromOneTapIsNotTrusted() {
        assertFalse(PopupRules.trusted(true, true, true, 1))
    }

    @Test fun tapMatchesLink() {
        assertTrue(PopupRules.tapMatchesLink("ads.example.com", "example.com"))
        assertTrue(PopupRules.tapMatchesLink("*", "anything.test"))
        assertFalse(PopupRules.tapMatchesLink("good.com", "ad.test"))
        assertFalse(PopupRules.tapMatchesLink(null, "ad.test"))
    }

    @Test fun untrustedTapFollowsThePolicy() {
        assertEquals(PopupRules.ASK, PopupRules.decide("ask", false, false, "window"))
        assertEquals(PopupRules.BLOCK, PopupRules.decide("block", false, false, "redirect"))
    }
}
