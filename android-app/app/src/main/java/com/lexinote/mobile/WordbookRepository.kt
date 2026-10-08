package com.lexinote.mobile

import android.content.Context
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class WordbookRepository(context: Context) {
    private val prefs = context.getSharedPreferences("lexinote_wordbook", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    fun load(): List<WordEntry> = prefs.getString("entries", null)?.let { json.decodeFromString<List<WordEntry>>(it) } ?: emptyList()
    fun save(entries: List<WordEntry>) { prefs.edit().putString("entries", json.encodeToString(entries)).apply() }
    fun import(content: String): Int {
        val file = json.decodeFromString<LexiNoteExport>(content)
        require(file.format == "lexinote-wordbook" && file.schemaVersion == 1) { "不是 LexiNote schema v1 导出文件" }
        val existing = load().associateBy { it.id }.toMutableMap()
        file.entries.forEach { incoming -> existing[incoming.id] = incoming.copy(review = existing[incoming.id]?.review ?: incoming.review) }
        save(existing.values.sortedBy { it.word.lowercase() })
        return file.entries.size
    }
}
