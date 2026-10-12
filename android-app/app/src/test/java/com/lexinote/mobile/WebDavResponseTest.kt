package com.lexinote.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class WebDavResponseTest {
    @Test fun `reads href elements with a WebDAV namespace prefix`() {
        val xml = """<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/LexiNote/one.json</d:href></d:response><d:response><d:href>/dav/LexiNote/two.json</d:href></d:response></d:multistatus>"""
        assertEquals(listOf("/dav/LexiNote/one.json", "/dav/LexiNote/two.json"), parseWebDavHrefs(xml))
    }
}
