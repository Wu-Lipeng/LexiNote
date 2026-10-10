package com.lexinote.mobile

import android.content.Context
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URLDecoder
import java.net.URL
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory

data class NutstoreConfig(
    val serverUrl: String = DEFAULT_SERVER_URL,
    val username: String = "",
    val password: String = ""
) {
    fun isConfigured(): Boolean = runCatching { validate() }.isSuccess && username.isNotBlank() && password.isNotBlank()

    fun validate() {
        val endpoint = URL(serverUrl.trim())
        require(endpoint.protocol == "https") { "WebDAV 地址必须使用 HTTPS" }
        require(endpoint.userInfo.isNullOrBlank()) { "WebDAV 地址不能包含账号或密码" }
    }

    fun remoteFolderUrl(): URL {
        validate()
        val base = serverUrl.trim().let { if (it.endsWith('/')) it else "$it/" }
        return URL(base + "LexiNote/")
    }

    companion object {
        const val DEFAULT_SERVER_URL = "https://dav.jianguoyun.com/dav/"
    }
}

class NutstoreSettingsRepository(context: Context) {
    private val prefs = context.getSharedPreferences("lexinote_nutstore", Context.MODE_PRIVATE)

    fun load() = NutstoreConfig(
        serverUrl = prefs.getString("serverUrl", NutstoreConfig.DEFAULT_SERVER_URL).orEmpty(),
        username = prefs.getString("username", "").orEmpty(),
        password = prefs.getString("password", "").orEmpty()
    )

    fun save(config: NutstoreConfig) {
        config.validate()
        prefs.edit()
            .putString("serverUrl", config.serverUrl.trim())
            .putString("username", config.username.trim())
            .putString("password", config.password)
            .apply()
    }
}

object NutstoreWebDavRepository {
    data class RemoteWordbook(val filename: String, val content: String)

    private fun authorization(config: NutstoreConfig): String {
        val credentials = "${config.username}:${config.password}"
        return "Basic ${Base64.encodeToString(credentials.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)}"
    }

    private fun open(config: NutstoreConfig, url: URL, method: String): HttpURLConnection = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = method; connectTimeout = 12_000; readTimeout = 20_000
        setRequestProperty("Authorization", authorization(config))
    }

    suspend fun downloadWordbooks(config: NutstoreConfig): List<RemoteWordbook> = withContext(Dispatchers.IO) {
        require(config.isConfigured()) { "请先填写完整的坚果云 WebDAV 设置" }
        val folder = config.remoteFolderUrl()
        val connection = open(config, folder, "PROPFIND")
        try {
            connection.setRequestProperty("Depth", "1")
            connection.setRequestProperty("Content-Type", "text/xml; charset=utf-8")
            connection.doOutput = true
            connection.outputStream.bufferedWriter(Charsets.UTF_8).use { it.write("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>") }
            when (connection.responseCode) {
                207 -> parseHrefs(connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() })
                    .mapNotNull { href -> remoteJsonUrl(folder, href) }
                    .distinctBy { it.toString() }
                    .map { url -> RemoteWordbook(filename(url), download(config, url)) }
                HttpURLConnection.HTTP_UNAUTHORIZED, HttpURLConnection.HTTP_FORBIDDEN -> throw IllegalStateException("坚果云拒绝访问，请检查账号与第三方应用密码")
                HttpURLConnection.HTTP_NOT_FOUND -> throw IllegalStateException("坚果云中尚未创建 LexiNote 文件夹，请先在插件中同步一篇文章")
                else -> throw IllegalStateException("坚果云返回 HTTP ${connection.responseCode}")
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun download(config: NutstoreConfig, url: URL): String {
        val connection = open(config, url, "GET")
        try {
            check(connection.responseCode in 200..299) { "下载 ${filename(url)} 时返回 HTTP ${connection.responseCode}" }
            return connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally { connection.disconnect() }
    }

    private fun parseHrefs(xml: String): List<String> {
        val parser = XmlPullParserFactory.newInstance().newPullParser()
        parser.setInput(xml.reader())
        val values = mutableListOf<String>()
        while (parser.eventType != XmlPullParser.END_DOCUMENT) {
            if (parser.eventType == XmlPullParser.START_TAG && parser.name.equals("href", true)) values += parser.nextText()
            parser.next()
        }
        return values
    }

    private fun remoteJsonUrl(folder: URL, href: String): URL? = runCatching {
        val url = URL(folder, href)
        if (url.toString() == folder.toString() || !url.path.endsWith(".json", true)) null else url
    }.getOrNull()

    private fun filename(url: URL): String = URLDecoder.decode(url.path.substringAfterLast('/'), Charsets.UTF_8)
}
