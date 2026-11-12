package com.maglev.engine.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The pure decisions of the muxer. The platform classes themselves need a device. */
class StreamMuxerTest {
    @Test fun earlierSampleGoesFirst() {
        assertEquals(StreamMuxer.Source.VIDEO, StreamMuxer.nextSource(100, 200))
        assertEquals(StreamMuxer.Source.AUDIO, StreamMuxer.nextSource(300, 200))
        assertEquals(StreamMuxer.Source.VIDEO, StreamMuxer.nextSource(200, 200))
    }

    @Test fun anEndedSourceLetsTheOtherFinish() {
        assertEquals(StreamMuxer.Source.AUDIO, StreamMuxer.nextSource(-1, 500))
        assertEquals(StreamMuxer.Source.VIDEO, StreamMuxer.nextSource(500, -1))
        assertEquals(StreamMuxer.Source.NONE, StreamMuxer.nextSource(-1, -1))
    }

    @Test fun theEarlierFirstSampleBecomesTimeZero() {
        assertEquals(1_400_000L, StreamMuxer.timeBase(1_500_000, 1_400_000))
        assertEquals(1_500_000L, StreamMuxer.timeBase(1_500_000, -1))
        assertEquals(0L, StreamMuxer.timeBase(-1, -1))
    }

    @Test fun onlyRealRotationsAreApplied() {
        assertEquals(90, StreamMuxer.validRotation(90))
        assertEquals(0, StreamMuxer.validRotation(0))
        assertNull(StreamMuxer.validRotation(45))
        assertNull(StreamMuxer.validRotation(null))
    }
}
