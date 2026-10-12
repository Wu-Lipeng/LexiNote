package com.lexinote.mobile

import android.content.Context
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.URLDecoder
import java.net.URL
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

internal fun parseWebDavHrefs(xml: String): List<String> {
    val href = Regex("""<(?:[A-Za-z][\w.-]*:)?href(?:\s[^>]*)?>(.*?)</(?:[A-Za-z][\w.-]*:)?href\s*>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
    return href.findAll(xml).map { match ->
        match.groupValues[1].trim()
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
    }.toList()
}

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

    // HttpURLConnection rejects WebDAV methods such as PROPFIND on Android.
    // OkHttp accepts custom methods and keeps the request within the normal TLS stack.
    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    private fun authorization(config: NutstoreConfig): String {
        val credentials = "${config.username}:${config.password}"
        return "Basic ${Base64.encodeToString(credentials.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)}"
    }

    private fun request(config: NutstoreConfig, url: URL, method: String, body: RequestBody? = null): Request = Request.Builder()
        .url(url)
        .header("Authorization", authorization(config))
        .method(method, body)
        .build()

    private fun webDavFailure(status: Int, action: String): Nothing = when (status) {
        401 -> throw IllegalStateException("坚果云身份验证失败（HTTP 401）：请检查 App 中保存的账号邮箱和第三方应用密码是否与插件一致")
        403 -> throw IllegalStateException("坚果云拒绝$action（HTTP 403）：账号已到达服务器，但没有读取 LexiNote 文件夹的权限")
        404 -> throw IllegalStateException("坚果云中尚未创建 LexiNote 文件夹（HTTP 404）：请先在插件中同步一篇文章")
        else -> throw IllegalStateException("坚果云${action}失败（HTTP $status）")
    }

    suspend fun downloadWordbooks(config: NutstoreConfig): List<RemoteWordbook> = withContext(Dispatchers.IO) {
        require(config.isConfigured()) { "请先填写完整的坚果云 WebDAV 设置" }
        val folder = config.remoteFolderUrl()
        val xml = "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>"
        val body = xml.toRequestBody("text/xml; charset=utf-8".toMediaType())
        val request = request(config, folder, "PROPFIND", body).newBuilder().header("Depth", "1").build()
        client.newCall(request).execute().use { response ->
            when (response.code) {
                207 -> parseWebDavHrefs(response.body?.string().orEmpty())
                    .mapNotNull { href -> remoteJsonUrl(folder, href) }
                    .distinctBy { it.toString() }
                    .map { url -> RemoteWordbook(filename(url), download(config, url)) }
                else -> webDavFailure(response.code, "读取 LexiNote 文件夹")
            }
        }
    }

    private fun download(config: NutstoreConfig, url: URL): String {
        client.newCall(request(config, url, "GET")).execute().use { response ->
            if (response.code !in 200..299) webDavFailure(response.code, "下载 ${filename(url)}")
            return response.body?.string().orEmpty()
        }
    }

    private fun remoteJsonUrl(folder: URL, href: String): URL? = runCatching {
        val url = URL(folder, href)
        if (url.toString() == folder.toString() || !url.path.endsWith(".json", true)) null else url
    }.getOrNull()

    private fun filename(url: URL): String = URLDecoder.decode(url.path.substringAfterLast('/'), Charsets.UTF_8)
}
