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
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.BookmarkBorder
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.FileOpen
import androidx.compose.material.icons.filled.LibraryBooks
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
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

private enum class Page { HOME, REVIEW, LIBRARY, WORDBOOK, DETAIL, STUDY_SCOPE, SETTINGS }

@Composable private fun LexiNoteApp() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val repo = remember { WordbookRepository(context) }
    val nutstoreSettings = remember { NutstoreSettingsRepository(context) }
    val dictionarySettings = remember { BaiduDictionarySettingsRepository(context) }
    val dictionaryHistory = remember { DictionarySearchHistoryRepository(context) }
    val studyScopeRepository = remember { StudyScopeRepository(context) }
    var entries by remember { mutableStateOf(repo.load()) }
    var books by remember { mutableStateOf(repo.loadBooks()) }
    var studyScope by remember { mutableStateOf(studyScopeRepository.load()) }
    var page by remember { mutableStateOf(Page.HOME) }
    var reviewMode by remember { mutableStateOf(ReviewMode.DUE) }
    var selected by remember { mutableStateOf<WordEntry?>(null) }
    var selectedBook by remember { mutableStateOf<StoredWordbook?>(null) }
    var updateState by remember { mutableStateOf<UpdateState>(UpdateState.Checking) }
    var betaUpdateState by remember { mutableStateOf<UpdateState?>(null) }
    var syncMessage by remember { mutableStateOf("") }
    var dictionaryConfig by remember { mutableStateOf(dictionarySettings.load()) }
    var searchHistory by remember { mutableStateOf(dictionaryHistory.load(dictionaryConfig.historyLimit)) }
    val appScope = rememberCoroutineScope()
    val syncFromNutstore: (NutstoreConfig) -> Unit = { config ->
        appScope.launch {
            syncMessage = "正在从坚果云检查词库…"
            runCatching { NutstoreWebDavRepository.downloadWordbooks(config) }
                .onSuccess { remoteBooks ->
                    if (remoteBooks.isEmpty()) {
                        syncMessage = "坚果云 LexiNote 文件夹中暂无 JSON 词库"
                    } else runCatching {
                        val entryCount = remoteBooks.sumOf { remote -> repo.import(remote.content, "nutstore:${remote.filename}", remote.filename.removeSuffix(".json")) }
                        remoteBooks.size to entryCount
                    }.onSuccess { (bookCount, entryCount) ->
                        entries = repo.load(); books = repo.loadBooks()
                        syncMessage = "已从坚果云更新 $bookCount 本词库、$entryCount 个词条；复习进度已保留"
                    }.onFailure { syncMessage = "坚果云词库无效：${it.message ?: "导入失败"}" }
                }
                .onFailure { syncMessage = "坚果云同步失败：${it.message ?: "网络错误"}" }
        }
    }
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
        if (config.isConfigured()) syncFromNutstore(config)
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
    val scopedEntries = studyScope.entriesFrom(books)
    val checkBetaUpdate: () -> Unit = {
        appScope.launch {
            betaUpdateState = UpdateState.Checking
            betaUpdateState = runCatching { ReleaseUpdateRepository.checkForUpdate(BuildConfig.GITHUB_REPOSITORY, UpdateChannel.BETA) }
                .fold(
                    onSuccess = { update -> update?.let(UpdateState::Available) ?: UpdateState.UpToDate },
                    onFailure = { error -> UpdateState.Failed(error.message ?: "无法连接 GitHub") }
                )
        }
        Unit
    }
    val checkStableUpdate: () -> Unit = {
        appScope.launch {
            updateState = UpdateState.Checking
            updateState = runCatching { ReleaseUpdateRepository.checkForUpdate(BuildConfig.GITHUB_REPOSITORY) }
                .fold(
                    onSuccess = { update -> update?.let(UpdateState::Available) ?: UpdateState.UpToDate },
                    onFailure = { error -> UpdateState.Failed(error.message ?: "无法连接 GitHub") }
                )
        }
        Unit
    }
    val createWordbook: (String) -> Result<StoredWordbook> = { title -> runCatching { repo.createBook(title) }.onSuccess { books = repo.loadBooks() } }
    val saveDictionaryEntry: (DictionaryResult, String) -> Result<Unit> = { result, bookId -> runCatching {
        repo.saveDictionaryEntry(bookId, result)
        entries = repo.load(); books = repo.loadBooks()
    } }
    val deleteHistory: (String) -> Unit = { word -> searchHistory = dictionaryHistory.delete(word, dictionaryConfig.historyLimit) }
    val renameBook: (String, String) -> Result<Unit> = { id, title -> runCatching { repo.renameBook(id, title); books = repo.loadBooks(); selectedBook = books.firstOrNull { it.id == id } } }
    val deleteBook: (String) -> Unit = { id -> repo.deleteBook(id); books = repo.loadBooks(); entries = repo.load(); if (selectedBook?.id == id) selectedBook = null }
    val deleteEntry: (String, String) -> Unit = { bookId, entryId -> repo.deleteEntry(bookId, entryId); books = repo.loadBooks(); entries = repo.load(); selectedBook = books.firstOrNull { it.id == bookId } }
    val installUpdate: (UpdateInfo) -> Unit = { update ->
        if (!UpdateInstaller.canInstall(context)) {
            Toast.makeText(context, "请允许 LexiNote 安装未知来源应用后重试", Toast.LENGTH_LONG).show()
            UpdateInstaller.openInstallPermission(context)
        } else {
            UpdateInstaller.downloadAndInstall(context.applicationContext, update)
            Toast.makeText(context, "正在下载 ${update.version}", Toast.LENGTH_SHORT).show()
        }
    }
    when (page) {
        Page.HOME -> Home(
            entries = scopedEntries,
            updateState = updateState,
            syncMessage = syncMessage,
            onImport = importFile,
            onReview = { reviewMode = ReviewMode.DUE; page = Page.REVIEW },
            onReviewAll = { reviewMode = ReviewMode.ALL; page = Page.REVIEW },
            onReviewMarked = { reviewMode = ReviewMode.MARKED; page = Page.REVIEW },
            onLibrary = { page = Page.LIBRARY },
            onManageStudyScope = { page = Page.STUDY_SCOPE },
            onSettings = { page = Page.SETTINGS },
            dictionaryConfig = dictionaryConfig,
            searchHistory = searchHistory,
            books = books,
            onLookup = { word, onResult -> appScope.launch {
                val lookup = runCatching { BaiduDictionaryRepository.lookup(word, dictionaryConfig) }
                lookup.onSuccess { result -> searchHistory = dictionaryHistory.record(result.word, dictionaryConfig.historyLimit) }
                onResult(lookup)
            } },
            onSaveToBook = saveDictionaryEntry,
            onCreateBook = createWordbook,
            onDeleteHistory = deleteHistory,
            onCheckUpdate = checkStableUpdate,
            onUpdate = installUpdate
        )
        Page.REVIEW -> ReviewPage(
            entries = scopedEntries,
            mode = reviewMode,
            dictionaryConfig = dictionaryConfig,
            searchHistory = searchHistory,
            books = books,
            onBack = { page = Page.HOME },
            onLookup = { word, onResult -> appScope.launch {
                val lookup = runCatching { BaiduDictionaryRepository.lookup(word, dictionaryConfig) }
                lookup.onSuccess { result -> searchHistory = dictionaryHistory.record(result.word, dictionaryConfig.historyLimit) }
                onResult(lookup)
            } },
            onSaveToBook = saveDictionaryEntry,
            onCreateBook = createWordbook,
            onDeleteHistory = deleteHistory,
            onMarkedChanged = { entry, marked ->
                repo.updateMarked(entry.id, marked)
                entries = repo.load()
                books = repo.loadBooks()
            }
        ) { entry, grade, marked ->
            val updatedReview = ReviewScheduler.schedule(entry.review, grade)
            repo.updateStudyState(entry.id, updatedReview, marked)
            entries = repo.load()
            books = repo.loadBooks()
        }
        Page.LIBRARY -> Library(books, importFile, createWordbook, renameBook, deleteBook, onBack = { page = Page.HOME }) { book -> selectedBook = book; page = Page.WORDBOOK }
        Page.WORDBOOK -> selectedBook?.let { WordbookEntries(it, deleteEntry, onBack = { page = Page.LIBRARY }) { entry -> selected = entry; page = Page.DETAIL } }
        Page.DETAIL -> selected?.let { Detail(it, onBack = { page = Page.WORDBOOK }) }
        Page.STUDY_SCOPE -> StudyScopePage(
            books = books,
            studyScope = studyScope,
            onBack = { page = Page.HOME },
            onStudyScopeChanged = { scope -> studyScope = scope; studyScopeRepository.save(scope) }
        )
        Page.SETTINGS -> NutstoreSettingsPage(
            repository = nutstoreSettings,
            dictionaryRepository = dictionarySettings,
            syncMessage = syncMessage,
            betaUpdateState = betaUpdateState,
            onBack = { page = Page.HOME },
            onSync = syncFromNutstore,
            onDictionaryConfigSaved = { saved -> dictionaryConfig = saved; searchHistory = dictionaryHistory.trim(saved.historyLimit) },
            onCheckBeta = checkBetaUpdate,
            onUpdate = installUpdate
        )
    }
}

@Composable private fun Home(entries: List<WordEntry>, updateState: UpdateState, syncMessage: String, onImport: () -> Unit, onReview: () -> Unit, onReviewAll: () -> Unit, onReviewMarked: () -> Unit, onLibrary: () -> Unit, onManageStudyScope: () -> Unit, onSettings: () -> Unit, dictionaryConfig: BaiduDictionaryConfig, searchHistory: List<String>, books: List<StoredWordbook>, onLookup: (String, (Result<DictionaryResult>) -> Unit) -> Unit, onSaveToBook: (DictionaryResult, String) -> Result<Unit>, onCreateBook: (String) -> Result<StoredWordbook>, onDeleteHistory: (String) -> Unit, onCheckUpdate: () -> Unit, onUpdate: (UpdateInfo) -> Unit) {
    val due = entries.count { it.review.nextReviewAt == null || it.review.nextReviewAt <= System.currentTimeMillis() }
    val marked = entries.count { it.marked }
    var selectedTab by rememberSaveable { mutableIntStateOf(0) }
    Scaffold(topBar = { TopAppBar(title = { Text("LexiNote 背词") }, actions = { IconButton(onSettings) { Icon(Icons.Default.Settings, "设置") } }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            TabRow(selectedTabIndex = selectedTab) { listOf("背词", "查词").forEachIndexed { index, title -> Tab(selected = selectedTab == index, onClick = { selectedTab = index }, text = { Text(title) }) } }
            if (selectedTab == 1) {
                DictionaryLookupPage(dictionaryConfig, searchHistory, books, onSettings, onLookup, onSaveToBook, onCreateBook, onDeleteHistory, Modifier.weight(1f))
                return@Scaffold
            }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("把 Zotero 生词本带在身边", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text("从 LexiNote 导出的 JSON 文件导入，所有复习记录只保存在本机。")
            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                Column(Modifier.padding(20.dp)) { Text("今日待复习", style = MaterialTheme.typography.labelLarge); Text("$due", style = MaterialTheme.typography.displayMedium, fontWeight = FontWeight.Bold); Text("共 ${entries.size} 个词条") }
            }
            UpdateBanner(updateState, onCheckUpdate, onUpdate)
            syncMessage.takeIf { it.isNotBlank() }?.let { Text(it, color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall) }
            Button(onClick = onReview, Modifier.fillMaxWidth(), enabled = due > 0) { Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(8.dp)); Text("开始复习") }
            OutlinedButton(onClick = onReviewAll, Modifier.fillMaxWidth(), enabled = entries.isNotEmpty()) { Text("全部复习") }
            OutlinedButton(onClick = onReviewMarked, Modifier.fillMaxWidth(), enabled = marked > 0) { Icon(Icons.Default.Bookmark, null); Spacer(Modifier.width(8.dp)); Text("复习标记单词（$marked）") }
            OutlinedButton(onClick = onLibrary, Modifier.fillMaxWidth()) { Icon(Icons.Default.LibraryBooks, null); Spacer(Modifier.width(8.dp)); Text("Zotero 词库") }
            OutlinedButton(onClick = onImport, Modifier.fillMaxWidth()) { Icon(Icons.Default.FileOpen, null); Spacer(Modifier.width(8.dp)); Text("导入 LexiNote JSON") }
            OutlinedButton(onClick = onManageStudyScope, Modifier.fillMaxWidth()) { Icon(Icons.Default.LibraryBooks, null); Spacer(Modifier.width(8.dp)); Text("管理背词词库") }
            }
        }
    }
}

@Composable private fun DictionaryLookupPage(config: BaiduDictionaryConfig, searchHistory: List<String>, books: List<StoredWordbook>, onSettings: () -> Unit, onLookup: (String, (Result<DictionaryResult>) -> Unit) -> Unit, onSaveToBook: (DictionaryResult, String) -> Result<Unit>, onCreateBook: (String) -> Result<StoredWordbook>, onDeleteHistory: (String) -> Unit, modifier: Modifier = Modifier, showSettingsButton: Boolean = true) {
    var word by rememberSaveable { mutableStateOf("") }
    var result by remember { mutableStateOf<DictionaryResult?>(null) }
    var message by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var savingResult by remember { mutableStateOf<DictionaryResult?>(null) }
    var creatingBookForResult by remember { mutableStateOf<DictionaryResult?>(null) }
    var historyToDelete by remember { mutableStateOf<String?>(null) }
    fun query(queryWord: String = word) {
        word = queryWord
        loading = true; result = null; message = "正在查词…"
        onLookup(queryWord) { response -> loading = false; response.onSuccess { result = it; message = "" }.onFailure { message = it.message ?: "查词失败" } }
    }
    LazyColumn(modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item { Text("百度词典", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold) }
        item { Text("输入英文单词，获取音标、词性释义和例句。", color = Color(0xFF6A706C)) }
        item { OutlinedTextField(word, { newWord -> word = newWord }, Modifier.fillMaxWidth(), label = { Text("英文单词") }, singleLine = true, enabled = !loading) }
        if (searchHistory.isNotEmpty()) {
            item { Text("历史记录", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold) }
            items(searchHistory, key = { it.lowercase() }) { previousWord ->
                ListItem(headlineContent = { Text(previousWord) }, trailingContent = { IconButton(onClick = { historyToDelete = previousWord }) { Icon(Icons.Default.Delete, "删除历史记录") } }, modifier = Modifier.fillMaxWidth().clickable(enabled = !loading && config.isConfigured()) { query(previousWord) })
                HorizontalDivider()
            }
        }
        item { Button(onClick = ::query, modifier = Modifier.fillMaxWidth(), enabled = !loading && word.isNotBlank() && config.isConfigured()) { Text(if (loading) "查询中…" else "查词") } }
        if (!config.isConfigured()) item { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { Text("请先在设置中填写百度 API Key 和 Secret Key。", color = Color(0xFF8A6A55)); if (showSettingsButton) OutlinedButton(onClick = onSettings) { Text("打开设置") } } }
        message.takeIf { it.isNotBlank() }?.let { item { Text(it, color = if (loading) Color(0xFF6A706C) else Color(0xFF8A6A55)) } }
        result?.let { lookup ->
            item { HorizontalDivider() }
            item { Text(lookup.word, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold) }
            lookup.phonetic.takeIf { it.isNotBlank() }?.let { item { Text("/$it/", style = MaterialTheme.typography.titleMedium, color = Color(0xFF6A706C)) } }
            item { Text(lookup.meanings.joinToString("\n"), style = MaterialTheme.typography.titleMedium) }
            if (lookup.examples.isNotEmpty()) item { Text("例句\n${lookup.examples.joinToString("\n") { "• $it" }}") }
            item { Button(onClick = { savingResult = lookup }, modifier = Modifier.fillMaxWidth()) { Text("保存到词库") } }
        }
    }
    savingResult?.let { lookup -> WordbookPickerDialog(
        books = books,
        onDismiss = { savingResult = null },
        onCreateBook = { creatingBookForResult = lookup },
        onSelect = { book ->
            onSaveToBook(lookup, book.id).onSuccess { message = "已保存到“${book.title}”" }.onFailure { message = it.message ?: "保存失败" }
            savingResult = null
        }
    ) }
    creatingBookForResult?.let { lookup -> CreateWordbookDialog(
        onDismiss = { creatingBookForResult = null },
        onCreate = { title ->
            onCreateBook(title).onSuccess { book ->
                onSaveToBook(lookup, book.id).onSuccess { message = "已新建“${book.title}”并保存" }.onFailure { message = it.message ?: "保存失败" }
                creatingBookForResult = null
                savingResult = null
            }.onFailure { message = it.message ?: "新建词库失败" }
        }
    ) }
    historyToDelete?.let { previousWord -> ConfirmDeleteDialog("删除历史记录", "确定删除“$previousWord”吗？", onDismiss = { historyToDelete = null }) { onDeleteHistory(previousWord); historyToDelete = null } }
}

@Composable private fun BetaUpdateBanner(state: UpdateState?, onCheck: () -> Unit, onUpdate: (UpdateInfo) -> Unit) {
    when (state) {
        null -> OutlinedButton(onClick = onCheck, modifier = Modifier.fillMaxWidth()) { Text("使用最新测试版") }
        UpdateState.Checking -> Text("正在检查最新测试版…", color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall)
        UpdateState.UpToDate -> Row(verticalAlignment = Alignment.CenterVertically) { Text("暂无可安装的更新测试版", modifier = Modifier.weight(1f), color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall); TextButton(onClick = onCheck) { Text("重试") } }
        is UpdateState.Failed -> Row(verticalAlignment = Alignment.CenterVertically) { Text("无法检查测试版：${state.reason}", modifier = Modifier.weight(1f), color = Color(0xFF8A6A55), style = MaterialTheme.typography.bodySmall); TextButton(onClick = onCheck) { Text("重试") } }
        is UpdateState.Available -> Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = Color(0xFFFFF2D8))) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("发现测试版 ${state.update.version}", fontWeight = FontWeight.Bold)
                    Text("测试版需由你主动选择安装", style = MaterialTheme.typography.bodySmall)
                }
                Button(onClick = { onUpdate(state.update) }) { Text("安装测试版") }
            }
        }
    }
}

@Composable private fun UpdateBanner(state: UpdateState, onCheck: () -> Unit, onUpdate: (UpdateInfo) -> Unit) {
    when (state) {
        UpdateState.Checking -> Text("正在检查更新…", color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall)
        UpdateState.UpToDate -> Row(verticalAlignment = Alignment.CenterVertically) { Text("当前已是最新版本", modifier = Modifier.weight(1f), color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall); TextButton(onClick = onCheck) { Text("重试") } }
        is UpdateState.Failed -> Row(verticalAlignment = Alignment.CenterVertically) { Text("无法检查更新：${state.reason}", modifier = Modifier.weight(1f), color = Color(0xFF8A6A55), style = MaterialTheme.typography.bodySmall); TextButton(onClick = onCheck) { Text("重试") } }
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

@Composable private fun NutstoreSettingsPage(repository: NutstoreSettingsRepository, dictionaryRepository: BaiduDictionarySettingsRepository, syncMessage: String, betaUpdateState: UpdateState?, onBack: () -> Unit, onSync: (NutstoreConfig) -> Unit, onDictionaryConfigSaved: (BaiduDictionaryConfig) -> Unit, onCheckBeta: () -> Unit, onUpdate: (UpdateInfo) -> Unit) {
    var config by remember { mutableStateOf(repository.load()) }
    var dictionaryConfig by remember { mutableStateOf(dictionaryRepository.load()) }
    var historyLimitText by remember { mutableStateOf(dictionaryConfig.historyLimit.toString()) }
    var savedConfig by remember { mutableStateOf(config) }
    var savedDictionaryConfig by remember { mutableStateOf(dictionaryConfig) }
    var saveStatus by remember { mutableStateOf("") }
    var showExitDialog by remember { mutableStateOf(false) }
    val dirty = config != savedConfig || dictionaryConfig != savedDictionaryConfig
    fun saveAll(onSaved: () -> Unit = {}) {
        runCatching {
            repository.save(config)
            dictionaryRepository.save(dictionaryConfig)
        }.onSuccess {
            savedConfig = config
            savedDictionaryConfig = dictionaryConfig
            onDictionaryConfigSaved(dictionaryConfig)
            saveStatus = "设置已保存。"
            onSaved()
        }.onFailure { saveStatus = it.message ?: "设置保存失败" }
    }
    fun requestExit() { if (dirty) showExitDialog = true else onBack() }
    BackHandler { requestExit() }
    if (showExitDialog) AlertDialog(
        onDismissRequest = { showExitDialog = false },
        title = { Text("未保存的设置") },
        text = { Text("设置尚未保存。是否保存后退出？") },
        confirmButton = { TextButton(onClick = { showExitDialog = false; saveAll(onBack) }) { Text("保存") } },
        dismissButton = {
            Row {
                TextButton(onClick = { showExitDialog = false; onBack() }) { Text("不保存") }
                TextButton(onClick = { showExitDialog = false }) { Text("继续编辑") }
            }
        }
    )
    Scaffold(topBar = { BackBar("设置", ::requestExit) }) { padding ->
        LazyColumn(Modifier.padding(padding).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text("百度文本翻译·词典版", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
            item { Text("仅在查词时将输入的单词发送给百度。请在百度智能云创建文本翻译应用后填写 API Key 和 Secret Key。", style = MaterialTheme.typography.bodyMedium) }
            item { OutlinedTextField(dictionaryConfig.apiKey, { dictionaryConfig = dictionaryConfig.copy(apiKey = it) }, Modifier.fillMaxWidth(), label = { Text("百度 API Key") }, singleLine = true, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation()) }
            item { OutlinedTextField(dictionaryConfig.secretKey, { dictionaryConfig = dictionaryConfig.copy(secretKey = it) }, Modifier.fillMaxWidth(), label = { Text("百度 Secret Key") }, singleLine = true, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation()) }
            item { OutlinedTextField(historyLimitText, { value ->
                if (value.all(Char::isDigit) && value.length <= 2) {
                    historyLimitText = value
                    value.toIntOrNull()?.takeIf { it in 1..50 }?.let { dictionaryConfig = dictionaryConfig.copy(historyLimit = it) }
                }
            }, Modifier.fillMaxWidth(), label = { Text("历史记录数量") }, supportingText = { Text("默认 5 条，范围为 1–50 条") }, singleLine = true) }
            item { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            item { Text("通过 WebDAV 同步词库", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
            item { Text("请填写坚果云账号邮箱和在“第三方应用管理”中生成的应用密码，不要填写登录密码。App 每次打开时检查 LexiNote 文件夹，并将其中每个 JSON 建为独立生词本。", style = MaterialTheme.typography.bodyMedium) }
            item { OutlinedTextField(config.serverUrl, { config = config.copy(serverUrl = it) }, Modifier.fillMaxWidth(), label = { Text("WebDAV 地址") }, singleLine = true) }
            item { OutlinedTextField(config.username, { config = config.copy(username = it) }, Modifier.fillMaxWidth(), label = { Text("坚果云账号邮箱") }, singleLine = true) }
            item { OutlinedTextField(config.password, { config = config.copy(password = it) }, Modifier.fillMaxWidth(), label = { Text("第三方应用密码") }, singleLine = true, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation()) }
            item {
                OutlinedButton(onClick = {
                    runCatching { config.validate() }
                        .onSuccess { onSync(config) }
                        .onFailure { saveStatus = it.message ?: "请先填写完整、有效的设置" }
                }, modifier = Modifier.fillMaxWidth(), enabled = config.isConfigured()) { Text("立即从坚果云同步") }
            }
            (syncMessage.ifBlank { saveStatus }).takeIf { it.isNotBlank() }?.let { item { Text(it, color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall) } }
            item { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            item { Text("测试版", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
            item { Text("测试版包含尚未正式发布的功能，需要由你主动检查并安装。", style = MaterialTheme.typography.bodyMedium) }
            item { BetaUpdateBanner(betaUpdateState, onCheckBeta, onUpdate) }
            item {
                val channel = if (BuildConfig.VERSION_NAME.contains("-beta")) "测试版" else "正式版"
                Text("当前版本：${BuildConfig.VERSION_NAME}（$channel）", color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall)
            }
            item { Button(onClick = { saveAll() }, modifier = Modifier.fillMaxWidth()) { Text("保存设置") } }
        }
    }
}

@Composable private fun StudyScopePage(books: List<StoredWordbook>, studyScope: StudyScope, onBack: () -> Unit, onStudyScopeChanged: (StudyScope) -> Unit) {
    Scaffold(topBar = { BackBar("管理背词词库", onBack) }) { padding ->
        LazyColumn(Modifier.padding(padding).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text("背词范围", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
            item { Text("首页待复习数量和开始复习的内容，仅包含这里选定的生词本。", style = MaterialTheme.typography.bodyMedium) }
            item {
                Row(Modifier.fillMaxWidth().clickable {
                    onStudyScopeChanged(if (studyScope.useAllBooks) StudyScope(false, books.map { it.id }.toSet()) else StudyScope(true))
                }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(studyScope.useAllBooks, onCheckedChange = { checked ->
                        onStudyScopeChanged(if (checked) StudyScope(true) else StudyScope(false, books.map { it.id }.toSet()))
                    })
                    Text("全部 Zotero 词库", fontWeight = FontWeight.Medium)
                }
            }
            if (!studyScope.useAllBooks) {
                if (books.isEmpty()) item { Text("尚无可选择的生词本。", color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall) }
                items(books, key = { it.id }) { book ->
                    val checked = book.id in studyScope.selectedBookIds
                    Row(Modifier.fillMaxWidth().clickable {
                        val selectedIds = if (checked) studyScope.selectedBookIds - book.id else studyScope.selectedBookIds + book.id
                        onStudyScopeChanged(studyScope.copy(selectedBookIds = selectedIds))
                    }.padding(start = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked, onCheckedChange = { selected ->
                            val selectedIds = if (selected) studyScope.selectedBookIds + book.id else studyScope.selectedBookIds - book.id
                            onStudyScopeChanged(studyScope.copy(selectedBookIds = selectedIds))
                        })
                        Column {
                            Text(book.title)
                            Text("${book.entries.size} 个词条", style = MaterialTheme.typography.bodySmall, color = Color(0xFF6A706C))
                        }
                    }
                }
            }
        }
    }
}

@Composable private fun ReviewPage(entries: List<WordEntry>, mode: ReviewMode, dictionaryConfig: BaiduDictionaryConfig, searchHistory: List<String>, books: List<StoredWordbook>, onBack: () -> Unit, onLookup: (String, (Result<DictionaryResult>) -> Unit) -> Unit, onSaveToBook: (DictionaryResult, String) -> Result<Unit>, onCreateBook: (String) -> Result<StoredWordbook>, onDeleteHistory: (String) -> Unit, onMarkedChanged: (WordEntry, Boolean) -> Unit, onGrade: (WordEntry, Int, Boolean?) -> Unit) {
    var queueIds by remember(mode) { mutableStateOf(ReviewSession.shuffledIds(entries, mode)) }
    var reviewProgress by remember(mode) { mutableStateOf(ReviewProgress()) }
    var showLookup by remember { mutableStateOf(false) }
    val sessionTotal = queueIds.size
    val card = queueIds.getOrNull(reviewProgress.currentIndex)?.let { id -> entries.firstOrNull { it.id == id } }
    val completed = reviewProgress.reviewedIndices.size
    val progress = if (sessionTotal == 0) 1f else completed.toFloat() / sessionTotal
    val finished = reviewProgress.isComplete(sessionTotal)
    var reveal by remember(card?.id) { mutableStateOf(false) }
    if (showLookup) {
        ReviewLookupPage(dictionaryConfig, searchHistory, books, onLookup, onSaveToBook, onCreateBook, onDeleteHistory, onBack = { showLookup = false })
    } else Scaffold(containerColor = Color(0xFFF8F8F3)) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp, vertical = 14.dp)) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                TextButton(onClick = onBack, contentPadding = PaddingValues(0.dp), modifier = Modifier.align(Alignment.CenterStart)) { Text("结束学习") }
                Text(if (finished) "本轮完成" else mode.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            }
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                if (!finished) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = { reviewProgress = reviewProgress.goBack() }, enabled = reviewProgress.canGoBack()) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "上一个单词")
                        }
                        Text("$completed / $sessionTotal", color = Color(0xFF6B6F68), style = MaterialTheme.typography.labelLarge)
                        IconButton(onClick = { reviewProgress = reviewProgress.goForward(sessionTotal) }, enabled = reviewProgress.canGoForward(sessionTotal)) {
                            Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = "下一个单词")
                        }
                    }
                    Row(modifier = Modifier.align(Alignment.CenterEnd), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { card?.let { onMarkedChanged(it, !it.marked) } }, enabled = card != null) {
                        Icon(
                            imageVector = if (card?.marked == true) Icons.Default.Bookmark else Icons.Default.BookmarkBorder,
                            contentDescription = if (card?.marked == true) "取消标记" else "标记单词",
                            tint = if (card?.marked == true) Color(0xFFE0A12D) else LocalContentColor.current
                        )
                    }
                    IconButton(onClick = { showLookup = true }) { Icon(Icons.Default.Search, "查词") }
                    }
                }
            }
            Spacer(Modifier.height(10.dp))
            LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth().height(7.dp), color = Color(0xFF3B8F72), trackColor = Color(0xFFE0E7DE))
            Spacer(Modifier.height(24.dp))
            if (card == null || finished) CompletedReview(mode, sessionTotal, onBack)
            else StudyCard(card, mode, reveal, { reveal = true }) { entry, grade, marked ->
                reviewProgress = reviewProgress.gradeCurrent(sessionTotal)
                onGrade(entry, grade, marked)
            }
        }
    }
}

@Composable private fun ReviewLookupPage(config: BaiduDictionaryConfig, searchHistory: List<String>, books: List<StoredWordbook>, onLookup: (String, (Result<DictionaryResult>) -> Unit) -> Unit, onSaveToBook: (DictionaryResult, String) -> Result<Unit>, onCreateBook: (String) -> Result<StoredWordbook>, onDeleteHistory: (String) -> Unit, onBack: () -> Unit) {
    Scaffold(topBar = { TopAppBar(title = { Text("查词") }, navigationIcon = { IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回复习") } }) }) { padding ->
        DictionaryLookupPage(config, searchHistory, books, onSettings = {}, onLookup = onLookup, onSaveToBook = onSaveToBook, onCreateBook = onCreateBook, onDeleteHistory = onDeleteHistory, modifier = Modifier.fillMaxSize().padding(padding), showSettingsButton = false)
    }
}

@Composable private fun StudyCard(card: WordEntry, mode: ReviewMode, reveal: Boolean, onReveal: () -> Unit, onGrade: (WordEntry, Int, Boolean?) -> Unit) {
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
            val markedReview = mode == ReviewMode.MARKED
            OutlinedButton(onClick = { onGrade(card, 0, if (markedReview) true else null) }, modifier = Modifier.weight(1f).height(56.dp), shape = RoundedCornerShape(18.dp), border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFE09372)), colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFC75A35))) {
                Text(if (markedReview) "不认识\n保留标记" else "再记一次\n明天复习", textAlign = TextAlign.Center)
            }
            Button(onClick = { onGrade(card, 2, if (markedReview) false else null) }, modifier = Modifier.weight(1f).height(56.dp), shape = RoundedCornerShape(18.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF3B8F72))) {
                Text(if (markedReview) "认识\n取消标记" else "认识了\n间隔复习", textAlign = TextAlign.Center)
            }
        }
        Spacer(Modifier.height(10.dp))
    }
}

@Composable private fun CompletedReview(mode: ReviewMode, completed: Int, onBack: () -> Unit) = Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
    Text(if (mode == ReviewMode.MARKED) "标记复习完成" else "本轮复习完成", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
    Text(if (mode == ReviewMode.MARKED) "已完成 $completed 个标记词复习。" else "每一次回忆，都会让知识更牢固。", modifier = Modifier.padding(top = 12.dp), color = Color(0xFF6B706C))
    Button(onClick = onBack, modifier = Modifier.padding(top = 28.dp), shape = RoundedCornerShape(18.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF3B8F72))) { Text("返回首页") }
}

@Composable private fun Library(books: List<StoredWordbook>, onImport: () -> Unit, onCreateBook: (String) -> Result<StoredWordbook>, onRenameBook: (String, String) -> Result<Unit>, onDeleteBook: (String) -> Unit, onBack: () -> Unit, onOpen: (StoredWordbook) -> Unit) {
    var showCreateBook by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }
    var editingBook by remember { mutableStateOf<StoredWordbook?>(null) }
    var deletingBook by remember { mutableStateOf<StoredWordbook?>(null) }
    Scaffold(topBar = { TopAppBar(title = { Text("Zotero 词库（${books.size}）") }, navigationIcon = { IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } }, actions = { IconButton(onImport) { Icon(Icons.Default.FileOpen, "导入") }; IconButton(onClick = { showCreateBook = true }) { Icon(Icons.Default.Add, "新建词库") } }) }) { padding ->
        LazyColumn(Modifier.padding(padding)) {
            item { Text("Zotero", modifier = Modifier.padding(20.dp, 16.dp, 20.dp, 4.dp), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
            item { Text("坚果云 LexiNote 文件夹中的每个 JSON 都会成为一个独立生词本。", modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = Color(0xFF6A706C)) }
            items(books, key = { it.id }) { book ->
                ListItem(headlineContent = { Text(book.title, fontWeight = FontWeight.SemiBold) }, supportingContent = { Text("${book.entries.size} 个词条") }, trailingContent = { IconButton(onClick = { editingBook = book }) { Icon(Icons.Default.Edit, "编辑词库") } }, modifier = Modifier.clickable { onOpen(book) })
                HorizontalDivider()
            }
            message.takeIf { it.isNotBlank() }?.let { item { Text(it, modifier = Modifier.padding(20.dp), color = Color(0xFF6A706C), style = MaterialTheme.typography.bodySmall) } }
        }
    }
    if (showCreateBook) CreateWordbookDialog(
        onDismiss = { showCreateBook = false },
        onCreate = { title -> onCreateBook(title).onSuccess { message = "已新建词库“${it.title}”"; showCreateBook = false }.onFailure { message = it.message ?: "新建词库失败" } }
    )
    editingBook?.let { book -> EditWordbookDialog(book, onDismiss = { editingBook = null }, onRename = { title -> onRenameBook(book.id, title).onSuccess { message = "已修改词库名称"; editingBook = null }.onFailure { message = it.message ?: "修改失败" } }, onDelete = { editingBook = null; deletingBook = book }) }
    deletingBook?.let { book -> ConfirmDeleteDialog("删除词库", "确定删除“${book.title}”及其中全部词条吗？此操作不会删除坚果云上的 JSON 文件。", onDismiss = { deletingBook = null }) { onDeleteBook(book.id); deletingBook = null; message = "已删除词库“${book.title}”" } }
}

@Composable private fun WordbookPickerDialog(books: List<StoredWordbook>, onDismiss: () -> Unit, onCreateBook: () -> Unit, onSelect: (StoredWordbook) -> Unit) = AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text("保存到词库") },
    text = {
        if (books.isEmpty()) Text("暂无词库，请先新建一个词库。")
        else LazyColumn { items(books, key = { it.id }) { book -> ListItem(headlineContent = { Text(book.title) }, supportingContent = { Text("${book.entries.size} 个词条") }, modifier = Modifier.fillMaxWidth().clickable { onSelect(book) }) } }
    },
    confirmButton = { TextButton(onClick = onCreateBook) { Text("新建词库") } },
    dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
)

@Composable private fun CreateWordbookDialog(onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    var title by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新建词库") },
        text = { OutlinedTextField(title, { title = it }, label = { Text("词库名称") }, singleLine = true) },
        confirmButton = { TextButton(onClick = { onCreate(title) }, enabled = title.trim().isNotEmpty()) { Text("新建") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

@Composable private fun EditWordbookDialog(book: StoredWordbook, onDismiss: () -> Unit, onRename: (String) -> Unit, onDelete: () -> Unit) {
    var title by remember(book.id) { mutableStateOf(book.title) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("编辑词库") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(title, { title = it }, label = { Text("词库名称") }, singleLine = true)
            Text("仅修改 App 本地名称，不会重命名坚果云 JSON 文件。同步仍使用原远端文件匹配词库。", color = Color(0xFF8A6A55), style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = onDelete) { Text("删除词库", color = MaterialTheme.colorScheme.error) }
        } },
        confirmButton = { TextButton(onClick = { onRename(title) }, enabled = title.trim().isNotEmpty()) { Text("保存") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

@Composable private fun ConfirmDeleteDialog(title: String, message: String, onDismiss: () -> Unit, onConfirm: () -> Unit) = AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(title) },
    text = { Text(message) },
    confirmButton = { TextButton(onClick = onConfirm) { Text("删除", color = MaterialTheme.colorScheme.error) } },
    dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
)

@Composable private fun WordbookEntries(book: StoredWordbook, onDeleteEntry: (String, String) -> Unit, onBack: () -> Unit, onOpen: (WordEntry) -> Unit) {
    var query by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf(false) }
    var deletingEntry by remember { mutableStateOf<WordEntry?>(null) }
    val visible = book.entries.filter { it.word.contains(query, true) || it.meanings.any { meaning -> meaning.contains(query, true) } }
    Scaffold(topBar = { TopAppBar(title = { Text("${book.title}（${book.entries.size}）") }, navigationIcon = { IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } }, actions = { IconButton(onClick = { editing = !editing }) { Icon(Icons.Default.Edit, if (editing) "完成编辑" else "编辑词条") } }) }) { padding ->
        Column(Modifier.padding(padding)) {
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(16.dp), label = { Text("搜索单词或释义") }, singleLine = true)
            LazyColumn { items(visible, key = { it.id }) { entry ->
                ListItem(headlineContent = { Text(entry.word, fontWeight = FontWeight.SemiBold) }, supportingContent = { Text(entry.meanings.firstOrNull() ?: "暂无释义", maxLines = 1, overflow = TextOverflow.Ellipsis) }, trailingContent = { if (editing) IconButton(onClick = { deletingEntry = entry }) { Icon(Icons.Default.Delete, "删除词条") } }, modifier = Modifier.clickable(enabled = !editing) { onOpen(entry) })
                HorizontalDivider()
            } }
        }
    }
    deletingEntry?.let { entry -> ConfirmDeleteDialog("删除词条", "确定从“${book.title}”删除“${entry.word}”吗？", onDismiss = { deletingEntry = null }) { onDeleteEntry(book.id, entry.id); deletingEntry = null } }
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
