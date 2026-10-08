package com.lexinote.mobile

import kotlinx.serialization.Serializable

@Serializable data class LexiNoteExport(
    val format: String,
    val schemaVersion: Int,
    val exportedAt: String? = null,
    val language: Language? = null,
    val entries: List<WordEntry>
)
@Serializable data class Language(val source: String = "en", val target: String = "zh-CN")
@Serializable data class WordEntry(
    val id: String,
    val word: String,
    val normalizedWord: String = "",
    val originalWord: String = "",
    val phonetic: String = "",
    val meanings: List<String> = emptyList(),
    val sourceSentence: String? = null,
    val example: String = "",
    val source: Source? = null,
    val createdAt: String? = null,
    val savedDate: String? = null,
    val review: Review = Review(),
    val tags: List<String> = emptyList()
)
@Serializable data class Source(val title: String = "", val pageLabel: String? = null, val url: String? = null)
@Serializable data class Review(val status: String = "new", val repetitions: Int = 0, val ease: Double = 2.5, val nextReviewAt: Long? = null, val intervalDays: Int = 0)
