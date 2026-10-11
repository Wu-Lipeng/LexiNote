package com.lexinote.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class ReviewSessionTest {
    private val now = 1_000L
    private val entries = listOf(
        WordEntry("due", "due", review = Review(nextReviewAt = now)),
        WordEntry("future", "future", review = Review(nextReviewAt = now + 1)),
        WordEntry("new", "new")
    )

    @Test fun `due review excludes future words`() {
        assertEquals(listOf("due", "new"), ReviewSession.candidates(entries, ReviewMode.DUE, now).map { it.id })
    }

    @Test fun `all review includes every scoped word once`() {
        val ids = ReviewSession.shuffledIds(entries, ReviewMode.ALL, now) { it.reversed() }
        assertEquals(listOf("new", "future", "due"), ids)
    }
}
