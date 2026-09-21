var LexiNotePreferences = window.LexiNotePreferences = {
  init() {
    const $ = id => document.getElementById("lexinote-" + id);
    const app = Zotero.LexiNote;
    if (!app || $("settings").dataset.initialized) return;
    $("settings").dataset.initialized = "true";
    const names = ["provider", "endpoint", "method", "headers", "body", "meaningPath", "phoneticPath", "examplePath", "target", "delay", "timeout", "highlightColor", "highlightType"];
    for (const name of names) $(name).value = app.config[name];
    $("enabled").checked = app.config.enabled;
    $("autoHighlight").checked = Boolean(app.config.autoHighlight);
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
      const config = { enabled: $("enabled").checked, autoHighlight: $("autoHighlight").checked };
      for (const name of names) config[name] = ["delay", "timeout"].includes(name) ? Number($(name).value) : $(name).value;
      config.baiduApiKey = $("baiduApiKey").value.trim(); config.baiduSecretKey = $("baiduSecretKey").value.trim();
      config.useBaiduTrial = $("useBaiduTrial").checked;
      return config;
    };
    const restoreFeatureDefaults = () => {
      if (!window.confirm("确定恢复功能默认设置吗？接口设置和已保存凭据不会改变。")) return;
      const defaults = typeof LexiNoteCore !== "undefined" ? LexiNoteCore.defaults : {
        enabled: true, autoHighlight: true, highlightColor: "#c0c0c0", highlightType: "highlight", delay: 350, timeout: 12000
      };
      $("enabled").checked = defaults.enabled;
      $("autoHighlight").checked = defaults.autoHighlight;
      $("highlightColor").value = defaults.highlightColor;
      $("highlightType").value = defaults.highlightType;
      $("delay").value = defaults.delay;
      $("timeout").value = defaults.timeout;
      dirty = true;
      $("status").textContent = "已恢复功能默认设置。请点击“保存设置”以应用。";
    };
    $("restoreFeatures").addEventListener("click", restoreFeatureDefaults);
    $("save").addEventListener("click", async () => {
      $("save").disabled = true;
      try { const config = read(); await app.saveConfig(config, ["baidu", "baidu-general"].includes(config.provider) ? $("baiduApiKey").value.trim() : $("key").value); dirty = false; $("status").textContent = "设置已保存，立即生效。"; }
      catch (e) { $("status").textContent = e.message; }
      finally { $("save").disabled = false; }
    });
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
    const settingControls = [...names, "enabled", "autoHighlight", "baiduApiKey", "baiduSecretKey", "useBaiduTrial", "key"];
    for (const id of settingControls) {
      $(id).addEventListener("input", () => { dirty = true; });
      $(id).addEventListener("change", () => { dirty = true; });
    }
    window.addEventListener("beforeunload", event => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "设置尚未保存，确定关闭吗？";
      return event.returnValue;
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
