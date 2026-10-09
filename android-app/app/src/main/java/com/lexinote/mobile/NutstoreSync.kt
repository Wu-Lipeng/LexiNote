package com.lexinote.mobile

import android.content.Context
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

data class NutstoreConfig(
    val serverUrl: String = DEFAULT_SERVER_URL,
    val username: String = "",
    val password: String = "",
    val filename: String = DEFAULT_FILENAME
) {
    fun isConfigured(): Boolean = runCatching { validate() }.isSuccess && username.isNotBlank() && password.isNotBlank()

    fun validate() {
        val endpoint = URL(serverUrl.trim())
        require(endpoint.protocol == "https") { "WebDAV 地址必须使用 HTTPS" }
        require(endpoint.userInfo.isNullOrBlank()) { "WebDAV 地址不能包含账号或密码" }
        require(filename.matches(Regex("^[^/\\\\\u0000-\u001F]+\\.json$", RegexOption.IGNORE_CASE)) && filename != ".json") {
            "同步文件名必须是不含路径的 .json 文件名"
        }
    }

    fun remoteUrl(): URL {
        validate()
        val base = serverUrl.trim().let { if (it.endsWith('/')) it else "$it/" }
        return URL(base + java.net.URLEncoder.encode(filename, Charsets.UTF_8).replace("+", "%20"))
    }

    companion object {
        const val DEFAULT_SERVER_URL = "https://dav.jianguoyun.com/dav/"
        const val DEFAULT_FILENAME = "lexinote-wordbook.json"
    }
}

class NutstoreSettingsRepository(context: Context) {
    private val prefs = context.getSharedPreferences("lexinote_nutstore", Context.MODE_PRIVATE)

    fun load() = NutstoreConfig(
        serverUrl = prefs.getString("serverUrl", NutstoreConfig.DEFAULT_SERVER_URL).orEmpty(),
        username = prefs.getString("username", "").orEmpty(),
        password = prefs.getString("password", "").orEmpty(),
        filename = prefs.getString("filename", NutstoreConfig.DEFAULT_FILENAME).orEmpty()
    )

    fun save(config: NutstoreConfig) {
        config.validate()
        prefs.edit()
            .putString("serverUrl", config.serverUrl.trim())
            .putString("username", config.username.trim())
            .putString("password", config.password)
            .putString("filename", config.filename.trim())
            .apply()
    }
}

object NutstoreWebDavRepository {
    suspend fun downloadWordbook(config: NutstoreConfig): String = withContext(Dispatchers.IO) {
        require(config.isConfigured()) { "请先填写完整的坚果云 WebDAV 设置" }
        val connection = (config.remoteUrl().openConnection() as HttpURLConnection)
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = 12_000
            connection.readTimeout = 20_000
            val credentials = "${config.username}:${config.password}"
            connection.setRequestProperty("Authorization", "Basic ${Base64.encodeToString(credentials.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)}")
            connection.setRequestProperty("Accept", "application/json")
            when (connection.responseCode) {
                in 200..299 -> connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                HttpURLConnection.HTTP_UNAUTHORIZED, HttpURLConnection.HTTP_FORBIDDEN -> throw IllegalStateException("坚果云拒绝访问，请检查账号与第三方应用密码")
                HttpURLConnection.HTTP_NOT_FOUND -> throw IllegalStateException("坚果云中未找到指定的词库文件")
                else -> throw IllegalStateException("坚果云返回 HTTP ${connection.responseCode}")
            }
        } finally {
            connection.disconnect()
        }
    }
}
