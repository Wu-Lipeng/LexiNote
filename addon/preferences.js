var LexiNotePreferences = window.LexiNotePreferences = {
  init() {
    const $ = id => document.getElementById("lexinote-" + id);
    const app = Zotero.LexiNote;
    if (!app || $("settings").dataset.initialized) return;
    $("settings").dataset.initialized = "true";
    const names = ["provider", "endpoint", "method", "headers", "body", "meaningPath", "phoneticPath", "examplePath", "target", "delay", "timeout", "highlightColor", "highlightType", "nutstoreServerUrl"];
    for (const name of names) $(name).value = app.config[name];
    $("enabled").checked = app.config.enabled;
    $("autoHighlight").checked = Boolean(app.config.autoHighlight);
    $("openNoteAfterSave").checked = Boolean(app.config.openNoteAfterSave);
    $("autoLocateSavedWord").checked = Boolean(app.config.autoLocateSavedWord);
    $("noteLocateMode").value = app.config.noteLocateMode || "select";
    $("showNoteLocateStatus").checked = Boolean(app.config.showNoteLocateStatus);
    $("nutstoreEnabled").checked = Boolean(app.config.nutstoreEnabled);
    const nutstoreCredentials = app.nutstoreCredentials();
    $("nutstoreUsername").value = nutstoreCredentials.username;
    $("nutstorePassword").value = nutstoreCredentials.password;
    const updateNutstoreAvailability = () => { $("syncWordbook").disabled = !app.isNutstoreConfigured(); };
    updateNutstoreAvailability();
    const baiduDrafts = {};
    let dirty = false;
    let previousProvider = $("provider").value;
    const loadBaiduCredentials = () => {
      const provider = $("provider").value;
      if (!["baidu", "baidu-general"].includes(provider)) { $("baiduApiKey").value = ""; $("baiduSecretKey").value = ""; return; }
      if (baiduDrafts[provider]) {
        $("baiduApiKey").value = baiduDrafts[provider].apiKey;
        $("baiduSecretKey").value = baiduDrafts[provider].secretKey;
        return;
      }
      const names = app.baiduCredentialNames(provider);
      const current = app.config.provider === provider ? app.config : {};
      const legacyApiKey = current.baiduApiKey || (provider === "baidu" ? (app.getCredential("Baidu API Key") || app.getKey()) : "");
      const legacySecretKey = current.baiduSecretKey || (provider === "baidu" ? app.getCredential("Baidu Secret Key") : "");
      $("baiduApiKey").value = app.getCredential(names.apiKey) || legacyApiKey;
      $("baiduSecretKey").value = app.getCredential(names.secretKey) || legacySecretKey;
    };
    const rememberBaiduCredentials = () => {
      if (["baidu", "baidu-general"].includes(previousProvider)) {
        baiduDrafts[previousProvider] = { apiKey: $("baiduApiKey").value, secretKey: $("baiduSecretKey").value };
      }
    };
    loadBaiduCredentials();
    $("useBaiduTrial").checked = Boolean(app.config.useBaiduTrial);
    try { $("key").value = app.getKey(); }
    catch (_) { $("status").textContent = "无法读取凭据存储，请解锁后重新打开设置。"; $("save").disabled = true; }
    const read = () => {
      const config = { enabled: $("enabled").checked, autoHighlight: $("autoHighlight").checked, openNoteAfterSave: $("openNoteAfterSave").checked, autoLocateSavedWord: $("autoLocateSavedWord").checked, noteLocateMode: $("noteLocateMode").value, showNoteLocateStatus: $("showNoteLocateStatus").checked, nutstoreEnabled: $("nutstoreEnabled").checked };
      for (const name of names) config[name] = ["delay", "timeout"].includes(name) ? Number($(name).value) : $(name).value;
      config.baiduApiKey = $("baiduApiKey").value.trim(); config.baiduSecretKey = $("baiduSecretKey").value.trim();
      config.useBaiduTrial = $("useBaiduTrial").checked;
      return config;
    };
    const restoreFeatureDefaults = () => {
      if (!window.confirm("确定恢复功能默认设置吗？接口设置和已保存凭据不会改变。")) return;
      const defaults = typeof LexiNoteCore !== "undefined" ? LexiNoteCore.defaults : {
        enabled: true, autoHighlight: true, openNoteAfterSave: true, autoLocateSavedWord: true, noteLocateMode: "select", showNoteLocateStatus: false, highlightColor: "#c0c0c0", highlightType: "highlight", delay: 350, timeout: 12000
      };
      $("enabled").checked = defaults.enabled;
      $("autoHighlight").checked = defaults.autoHighlight;
      $("openNoteAfterSave").checked = defaults.openNoteAfterSave;
      $("autoLocateSavedWord").checked = defaults.autoLocateSavedWord;
      $("noteLocateMode").value = defaults.noteLocateMode;
      $("showNoteLocateStatus").checked = defaults.showNoteLocateStatus;
      $("highlightColor").value = defaults.highlightColor;
      $("highlightType").value = defaults.highlightType;
      $("delay").value = defaults.delay;
      $("timeout").value = defaults.timeout;
      dirty = true;
      $("status").textContent = "已恢复功能默认设置。请点击“保存设置”以应用。";
    };
    $("restoreFeatures").addEventListener("click", restoreFeatureDefaults);
    const saveConfig = async (closeAfterSave = false) => {
      $("save").disabled = true;
      try {
        const config = read();
        await app.saveConfig(config, ["baidu", "baidu-general"].includes(config.provider) ? $("baiduApiKey").value.trim() : $("key").value, $("nutstoreUsername").value.trim(), $("nutstorePassword").value);
        dirty = false;
        updateNutstoreAvailability();
        $("status").textContent = "设置已保存，立即生效。";
        return true;
      }
      catch (e) { $("status").textContent = e.message; }
      finally {
        $("save").disabled = false;
        if (closeAfterSave) { dirty = false; window.close(); }
      }
      return false;
    };
    $("save").addEventListener("click", () => saveConfig());
    $("syncHighlights").addEventListener("click", async () => {
      if (!window.confirm("将双向匹配当前 PDF 的高亮与生词词条，并将匹配词条更新为当前格式。是否继续？")) return;
      $("syncHighlights").disabled = true;
      try {
        if (!await saveConfig()) return;
        $("syncStatus").textContent = "正在扫描当前 PDF 的高亮…";
        const result = await app.syncCurrentPDFHighlightsToNotebook();
        $("syncStatus").textContent = `已更新 ${result.matched} 个匹配词条，更新 ${result.updated} 本生词本。`;
        try { renderSyncDiagnostics(JSON.parse(await app.diagnoseCurrentPDFHighlightMatches())); }
        catch (e) { $("syncDiagnostics").textContent = "匹配诊断读取失败：" + e.message; }
      } catch (e) { $("syncStatus").textContent = e.message; }
      finally { $("syncHighlights").disabled = false; }
    });
    $("exportWordbook").addEventListener("click", async () => {
      $("exportWordbook").disabled = true;
      try {
        $("status").textContent = "正在读取 LexiNote 生词本…";
        const result = await app.exportWordbookToFile(window);
        $("status").textContent = `已导出 ${result.entries} 个词条到：\n${result.path}`;
      } catch (e) {
        $("status").textContent = e.message || "导出生词本失败。";
      } finally {
        $("exportWordbook").disabled = false;
      }
    });
    $("syncWordbook").addEventListener("click", async () => {
      $("syncWordbook").disabled = true;
      try {
        $("status").textContent = "正在同步当前词库到坚果云…";
        const filename = await app.savedNutstoreFilename(await app.exportParentItem()) || await app.promptNutstoreFilename(window);
        const result = await app.syncCurrentWordbookToNutstore(filename);
        $("status").textContent = `已同步 ${result.entries} 个词条到坚果云：\n${result.filename}\n${result.url}`;
      } catch (e) { $("status").textContent = e.message || "坚果云同步失败。"; }
      finally { updateNutstoreAvailability(); }
    });
    $("diagnoseSourceSentences").addEventListener("click", async () => {
      $("diagnoseSourceSentences").disabled = true;
      $("sourceSentenceDiagnostics").textContent = "正在读取当前 PDF 的高亮与文本层…";
      try { renderSourceSentenceDiagnostics(JSON.parse(await app.diagnoseSourceSentenceMatches())); }
      catch (e) { $("sourceSentenceDiagnostics").textContent = e.message || "原文句子匹配诊断失败。"; }
      finally { $("diagnoseSourceSentences").disabled = false; }
    });
    const renderSourceSentenceDiagnostics = result => {
      const container = $("sourceSentenceDiagnostics"); container.replaceChildren();
      const summary = document.createElement("p");
      summary.textContent = `原文句子匹配：${result.matched} / ${result.rows.length} 条成功。`;
      const table = document.createElement("table"); table.style.cssText = "width:100%;border-collapse:collapse;font-size:0.9em";
      const header = document.createElement("tr");
      for (const label of ["词条", "高亮 ID", "匹配阶段", "页码", "原文句子"]) { const cell = document.createElement("th"); cell.textContent = label; cell.style.cssText = "text-align:left;border-bottom:1px solid #8888;padding:4px"; header.append(cell); }
      const body = document.createElement("tbody");
      for (const row of result.rows) {
        const tr = document.createElement("tr");
        for (const value of [row.word, row.annotationID || "—", row.statusLabel, row.pageLabel || "—", row.sentence || "—"]) { const cell = document.createElement("td"); cell.textContent = value; cell.style.cssText = "vertical-align:top;border-bottom:1px solid #8884;padding:4px;overflow-wrap:anywhere"; tr.append(cell); }
        body.append(tr);
      }
      table.append(header, body); container.append(summary, table);
    };
    const renderSyncDiagnostics = result => {
      const container = $("syncDiagnostics");
      container.replaceChildren();
      if (result.error) {
        const message = document.createElement("p"); message.textContent = `诊断在“${result.stage}”失败：${result.error}`;
        const stack = document.createElement("pre"); stack.textContent = result.stack || "未提供调用栈。"; stack.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font-size:0.8em";
        container.append(message, stack); return;
      }
      const summary = document.createElement("p");
      summary.textContent = `匹配结果：${result.matched} 条高亮 ↔ ${result.matchedEntries} 个词条。`;
      const table = document.createElement("table"); table.style.cssText = "width:100%;border-collapse:collapse;font-size:0.9em";
      const header = document.createElement("tr");
      for (const label of ["高亮文本", "页码", "高亮 ID", "匹配结果", "对应词条", "手动匹配"]) { const cell = document.createElement("th"); cell.textContent = label; cell.style.cssText = "text-align:left;border-bottom:1px solid #8888;padding:4px"; header.append(cell); }
      const body = document.createElement("tbody");
      for (const row of result.rows) {
        const tr = document.createElement("tr");
        const status = row.method === "annotation" ? "高亮 ID 精确匹配" : row.method === "word" ? "词条文本匹配" : "未匹配";
        for (const value of [row.word, row.pageLabel, row.id, status, row.entryWords?.join("、") || "—"]) { const cell = document.createElement("td"); cell.textContent = value; cell.style.cssText = "vertical-align:top;border-bottom:1px solid #8884;padding:4px;overflow-wrap:anywhere"; tr.append(cell); }
        const action = document.createElement("td"); action.style.cssText = "vertical-align:top;border-bottom:1px solid #8884;padding:4px";
        if (!row.method) {
          const input = document.createElement("input"); input.type = "text"; input.placeholder = "生词本单词"; input.style.width = "100px";
          const button = document.createElement("button"); button.type = "button"; button.textContent = "手动匹配";
          button.addEventListener("click", async () => {
            input.disabled = true; button.disabled = true;
            try {
              if (!await saveConfig()) return;
              $("syncStatus").textContent = "正在写入手动匹配…";
              const outcome = JSON.parse(await app.syncManualHighlightToNotebook(row.id, input.value));
              if (!outcome.matched) throw new Error("未找到该生词条目，请检查输入的查询词或原文词。");
              $("syncStatus").textContent = outcome.updated ? "已手动匹配并更新词条格式。" : "已匹配；词条已经是当前格式。";
              renderSyncDiagnostics(JSON.parse(await app.diagnoseCurrentPDFHighlightMatches()));
            } catch (e) { $("syncStatus").textContent = e.message; input.disabled = false; button.disabled = false; }
          });
          action.append(input, document.createElement("br"), button);
        } else action.textContent = "—";
        tr.append(action);
        body.append(tr);
      }
      table.append(header, body); container.append(summary, table);
      const unmatchedEntries = (result.entryRows || []).filter(row => !row.highlightIDs?.length);
      if (unmatchedEntries.length) {
        const entrySummary = document.createElement("p"); entrySummary.textContent = "未关联高亮的生词词条：";
        const entryTable = document.createElement("table"); entryTable.style.cssText = "width:100%;border-collapse:collapse;font-size:0.9em";
        const entryHeader = document.createElement("tr");
        for (const label of ["词条", "已关联高亮", "手动匹配高亮"]) { const cell = document.createElement("th"); cell.textContent = label; cell.style.cssText = "text-align:left;border-bottom:1px solid #8888;padding:4px"; entryHeader.append(cell); }
        const entryBody = document.createElement("tbody");
        for (const row of unmatchedEntries) {
        const tr = document.createElement("tr");
        for (const value of [row.word, "—"]) { const cell = document.createElement("td"); cell.textContent = value; cell.style.cssText = "vertical-align:top;border-bottom:1px solid #8884;padding:4px;overflow-wrap:anywhere"; tr.append(cell); }
        const action = document.createElement("td"); action.style.cssText = "vertical-align:top;border-bottom:1px solid #8884;padding:4px";
        const input = document.createElement("input"); input.type = "text"; input.placeholder = "高亮文本"; input.style.width = "120px";
        const button = document.createElement("button"); button.type = "button"; button.textContent = "手动匹配";
        button.addEventListener("click", async () => {
          input.disabled = true; button.disabled = true;
          try {
            if (!await saveConfig()) return;
            $("syncStatus").textContent = "正在写入手动匹配…";
            const outcome = JSON.parse(await app.syncManualEntryToHighlight(row.entryRef, input.value));
            $("syncStatus").textContent = outcome.updated ? "已手动匹配并更新词条格式。" : "已匹配；词条已经是当前格式。";
            renderSyncDiagnostics(JSON.parse(await app.diagnoseCurrentPDFHighlightMatches()));
          } catch (e) { $("syncStatus").textContent = e.message; input.disabled = false; button.disabled = false; }
        });
          action.append(input, document.createElement("br"), button); tr.append(action); entryBody.append(tr);
        }
        entryTable.append(entryHeader, entryBody); container.append(entrySummary, entryTable);
      }
    };
    const setFieldVisible = (id, visible) => {
      const field = $(id);
      const controlLabel = id === "useBaiduTrial" ? field.parentElement : null;
      const label = controlLabel ? controlLabel.previousElementSibling : field.previousElementSibling;
      if (label) label.hidden = !visible;
      (controlLabel || field).hidden = !visible;
    };
    const updateMethod = () => { $("body").disabled = $("method").value !== "POST" || $("provider").value !== "generic"; };
    const updateFields = () => {
      const provider = $("provider").value;
      const generic = provider === "generic";
      const baidu = ["baidu", "baidu-general"].includes(provider);
      const trialAvailable = provider === "baidu-general";
      const trial = trialAvailable && $("useBaiduTrial").checked;
      for (const id of ["endpoint", "method", "key", "headers", "body", "meaningPath", "phoneticPath", "examplePath"]) setFieldVisible(id, generic);
      setFieldVisible("useBaiduTrial", trialAvailable);
      for (const id of ["baiduApiKey", "baiduSecretKey"]) setFieldVisible(id, baidu && !trial);
      $("useBaiduTrial").disabled = !trialAvailable;
      if (!trialAvailable) $("useBaiduTrial").checked = false;
      updateMethod();
    };
    $("method").addEventListener("change", updateMethod);
    const updateTrialStatus = () => { if ($("useBaiduTrial").checked) { const status = app.trialStatus(); $("status").textContent = status.configured ? `试用接口：今日剩余 ${status.remaining} / ${status.limit} 次。` : "试用密钥尚未内置，请联系插件发布者。"; } };
    $("provider").addEventListener("change", () => { rememberBaiduCredentials(); previousProvider = $("provider").value; loadBaiduCredentials(); updateFields(); updateTrialStatus(); });
    $("useBaiduTrial").addEventListener("change", () => { updateFields(); updateTrialStatus(); });
    updateFields(); updateTrialStatus();
    const settingControls = [...names, "enabled", "autoHighlight", "openNoteAfterSave", "autoLocateSavedWord", "noteLocateMode", "showNoteLocateStatus", "baiduApiKey", "baiduSecretKey", "useBaiduTrial", "key"];
    for (const id of settingControls) {
      $(id).addEventListener("input", () => { dirty = true; });
      $(id).addEventListener("change", () => { dirty = true; });
    }
    window.addEventListener("close", event => {
      if (!dirty) return;
      event.preventDefault();
      const prompt = Services.prompt;
      const flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING;
      const choice = prompt.confirmEx(window, "未保存的设置", "设置尚未保存。请选择保存或不保存后关闭设置窗口。", flags, "保存", "不保存", null, null, {});
      if (choice === 0) saveConfig(true);
      else { dirty = false; window.close(); }
    });
    $("test").addEventListener("click", async () => {
      const word = $("test-word").value.trim();
      if (!word || word.length > 80 || /\s/.test(word)) { $("status").textContent = "请输入一个测试单词。"; return; }
      $("test").disabled = true; $("status").textContent = "正在测试当前表单配置（不会自动保存）…";
      const owner = {};
      const cancel = () => owner.cancel?.();
      window.addEventListener("unload", cancel, { once: true });
      try {
        const result = await app.lookup(word, read(), $("key").value, owner);
        $("status").textContent = "测试成功\n" + [result.phonetic, result.meaning, result.example].filter(Boolean).join("\n\n");
      } catch (e) { if ($("status")) $("status").textContent = e.message; }
      finally { window.removeEventListener("unload", cancel); if ($("test")) $("test").disabled = false; }
    });
    $("clear").addEventListener("click", () => { app.clearCache(); $("status").textContent = "查询缓存已清空。"; });
  }
};
