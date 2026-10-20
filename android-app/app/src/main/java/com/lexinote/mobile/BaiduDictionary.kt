package com.lexinote.mobile

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

data class BaiduDictionaryConfig(val apiKey: String = "", val secretKey: String = "", val historyLimit: Int = 5) {
    fun isConfigured() = apiKey.isNotBlank() && secretKey.isNotBlank()
}

data class DictionaryResult(val word: String, val phonetic: String, val meanings: List<String>, val examples: List<String>)

class BaiduDictionarySettingsRepository(context: Context) {
    private val prefs = context.getSharedPreferences("lexinote_baidu_dictionary", Context.MODE_PRIVATE)

    fun load() = BaiduDictionaryConfig(
        apiKey = prefs.getString("apiKey", "").orEmpty(),
        secretKey = prefs.getString("secretKey", "").orEmpty(),
        historyLimit = prefs.getInt("historyLimit", 5).coerceIn(1, 50)
    )

    fun save(config: BaiduDictionaryConfig) {
        prefs.edit().putString("apiKey", config.apiKey.trim()).putString("secretKey", config.secretKey).putInt("historyLimit", config.historyLimit.coerceIn(1, 50)).apply()
    }
}

class DictionarySearchHistoryRepository(context: Context) {
    private val prefs = context.getSharedPreferences("lexinote_dictionary_history", Context.MODE_PRIVATE)

    fun load(limit: Int): List<String> = prefs.getString("words", "").orEmpty().split('\u001F').filter(String::isNotBlank).take(limit.coerceIn(1, 50))

    fun record(word: String, limit: Int): List<String> {
        val words = listOf(word.trim()) + load(50).filterNot { it.equals(word.trim(), ignoreCase = true) }
        val retained = words.take(limit.coerceIn(1, 50))
        prefs.edit().putString("words", retained.joinToString("\u001F")).apply()
        return retained
    }

    fun trim(limit: Int): List<String> {
        val retained = load(50).take(limit.coerceIn(1, 50))
        prefs.edit().putString("words", retained.joinToString("\u001F")).apply()
        return retained
    }
}

object BaiduDictionaryRepository {
    private const val tokenEndpoint = "https://aip.baidubce.com/oauth/2.0/token"
    private const val lookupEndpoint = "https://aip.baidubce.com/rpc/2.0/mt/texttrans-with-dict/v1"
    private val client = OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
    private val json = Json { ignoreUnknownKeys = true }
    private var token: String? = null
    private var tokenExpiresAt = 0L
    private var tokenApiKey = ""

    suspend fun lookup(word: String, config: BaiduDictionaryConfig): DictionaryResult = withContext(Dispatchers.IO) {
        val query = word.trim()
        require(query.isNotBlank() && query.length <= 80 && !query.any(Char::isWhitespace)) { "请输入一个单词。" }
        require(config.isConfigured()) { "请先在设置中填写百度 API Key 和 Secret Key。" }
        val accessToken = accessToken(config)
        val requestBody = "{\"from\":\"en\",\"to\":\"zh\",\"q\":${json.encodeToString(kotlinx.serialization.serializer<String>(), query)}}"
            .toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder().url("$lookupEndpoint?access_token=$accessToken").post(requestBody).build()
        val root = requestJson(request, "百度词典响应不是有效 JSON。")
        val row = root["result"]?.jsonObject?.get("trans_result")?.jsonArray?.firstOrNull()?.jsonObject
            ?: throw IllegalStateException(root["error_msg"]?.jsonPrimitive?.contentOrNull ?: "百度词典没有返回结果。")
        val fallback = row["dst"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val dictionary = row["dict"]?.jsonPrimitive?.contentOrNull?.let { runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull() }
        val wordResult = dictionary?.get("word_result")?.jsonObject
        val symbols = wordResult?.get("simple_means")?.jsonObject?.get("symbols")?.jsonArray.orEmpty()
        val phonetic = symbols.firstNotNullOfOrNull { it.jsonObject["ph_en"]?.jsonPrimitive?.contentOrNull }.orEmpty()
        val meanings = linkedSetOf<String>()
        symbols.forEach { symbol -> symbol.jsonObject["parts"]?.jsonArray.orEmpty().forEach { partElement ->
            val part = partElement.jsonObject
            val pos = part["part"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            val items = part["means"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull?.trim()?.takeIf(String::isNotBlank) }
            if (pos.isNotBlank() && items.isNotEmpty()) meanings += "$pos ${items.joinToString("；")}" 
        } }
        val examples = wordResult?.get("edict")?.jsonObject?.get("item")?.jsonArray.orEmpty().flatMap { item ->
            item.jsonObject["tr_group"]?.jsonArray.orEmpty().flatMap { group ->
                group.jsonObject["example"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull?.trim()?.takeIf(String::isNotBlank) }
            }
        }.distinct().take(2)
        DictionaryResult(query, phonetic, meanings.toList().ifEmpty { listOf(fallback.ifBlank { "暂无翻译结果" }) }, examples)
    }

    private fun accessToken(config: BaiduDictionaryConfig): String {
        if (tokenApiKey == config.apiKey && token != null && System.currentTimeMillis() < tokenExpiresAt - 3_600_000) return token!!
        val body = FormBody.Builder().add("grant_type", "client_credentials").add("client_id", config.apiKey).add("client_secret", config.secretKey).build()
        val root = requestJson(Request.Builder().url(tokenEndpoint).post(body).build(), "百度 Token 响应不是有效 JSON。")
        token = root["access_token"]?.jsonPrimitive?.contentOrNull
            ?: throw IllegalStateException(root["error_description"]?.jsonPrimitive?.contentOrNull ?: "百度 access_token 获取失败。")
        tokenApiKey = config.apiKey
        tokenExpiresAt = System.currentTimeMillis() + (root["expires_in"]?.jsonPrimitive?.longOrNull ?: 2_592_000L) * 1_000
        return token!!
    }

    private fun requestJson(request: Request, invalidJsonMessage: String) = client.newCall(request).execute().use { response ->
        val text = response.body?.string().orEmpty()
        val root = runCatching { json.parseToJsonElement(text).jsonObject }.getOrElse { throw IllegalStateException(invalidJsonMessage) }
        if (!response.isSuccessful) throw IllegalStateException(root["error_msg"]?.jsonPrimitive?.contentOrNull ?: "百度服务请求失败（HTTP ${response.code}）。")
        root
    }
}
