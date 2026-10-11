package com.lexinote.mobile

enum class ReviewMode(val title: String) {
    DUE("今日复习"),
    ALL("全部复习"),
    MARKED("标记复习")
}

/** Keeps navigation within the part of a shuffled session the learner has reached. */
data class ReviewProgress(
    val currentIndex: Int = 0,
    val reviewedIndices: Set<Int> = emptySet()
) {
    fun canGoBack(): Boolean = currentIndex > 0

    fun canGoForward(queueSize: Int): Boolean = currentIndex < lastReachableIndex(queueSize)

    fun isComplete(queueSize: Int): Boolean = queueSize > 0 && reviewedIndices.size >= queueSize

    fun goBack(): ReviewProgress = if (canGoBack()) copy(currentIndex = currentIndex - 1) else this

    fun goForward(queueSize: Int): ReviewProgress =
        if (canGoForward(queueSize)) copy(currentIndex = currentIndex + 1) else this

    fun gradeCurrent(queueSize: Int): ReviewProgress {
        if (queueSize == 0) return this

        val updatedReviewed = reviewedIndices + currentIndex
        return if (currentIndex !in reviewedIndices && currentIndex < queueSize - 1) {
            copy(currentIndex = currentIndex + 1, reviewedIndices = updatedReviewed)
        } else {
            copy(reviewedIndices = updatedReviewed)
        }
    }

    private fun lastReachableIndex(queueSize: Int): Int =
        ((reviewedIndices.maxOrNull() ?: -1) + 1).coerceIn(0, (queueSize - 1).coerceAtLeast(0))
}

object ReviewSession {
    fun candidates(entries: List<WordEntry>, mode: ReviewMode, now: Long = System.currentTimeMillis()): List<WordEntry> =
        when (mode) {
            ReviewMode.DUE -> entries.filter { it.review.nextReviewAt == null || it.review.nextReviewAt <= now }
            ReviewMode.ALL -> entries
            ReviewMode.MARKED -> entries.filter { it.marked }
        }

    fun shuffledIds(
        entries: List<WordEntry>,
        mode: ReviewMode,
        now: Long = System.currentTimeMillis(),
        shuffle: (List<WordEntry>) -> List<WordEntry> = { it.shuffled() }
    ): List<String> = shuffle(candidates(entries, mode, now)).map { it.id }
}
