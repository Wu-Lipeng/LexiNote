package com.lexinote.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class NutstoreConfigTest {
    @Test fun `builds the LexiNote collection URL`() {
        val config = NutstoreConfig(username = "user@example.com", password = "app-password")
        assertEquals("https://dav.jianguoyun.com/dav/LexiNote/", config.remoteFolderUrl().toString())
    }

    @Test fun `rejects unencrypted endpoints`() {
        assertThrows(IllegalArgumentException::class.java) { NutstoreConfig(serverUrl = "http://dav.jianguoyun.com/dav/").validate() }
        assertFalse(NutstoreConfig().isConfigured())
    }
}
