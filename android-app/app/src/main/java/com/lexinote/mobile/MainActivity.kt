@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.lexinote.mobile

import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.FileOpen
import androidx.compose.material.icons.filled.LibraryBooks
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape
import java.io.BufferedReader
import java.io.InputStreamReader
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { MaterialTheme(colorScheme = lightColorScheme(primary = androidx.compose.ui.graphics.Color(0xFF155E75))) { LexiNoteApp() } }
    }
}

private enum class Page { HOME, REVIEW, LIBRARY, WORDBOOK, DETAIL, SETTINGS }

@Composable private fun LexiNoteApp() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val repo = remember { WordbookRepository(context) }
    val nutstoreSettings = remember { NutstoreSettingsRepository(context) }
    var entries by remember { mutableStateOf(repo.load()) }
    var books by remember { mutableStateOf(repo.loadBooks()) }
    var page by remember { mutableStateOf(Page.HOME) }
    var selected by remember { mutableStateOf<WordEntry?>(null) }
    var selectedBook by remember { mutableStateOf<StoredWordbook?>(null) }
    var updateState by remember { mutableStateOf<UpdateState>(UpdateState.Checking) }
    var syncMessage by remember { mutableStateOf("") }
    val appScope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        updateState = runCatching { ReleaseUpdateRepository.checkForUpdate(BuildConfig.GITHUB_REPOSITORY) }
            .fold(
                onSuccess = { update -> update?.let(UpdateState::Available) ?: UpdateState.UpToDate },
                onFailure = { error ->
                    Log.w("LexiNoteUpdate", "GitHub update check failed", error)
                    UpdateState.Failed(error.message ?: "无法连接 GitHub")
                }
            )
        val config = nutstoreSettings.load()
        if (config.isConfigured()) {
            syncMessage = "正在从坚果云检查词库…"
            runCatching { NutstoreWebDavRepository.downloadWordbooks(config) }
                .onSuccess { remoteBooks ->
                    runCatching { remoteBooks.sumOf { remote -> repo.import(remote.content, "nutstore:${remote.filename}", remote.filename.removeSuffix(".json")) } }
                        .onSuccess { count -> entries = repo.load(); books = repo.loadBooks(); syncMessage = "已从坚果云更新 $count 个词条；复习进度已保留" }
                        .onFailure { syncMessage = "坚果云词库无效：${it.message ?: "导入失败"}" }
                }
                .onFailure { syncMessage = "坚果云同步失败：${it.message ?: "网络错误"}" }
        }
    }
    val importer = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) runCatching {
            context.contentResolver.openInputStream(uri).use { stream ->
                requireNotNull(stream) { "无法读取该文件" }
                BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).readText()
            }
        }.onSuccess { content ->
            runCatching { repo.import(content) }.onSuccess { count ->
                entries = repo.load(); books = repo.loadBooks(); Toast.makeText(context, "已导入 $count 个词条", Toast.LENGTH_SHORT).show()
            }.onFailure { Toast.makeText(context, it.message ?: "导入失败", Toast.LENGTH_LONG).show() }
        }.onFailure { Toast.makeText(context, it.message ?: "读取失败", Toast.LENGTH_LONG).show() }
    }
    val importFile = { importer.launch(arrayOf("application/json", "text/plain", "*/*")) }
    when (page) {
        Page.HOME -> Home(entries, updateState, syncMessage, importFile, { page = Page.REVIEW }, { page = Page.LIBRARY }, { page = Page.SETTINGS }) { update ->
            if (!UpdateInstaller.canInstall(context)) {
                Toast.makeText(context, "请允许 LexiNote 安装未知来源应用后重试", Toast.LENGTH_LONG).show()
                UpdateInstaller.openInstallPermission(context)
            } else {
                UpdateInstaller.downloadAndInstall(context.applicationContext, update)
                Toast.makeText(context, "正在下载 ${update.version}", Toast.LENGTH_SHORT).show()
            }
        }
        Page.REVIEW -> ReviewPage(entries, onBack = { page = Page.HOME }) { entry, grade ->
            entries = entries.map { if (it.id == entry.id) it.copy(review = ReviewScheduler.schedule(it.review, grade)) else it }
            repo.updateReview(entry.id, entries.first { it.id == entry.id }.review)
        }
        Page.LIBRARY -> Library(books, importFile, onBack = { page = Page.HOME }) { book -> selectedBook = book; page = Page.WORDBOOK }
        Page.WORDBOOK -> selectedBook?.let { WordbookEntries(it, onBack = { page = Page.LIBRARY }) { entry -> selected = entry; page = Page.DETAIL } }
        Page.DETAIL -> selected?.let { Detail(it, onBack = { page = Page.WORDBOOK }) }
        Page.SETTINGS -> NutstoreSettingsPage(nutstoreSettings, onBack = { page = Page.HOME }) { config -> appScope.launch {
                syncMessage = "正在从坚果云检查词库…"
                runCatching { NutstoreWebDavRepository.downloadWordbooks(config) }
                    .onSuccess { remoteBooks -> runCatching { remoteBooks.sumOf { remote -> repo.import(remote.content, "nutstore:${remote.filename}", remote.filename.removeSuffix(".json")) } }
                        .onSuccess { count -> entries = repo.load(); books = repo.loadBooks(); syncMessage = "已从坚果云更新 $count 个词条；复习进度已保留" }
                        .onFailure { syncMessage = "坚果云词库无效：${it.message ?: "导入失败"}" }
                    }
                    .onFailure { syncMessage = "坚果云同步失败：${it.message ?: "网络错误"}" }
            }
        }
    }
}

@Composable private fun Home(entries: List<WordEntry>, updateState: UpdateState, syncMessage: String, onImport: () -> Unit, onReview: () -> Unit, onLibrary: () -> Unit, onSettings: () -> Unit, onUpdate: (UpdateInfo) -> Unit) {
    val due = entries.count { it.review.nextReviewAt == null || it.review.nextReviewAt <= System.currentTimeMillis() }
    Scaffold(topBar = { TopAppBar(title = { Text("LexiNote 背词") }, actions = { IconButton(onSettings) { Icon(Icons.Default.Settings, "坚果云设置") } }) }) { padding ->
        Column(Modifier.padding(padding).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("把 Zotero 生词本带在身边", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text("从 LexiNote 导出的 JSON 文件导入，所有复习记录只保存在本机。")
            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                Column(Modifier.padding(20.dp)) { Text("今日待复习", style = MaterialTheme.typography.labelLarge); Text("$due", style = MaterialTheme.typography.displayMedium, fontWeight = FontWeight.Bold); Text("共 ${entries.size} 个词条") }
            }
            UpdateBanner(updateState, onUpdate)
            syncMessage.takeIf { it.isNotBlank() }?.let { Text(it, color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall) }
            Button(onClick = onReview, Modifier.fillMaxWidth(), enabled = due > 0) { Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(8.dp)); Text("开始复习") }
            OutlinedButton(onClick = onLibrary, Modifier.fillMaxWidth()) { Icon(Icons.Default.LibraryBooks, null); Spacer(Modifier.width(8.dp)); Text("Zotero 词库") }
            OutlinedButton(onClick = onImport, Modifier.fillMaxWidth()) { Icon(Icons.Default.FileOpen, null); Spacer(Modifier.width(8.dp)); Text("导入 LexiNote JSON") }
        }
    }
}

@Composable private fun UpdateBanner(state: UpdateState, onUpdate: (UpdateInfo) -> Unit) {
    when (state) {
        UpdateState.Checking -> Text("正在检查更新…", color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall)
        UpdateState.UpToDate -> Text("当前已是最新版本", color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall)
        is UpdateState.Failed -> Text("暂时无法检查更新", color = Color(0xFF8A6A55), style = MaterialTheme.typography.bodySmall)
        is UpdateState.Available -> Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = Color(0xFFE8F4ED))) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("发现新版本 ${state.update.version}", fontWeight = FontWeight.Bold)
                    Text("下载完成后将打开系统安装器", style = MaterialTheme.typography.bodySmall)
                }
                Button(onClick = { onUpdate(state.update) }) { Text("下载更新") }
            }
        }
    }
}

@Composable private fun NutstoreSettingsPage(repository: NutstoreSettingsRepository, onBack: () -> Unit, onSync: (NutstoreConfig) -> Unit) {
    var config by remember { mutableStateOf(repository.load()) }
    var status by remember { mutableStateOf("") }
    Scaffold(topBar = { BackBar("坚果云同步", onBack) }) { padding ->
        LazyColumn(Modifier.padding(padding).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text("通过 WebDAV 同步词库", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
            item { Text("请填写坚果云账号邮箱和在“第三方应用管理”中生成的应用密码，不要填写登录密码。App 每次打开时检查 LexiNote 文件夹，并将其中每个 JSON 建为独立生词本。", style = MaterialTheme.typography.bodyMedium) }
            item { OutlinedTextField(config.serverUrl, { config = config.copy(serverUrl = it) }, Modifier.fillMaxWidth(), label = { Text("WebDAV 地址") }, singleLine = true) }
            item { OutlinedTextField(config.username, { config = config.copy(username = it) }, Modifier.fillMaxWidth(), label = { Text("坚果云账号邮箱") }, singleLine = true) }
            item { OutlinedTextField(config.password, { config = config.copy(password = it) }, Modifier.fillMaxWidth(), label = { Text("第三方应用密码") }, singleLine = true, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation()) }
            item {
                Button(onClick = {
                    runCatching { repository.save(config) }
                        .onSuccess { status = "设置已保存。" }
                        .onFailure { status = it.message ?: "设置保存失败" }
                }, modifier = Modifier.fillMaxWidth()) { Text("保存设置") }
            }
            item {
                OutlinedButton(onClick = {
                    runCatching { repository.save(config) }
                        .onSuccess { onSync(config); status = "正在同步…" }
                        .onFailure { status = it.message ?: "请先填写完整、有效的设置" }
                }, modifier = Modifier.fillMaxWidth(), enabled = config.isConfigured()) { Text("立即从坚果云同步") }
            }
            status.takeIf { it.isNotBlank() }?.let { item { Text(it, color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall) } }
        }
    }
}

@Composable private fun ReviewPage(entries: List<WordEntry>, onBack: () -> Unit, onGrade: (WordEntry, Int) -> Unit) {
    val card = entries.firstOrNull { it.review.nextReviewAt == null || it.review.nextReviewAt <= System.currentTimeMillis() }
    val sessionTotal = remember { entries.count { it.review.nextReviewAt == null || it.review.nextReviewAt <= System.currentTimeMillis() } }
    val remaining = entries.count { it.review.nextReviewAt == null || it.review.nextReviewAt <= System.currentTimeMillis() }
    val completed = (sessionTotal - remaining).coerceAtLeast(0)
    val progress = if (sessionTotal == 0) 1f else completed.toFloat() / sessionTotal
    var reveal by remember(card?.id) { mutableStateOf(false) }
    Scaffold(containerColor = Color(0xFFF8F8F3)) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp, vertical = 14.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onBack, contentPadding = PaddingValues(0.dp)) { Text("结束学习") }
                Spacer(Modifier.weight(1f))
                Text("今日复习", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Spacer(Modifier.weight(1f))
                Text("$completed / $sessionTotal", color = Color(0xFF6B6F68), style = MaterialTheme.typography.labelLarge)
            }
            Spacer(Modifier.height(10.dp))
            LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth().height(7.dp), color = Color(0xFF3B8F72), trackColor = Color(0xFFE0E7DE))
            Spacer(Modifier.height(24.dp))
            if (card == null) CompletedReview(onBack)
            else StudyCard(card, reveal, { reveal = true }, onGrade)
        }
    }
}

@Composable private fun StudyCard(card: WordEntry, reveal: Boolean, onReveal: () -> Unit, onGrade: (WordEntry, Int) -> Unit) {
    val cardShape = RoundedCornerShape(28.dp)
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(
            modifier = Modifier.fillMaxWidth().weight(1f).clickable(enabled = !reveal, onClick = onReveal),
            shape = cardShape,
            color = Color.White,
            shadowElevation = 5.dp,
            tonalElevation = 1.dp
        ) {
            Column(Modifier.fillMaxSize().padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Surface(shape = RoundedCornerShape(50), color = Color(0xFFE6F2E8)) { Text("来自论文生词本", modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp), color = Color(0xFF297454), style = MaterialTheme.typography.labelMedium) }
                Spacer(Modifier.height(28.dp))
                Text(card.word, style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
                card.phonetic.takeIf { it.isNotBlank() }?.let { Text(it, modifier = Modifier.padding(top = 10.dp), color = Color(0xFF6A706C), style = MaterialTheme.typography.titleMedium) }
                Spacer(Modifier.height(26.dp))
                if (!reveal) {
                    Text("先想想它的意思", color = Color(0xFF7C827D), style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(16.dp))
                    Surface(shape = RoundedCornerShape(18.dp), color = Color(0xFFF0F5EF)) { Text("轻触卡片查看释义", modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp), color = Color(0xFF39775C), fontWeight = FontWeight.Medium) }
                } else {
                    HorizontalDivider(color = Color(0xFFE9ECE7))
                    Spacer(Modifier.height(22.dp))
                    Text(card.meanings.joinToString("\n"), style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
                    card.sourceSentence?.takeIf { it.isNotBlank() }?.let {
                        Spacer(Modifier.height(24.dp))
                        Text(it, color = Color(0xFF747974), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, maxLines = 4, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        Spacer(Modifier.height(18.dp))
        if (!reveal) Button(onClick = onReveal, modifier = Modifier.fillMaxWidth().height(54.dp), shape = RoundedCornerShape(18.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF3B8F72))) { Text("查看释义", fontWeight = FontWeight.Bold) }
        else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = { onGrade(card, 0) }, modifier = Modifier.weight(1f).height(56.dp), shape = RoundedCornerShape(18.dp), border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFE09372)), colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFC75A35))) { Text("再记一次\n明天复习", textAlign = TextAlign.Center) }
            Button(onClick = { onGrade(card, 2) }, modifier = Modifier.weight(1f).height(56.dp), shape = RoundedCornerShape(18.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF3B8F72))) { Text("认识了\n间隔复习", textAlign = TextAlign.Center) }
        }
        Spacer(Modifier.height(10.dp))
    }
}

@Composable private fun CompletedReview(onBack: () -> Unit) = Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
    Text("今日完成", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
    Text("每一次回忆，都会让知识更牢固。", modifier = Modifier.padding(top = 12.dp), color = Color(0xFF6B706C))
    Button(onClick = onBack, modifier = Modifier.padding(top = 28.dp), shape = RoundedCornerShape(18.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF3B8F72))) { Text("返回首页") }
}

@Composable private fun Library(books: List<StoredWordbook>, onImport: () -> Unit, onBack: () -> Unit, onOpen: (StoredWordbook) -> Unit) {
    Scaffold(topBar = { BackBar("Zotero 词库（${books.size}）", onBack, onImport) }) { padding ->
        LazyColumn(Modifier.padding(padding)) {
            item { Text("Zotero", modifier = Modifier.padding(20.dp, 16.dp, 20.dp, 4.dp), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
            item { Text("坚果云 LexiNote 文件夹中的每个 JSON 都会成为一个独立生词本。", modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = Color(0xFF6A706C)) }
            items(books, key = { it.id }) { book ->
                ListItem(headlineContent = { Text(book.title, fontWeight = FontWeight.SemiBold) }, supportingContent = { Text("${book.entries.size} 个词条") }, modifier = Modifier.clickable { onOpen(book) })
                HorizontalDivider()
            }
        }
    }
}

@Composable private fun WordbookEntries(book: StoredWordbook, onBack: () -> Unit, onOpen: (WordEntry) -> Unit) {
    var query by remember { mutableStateOf("") }
    val visible = book.entries.filter { it.word.contains(query, true) || it.meanings.any { meaning -> meaning.contains(query, true) } }
    Scaffold(topBar = { BackBar("${book.title}（${book.entries.size}）", onBack) }) { padding ->
        Column(Modifier.padding(padding)) {
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(16.dp), label = { Text("搜索单词或释义") }, singleLine = true)
            LazyColumn { items(visible, key = { it.id }) { entry ->
                ListItem(headlineContent = { Text(entry.word, fontWeight = FontWeight.SemiBold) }, supportingContent = { Text(entry.meanings.firstOrNull() ?: "暂无释义", maxLines = 1, overflow = TextOverflow.Ellipsis) }, modifier = Modifier.clickable { onOpen(entry) })
                HorizontalDivider()
            } }
        }
    }
}

@Composable private fun Detail(entry: WordEntry, onBack: () -> Unit) {
    Scaffold(topBar = { BackBar(entry.word, onBack) }) { padding -> LazyColumn(Modifier.padding(padding).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { if (entry.phonetic.isNotBlank()) Text(entry.phonetic, style = MaterialTheme.typography.titleMedium) }
        item { Text(entry.meanings.joinToString("\n"), style = MaterialTheme.typography.titleLarge) }
        entry.example.takeIf { it.isNotBlank() }?.let { item { Text("例句\n$it") } }
        entry.sourceSentence?.takeIf { it.isNotBlank() }?.let { item { Text("原文\n$it") } }
        entry.source?.let { item { Text("来源：${it.title}${it.pageLabel?.let { page -> " · 第 $page 页" } ?: ""}", style = MaterialTheme.typography.bodySmall) } }
    } }
}

@Composable private fun BackBar(title: String, onBack: () -> Unit, onAction: (() -> Unit)? = null) = TopAppBar(title = { Text(title) }, navigationIcon = { IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } }, actions = { if (onAction != null) IconButton(onAction) { Icon(Icons.Default.FileOpen, "导入") } })
