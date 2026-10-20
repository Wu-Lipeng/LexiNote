package com.lexinote.mobile

import android.content.Context
import kotlinx.serialization.encodeToString
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Instant
import java.util.UUID

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
    fun createBook(title: String): StoredWordbook {
        val name = title.trim()
        require(name.isNotBlank()) { "请输入词库名称" }
        require(loadBooks().none { it.title.equals(name, ignoreCase = true) }) { "已存在同名词库" }
        val book = StoredWordbook("manual-${UUID.randomUUID()}", name, emptyList())
        saveBooks((loadBooks() + book).sortedBy { it.title.lowercase() })
        return book
    }
    fun saveDictionaryEntry(bookId: String, result: DictionaryResult) {
        val books = loadBooks().toMutableList()
        val index = books.indexOfFirst { it.id == bookId }
        require(index >= 0) { "词库不存在" }
        val existing = books[index].entries.firstOrNull { it.normalizedWord.equals(result.word, ignoreCase = true) }
        val entry = WordEntry(
            id = existing?.id ?: "manual-${UUID.randomUUID()}",
            word = result.word,
            normalizedWord = result.word.lowercase(),
            originalWord = result.word,
            phonetic = result.phonetic,
            meanings = result.meanings,
            example = result.examples.firstOrNull().orEmpty(),
            createdAt = existing?.createdAt ?: Instant.now().toString(),
            savedDate = existing?.savedDate ?: Instant.now().toString(),
            review = existing?.review ?: Review(),
            marked = existing?.marked ?: false,
            tags = existing?.tags ?: emptyList()
        )
        books[index] = books[index].copy(entries = (books[index].entries.filterNot { it.id == entry.id } + entry).sortedBy { it.word.lowercase() })
        saveBooks(books)
    }
    fun import(content: String, bookId: String = "local-import", title: String = "本地导入"): Int {
        val file = json.decodeFromString<LexiNoteExport>(content)
        require(file.format == "lexinote-wordbook" && file.schemaVersion == 1) { "不是 LexiNote schema v1 导出文件" }
        val books = loadBooks().toMutableList()
        val index = books.indexOfFirst { it.id == bookId }
        val existing = (if (index >= 0) books[index].entries else emptyList()).associateBy { it.id }.toMutableMap()
        file.entries.forEach { incoming ->
            val local = existing[incoming.id]
            existing[incoming.id] = incoming.copy(
                review = local?.review ?: incoming.review,
                marked = local?.marked ?: incoming.marked
            )
        }
        val book = StoredWordbook(bookId, title, existing.values.sortedBy { it.word.lowercase() })
        if (index >= 0) books[index] = book else books.add(book)
        saveBooks(books.sortedBy { it.title.lowercase() })
        return file.entries.size
    }
    fun updateReview(entryId: String, review: Review) {
        saveBooks(loadBooks().map { book -> book.copy(entries = book.entries.map { entry -> if (entry.id == entryId) entry.copy(review = review) else entry }) })
    }

    fun updateStudyState(entryId: String, review: Review, marked: Boolean? = null) {
        saveBooks(loadBooks().map { book ->
            book.copy(entries = book.entries.map { entry ->
                if (entry.id == entryId) entry.copy(review = review, marked = marked ?: entry.marked) else entry
            })
        })
    }

    fun updateMarked(entryId: String, marked: Boolean) {
        saveBooks(loadBooks().map { book ->
            book.copy(entries = book.entries.map { entry -> if (entry.id == entryId) entry.copy(marked = marked) else entry })
        })
    }
}
