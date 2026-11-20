package com.maglev.engine

import com.maglev.engine.network.DefaultNetworkTracker
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DefaultNetworkTrackerTest {
    @Test fun firstNetworkIsNotASwitch() {
        val t = DefaultNetworkTracker<String>()
        assertFalse(t.available("wifi"))
    }

    @Test fun sameNetworkAgainIsNotASwitch() {
        val t = DefaultNetworkTracker<String>()
        t.available("wifi")
        assertFalse(t.available("wifi"))
    }

    @Test fun wifiToMobileIsASwitch() {
        val t = DefaultNetworkTracker<String>()
        t.available("wifi")
        assertTrue(t.available("cell"))
    }

    @Test fun lossOfTheDefaultClearsEverything() {
        val t = DefaultNetworkTracker<String>()
        t.available("wifi")
        assertTrue(t.lost("wifi"))
        // Back after a full loss: nothing was transferring, so not a switch.
        assertFalse(t.available("wifi"))
    }

    @Test fun lateLossOfTheOldNetworkIsIgnored() {
        val t = DefaultNetworkTracker<String>()
        t.available("wifi")
        t.available("cell")
        assertFalse(t.lost("wifi"))
        assertTrue(t.lost("cell"))
    }

    @Test fun resetForgetsTheNetwork() {
        val t = DefaultNetworkTracker<String>()
        t.available("wifi")
        t.reset()
        assertFalse(t.available("cell"))
    }
}
