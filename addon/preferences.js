var LexiNotePreferences = window.LexiNotePreferences = {
  init() {
    const $ = id => document.getElementById("lexinote-" + id);
    const app = Zotero.LexiNote;
    if (!app || $("settings").dataset.initialized) return;
    $("settings").dataset.initialized = "true";
    const names = ["provider", "endpoint", "method", "headers", "body", "meaningPath", "phoneticPath", "examplePath", "target", "delay", "timeout"];
    for (const name of names) $(name).value = app.config[name];
    $("enabled").checked = app.config.enabled;
    $("baiduApiKey").value = app.config.baiduApiKey || (app.getKey ? app.getKey() : "");
    $("baiduSecretKey").value = app.config.baiduSecretKey || (app.getCredential ? app.getCredential("Baidu Secret Key") : "");
    try { $("key").value = app.getKey(); }
    catch (_) { $("status").textContent = "无法读取凭据存储，请解锁后重新打开设置。"; $("save").disabled = true; }
    const read = () => {
      const config = { enabled: $("enabled").checked };
      for (const name of names) config[name] = ["delay", "timeout"].includes(name) ? Number($(name).value) : $(name).value;
      config.baiduApiKey = $("baiduApiKey").value.trim(); config.baiduSecretKey = $("baiduSecretKey").value.trim();
      return config;
    };
    $("save").addEventListener("click", async () => {
      $("save").disabled = true;
      try { const config = read(); await app.saveConfig(config, config.provider === "baidu" ? $("baiduApiKey").value.trim() : $("key").value); $("status").textContent = "设置已保存，立即生效。"; }
      catch (e) { $("status").textContent = e.message; }
      finally { $("save").disabled = false; }
    });
    const updateMethod = () => { $("body").disabled = $("method").value !== "POST"; };
    $("method").addEventListener("change", updateMethod); updateMethod();
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
