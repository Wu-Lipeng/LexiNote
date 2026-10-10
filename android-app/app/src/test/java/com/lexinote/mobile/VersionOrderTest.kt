package com.lexinote.mobile

import org.junit.Assert.assertTrue
import org.junit.Test

class VersionOrderTest {
    @Test fun `stable and beta updates use separate manifests`() {
        assertTrue(UpdateChannel.STABLE.manifestReleaseTag != UpdateChannel.BETA.manifestReleaseTag)
        assertTrue(UpdateChannel.STABLE.manifestFileName != UpdateChannel.BETA.manifestFileName)
    }

    @Test fun `higher beta version wins`() {
        assertTrue(VersionOrder.compare("0.1.0-beta.10", "0.1.0-beta.9") > 0)
    }

    @Test fun `stable release wins over its beta`() {
        assertTrue(VersionOrder.compare("0.1.0", "0.1.0-beta.99") > 0)
    }

    @Test fun `higher patch version wins`() {
        assertTrue(VersionOrder.compare("0.1.1-beta.1", "0.1.0") > 0)
    }
}
