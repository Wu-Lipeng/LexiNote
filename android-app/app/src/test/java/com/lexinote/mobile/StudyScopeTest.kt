package com.lexinote.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class StudyScopeTest {
    private val books = listOf(
        StoredWordbook("paper-a", "论文 A", listOf(WordEntry("word-a", "alpha"))),
        StoredWordbook("paper-b", "论文 B", listOf(WordEntry("word-b", "beta")))
    )

    @Test fun `all books are included by default`() {
        assertEquals(listOf("word-a", "word-b"), StudyScope().entriesFrom(books).map { it.id })
    }

    @Test fun `only selected wordbooks are used`() {
        assertEquals(listOf("word-a"), StudyScope(false, setOf("paper-a")).entriesFrom(books).map { it.id })
    }
}
