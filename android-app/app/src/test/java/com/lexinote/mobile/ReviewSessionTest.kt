package com.lexinote.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReviewSessionTest {
    private val now = 1_000L
    private val entries = listOf(
        WordEntry("due", "due", review = Review(nextReviewAt = now)),
        WordEntry("future", "future", review = Review(nextReviewAt = now + 1)),
        WordEntry("new", "new", marked = true)
    )

    @Test fun `due review excludes future words`() {
        assertEquals(listOf("due", "new"), ReviewSession.candidates(entries, ReviewMode.DUE, now).map { it.id })
    }

    @Test fun `all review includes every scoped word once`() {
        val ids = ReviewSession.shuffledIds(entries, ReviewMode.ALL, now) { it.reversed() }
        assertEquals(listOf("new", "future", "due"), ids)
    }

    @Test fun `marked review only includes marked words`() {
        assertEquals(listOf("new"), ReviewSession.candidates(entries, ReviewMode.MARKED, now).map { it.id })
    }

    @Test fun `navigation only reaches the reviewed frontier`() {
        var progress = ReviewProgress()

        assertFalse(progress.canGoBack())
        assertFalse(progress.canGoForward(3))

        progress = progress.gradeCurrent(3)
        assertEquals(1, progress.currentIndex)
        assertTrue(progress.canGoBack())
        assertFalse(progress.canGoForward(3))

        progress = progress.goBack()
        assertEquals(0, progress.currentIndex)
        assertTrue(progress.canGoForward(3))

        progress = progress.goForward(3).gradeCurrent(3).gradeCurrent(3)
        assertEquals(2, progress.currentIndex)
        assertFalse(progress.canGoForward(3))
        assertTrue(progress.canGoBack())
    }
}
