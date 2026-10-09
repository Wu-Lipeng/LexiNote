package com.lexinote.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class NutstoreConfigTest {
    @Test fun `builds a URL for a JSON filename`() {
        val config = NutstoreConfig(username = "user@example.com", password = "app-password", filename = "paper.json")
        assertEquals("https://dav.jianguoyun.com/dav/paper.json", config.remoteUrl().toString())
    }

    @Test fun `rejects unencrypted endpoints and path filenames`() {
        assertThrows(IllegalArgumentException::class.java) { NutstoreConfig(serverUrl = "http://dav.jianguoyun.com/dav/").validate() }
        assertThrows(IllegalArgumentException::class.java) { NutstoreConfig(filename = "folder/paper.json").validate() }
        assertFalse(NutstoreConfig().isConfigured())
    }
}
