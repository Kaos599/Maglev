package com.maglev.engine.storage

import org.junit.Assert.assertEquals
import org.junit.Test

class FreeNameTest {
    @Test fun keepsAFreeName() = assertEquals("a.zip", FreeName.pick("a.zip") { false })

    @Test fun addsANumberBeforeTheExtension() =
        assertEquals("a (1).zip", FreeName.pick("a.zip") { it == "a.zip" })

    @Test fun skipsTakenNumbers() =
        assertEquals("a (3).zip", FreeName.pick("a.zip") { it in setOf("a.zip", "a (1).zip", "a (2).zip") })

    @Test fun worksWithoutAnExtension() =
        assertEquals("README (1)", FreeName.pick("README") { it == "README" })

    @Test fun aLeadingDotIsNotAnExtension() =
        assertEquals(".bashrc (1)", FreeName.pick(".bashrc") { it == ".bashrc" })

    @Test fun onlyTheLastDotSplits() =
        assertEquals("a.tar (1).gz", FreeName.pick("a.tar.gz") { it == "a.tar.gz" })
}
