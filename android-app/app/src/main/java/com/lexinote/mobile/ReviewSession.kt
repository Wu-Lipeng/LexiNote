package com.lexinote.mobile

enum class ReviewMode(val title: String) {
    DUE("今日复习"),
    ALL("全部复习")
}

object ReviewSession {
    fun candidates(entries: List<WordEntry>, mode: ReviewMode, now: Long = System.currentTimeMillis()): List<WordEntry> =
        when (mode) {
            ReviewMode.DUE -> entries.filter { it.review.nextReviewAt == null || it.review.nextReviewAt <= now }
            ReviewMode.ALL -> entries
        }

    fun shuffledIds(
        entries: List<WordEntry>,
        mode: ReviewMode,
        now: Long = System.currentTimeMillis(),
        shuffle: (List<WordEntry>) -> List<WordEntry> = { it.shuffled() }
    ): List<String> = shuffle(candidates(entries, mode, now)).map { it.id }
}
