package com.lexinote.mobile

import android.content.Context

data class StudyScope(
    val useAllBooks: Boolean = true,
    val selectedBookIds: Set<String> = emptySet()
) {
    fun entriesFrom(books: List<StoredWordbook>): List<WordEntry> =
        (if (useAllBooks) books else books.filter { it.id in selectedBookIds })
            .flatMap { it.entries }
}

class StudyScopeRepository(context: Context) {
    private val prefs = context.getSharedPreferences("lexinote_study_scope", Context.MODE_PRIVATE)

    fun load(): StudyScope = StudyScope(
        useAllBooks = prefs.getBoolean("use_all_books", true),
        selectedBookIds = prefs.getStringSet("selected_book_ids", emptySet())?.toSet().orEmpty()
    )

    fun save(scope: StudyScope) {
        prefs.edit()
            .putBoolean("use_all_books", scope.useAllBooks)
            .putStringSet("selected_book_ids", scope.selectedBookIds)
            .apply()
    }
}
