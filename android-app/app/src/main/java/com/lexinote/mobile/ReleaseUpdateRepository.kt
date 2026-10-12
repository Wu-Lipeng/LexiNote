package com.lexinote.mobile

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.HttpURLConnection
import java.net.URL

data class UpdateInfo(val version: String, val downloadUrl: String, val fileName: String)

enum class UpdateChannel(val manifestReleaseTag: String, val manifestFileName: String) {
    STABLE("android-update", "android-update.json"),
    BETA("android-beta-update", "android-beta-update.json")
}

sealed interface UpdateState {
    data object Checking : UpdateState
    data object UpToDate : UpdateState
    data class Available(val update: UpdateInfo) : UpdateState
    data class Failed(val reason: String) : UpdateState
}

@Serializable private data class AndroidUpdateManifest(val version: String, val apkUrl: String)

object ReleaseUpdateRepository {
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun checkForUpdate(repository: String, channel: UpdateChannel = UpdateChannel.STABLE): UpdateInfo? = withContext(Dispatchers.IO) {
        val connection = URL("https://github.com/$repository/releases/download/${channel.manifestReleaseTag}/${channel.manifestFileName}").openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 12_000
            connection.readTimeout = 12_000
            connection.setRequestProperty("User-Agent", "LexiNote-Android/${BuildConfig.VERSION_NAME}")
            if (connection.responseCode == HttpURLConnection.HTTP_NOT_FOUND) return@withContext null
            check(connection.responseCode in 200..299) { "更新服务器返回 HTTP ${connection.responseCode}" }
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                val manifest = json.decodeFromString<AndroidUpdateManifest>(reader.readText())
                if (VersionOrder.compare(manifest.version, BuildConfig.VERSION_NAME) > 0) {
                    UpdateInfo(manifest.version, manifest.apkUrl, "lexinote-${manifest.version}.apk")
                } else null
            }
        } finally {
            connection.disconnect()
        }
    }
}

object VersionOrder {
    private val pattern = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)(?:-beta\\.(\\d+))?$")
    fun compare(left: String, right: String): Int {
        val leftKey = key(left)
        val rightKey = key(right)
        for (index in leftKey.indices) {
            val result = leftKey[index].compareTo(rightKey[index])
            if (result != 0) return result
        }
        return 0
    }
    fun key(value: String): List<Int> {
        val match = pattern.matchEntire(value) ?: return listOf(0, 0, 0, 0, 0)
        val (major, minor, patch, beta) = match.destructured
        return listOf(major.toInt(), minor.toInt(), patch.toInt(), if (beta.isBlank()) 1 else 0, beta.ifBlank { "0" }.toInt())
    }
}

object UpdateInstaller {
    fun canInstall(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

    fun openInstallPermission(context: Context) {
        context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
    }

    fun downloadAndInstall(context: Context, update: UpdateInfo) {
        val downloads = context.getSystemService(DownloadManager::class.java)
        val request = DownloadManager.Request(Uri.parse(update.downloadUrl))
            .setTitle("正在下载 LexiNote ${update.version}")
            .setDescription("下载完成后将打开系统安装器")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, update.fileName)
        val downloadId = downloads.enqueue(request)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(receiverContext: Context, intent: Intent) {
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L) != downloadId) return
                context.unregisterReceiver(this)
                downloads.getUriForDownloadedFile(downloadId)?.let { apkUri ->
                    context.startActivity(Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(apkUri, "application/vnd.android.package-archive")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    })
                }
            }
        }
        ContextCompat.registerReceiver(context, receiver, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_NOT_EXPORTED)
    }
}
