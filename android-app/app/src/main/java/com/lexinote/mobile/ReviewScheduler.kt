package com.lexinote.mobile

import kotlin.math.max
import kotlin.math.roundToInt

object ReviewScheduler {
    fun schedule(review: Review, grade: Int, now: Long = System.currentTimeMillis()): Review {
        require(grade in 0..3)
        val quality = grade + 2
        val ease = max(1.3, review.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)))
        val repetitions = if (grade == 0) 0 else review.repetitions + 1
        val days = when {
            grade == 0 -> 1
            repetitions == 1 -> 1
            repetitions == 2 -> 6
            else -> max(1, (review.intervalDays.coerceAtLeast(6) * ease).roundToInt())
        }
        return Review("learning", repetitions, ease, now + days * DAY, days)
    }
    const val DAY = 86_400_000L
}
