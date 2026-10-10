package com.lexinote.mobile

import android.content.Context
import kotlinx.serialization.encodeToString
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable data class StoredWordbook(val id: String, val title: String, val entries: List<WordEntry>)

class WordbookRepository(context: Context) {
    private val prefs = context.getSharedPreferences("lexinote_wordbook", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    fun loadBooks(): List<StoredWordbook> {
        prefs.getString("wordbooks", null)?.let { return json.decodeFromString<List<StoredWordbook>>(it) }
        val legacy = prefs.getString("entries", null)?.let { json.decodeFromString<List<WordEntry>>(it) }.orEmpty()
        return if (legacy.isEmpty()) emptyList() else listOf(StoredWordbook("local-import", "本地导入", legacy))
    }
    fun load(): List<WordEntry> = loadBooks().flatMap { it.entries }
    private fun saveBooks(books: List<StoredWordbook>) { prefs.edit().putString("wordbooks", json.encodeToString(books)).remove("entries").apply() }
    fun import(content: String, bookId: String = "local-import", title: String = "本地导入"): Int {
        val file = json.decodeFromString<LexiNoteExport>(content)
        require(file.format == "lexinote-wordbook" && file.schemaVersion == 1) { "不是 LexiNote schema v1 导出文件" }
        val books = loadBooks().toMutableList()
        val index = books.indexOfFirst { it.id == bookId }
        val existing = (if (index >= 0) books[index].entries else emptyList()).associateBy { it.id }.toMutableMap()
        file.entries.forEach { incoming -> existing[incoming.id] = incoming.copy(review = existing[incoming.id]?.review ?: incoming.review) }
        val book = StoredWordbook(bookId, title, existing.values.sortedBy { it.word.lowercase() })
        if (index >= 0) books[index] = book else books.add(book)
        saveBooks(books.sortedBy { it.title.lowercase() })
        return file.entries.size
    }
    fun updateReview(entryId: String, review: Review) {
        saveBooks(loadBooks().map { book -> book.copy(entries = book.entries.map { entry -> if (entry.id == entryId) entry.copy(review = review) else entry }) })
    }
}
