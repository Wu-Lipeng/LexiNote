package com.lexinote.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReviewSchedulerTest {
    @Test fun `first successful review is due tomorrow`() {
        val result = ReviewScheduler.schedule(Review(), grade = 2, now = 0)
        assertEquals(1, result.repetitions); assertEquals(1, result.intervalDays); assertEquals(ReviewScheduler.DAY, result.nextReviewAt)
    }
    @Test fun `failed review resets repetitions and schedules tomorrow`() {
        val result = ReviewScheduler.schedule(Review(repetitions = 4, intervalDays = 20), grade = 0, now = 0)
        assertEquals(0, result.repetitions); assertEquals(1, result.intervalDays); assertTrue(result.ease >= 1.3)
    }
}
