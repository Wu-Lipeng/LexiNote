/* global Zotero, Services, LexiNoteCore, XMLHttpRequest, DOMParser, Components */
var LexiNoteRuntime = class {
  constructor({ id, rootURI }) {
    this.id = id;
    this.rootURI = rootURI;
    this.pref = "extensions.lexinote.config";
    this.trialUsagePref = "extensions.lexinote.trialUsage";
    this.loginOrigin = "chrome://lexinote";
    this.tag = "LexiNote:生词本";
    this.cache = new Map();
    this.requests = new Set();
    this.popups = new Set();
    this.byReader = new WeakMap();
    this.noteQueue = Promise.resolve();
    this.noteLocatorDocuments = new Map();
    this.alive = true;
    this.handler = event => this.selection(event);
    this.config = this.readConfig();
    this.revision = 0;
  }
  readConfig() {
    try {
      const config = LexiNoteCore.validate(JSON.parse(Zotero.Prefs.get(this.pref, true) || "{}"), true);
      return this.withBaiduCredentials(config);
    }
    catch (_) { return { ...LexiNoteCore.defaults }; }
  }
  async start() {
    if (!Zotero.Reader?.registerEventListener) throw new Error("LexiNote 需要 Zotero 7 或更新版本。");
    await Zotero.PreferencePanes.register({
      id: "lexinote-preferences", pluginID: this.id, label: "划词生词本",
      src: this.rootURI + "preferences.xhtml",
      scripts: [this.rootURI + "preferences.js"]
    });
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", this.handler, this.id);
    this.updateNoteLocatorScanning();
  }
  getKey() {
    return this.getCredential("Generic API Key") || this.getCredential("API key");
  }
  getCredential(name) {
    try {
      if (typeof Services === "undefined") return "";
      return Services.logins.findLogins(this.loginOrigin, null, name)[0]?.password || "";
    } catch (_) { return ""; }
  }
  baiduCredentialNames(provider) {
    return provider === "baidu-general"
      ? { apiKey: "Baidu General API Key", secretKey: "Baidu General Secret Key" }
      : { apiKey: "Baidu Dictionary API Key", secretKey: "Baidu Dictionary Secret Key" };
  }
  baiduCredentials(config) {
    const names = this.baiduCredentialNames(config.provider);
    return {
      apiKey: config.baiduApiKey?.trim() || this.getCredential(names.apiKey) || this.getCredential("Baidu API Key") || this.getCredential("API key"),
      secretKey: config.baiduSecretKey?.trim() || this.getCredential(names.secretKey) || this.getCredential("Baidu Secret Key")
    };
  }
  withBaiduCredentials(config) {
    if (!["baidu", "baidu-general"].includes(config.provider) || config.useBaiduTrial) return config;
    const credentials = this.baiduCredentials(config);
    return { ...config, baiduApiKey: credentials.apiKey, baiduSecretKey: credentials.secretKey };
  }
  async setKey(key) {
    return this.setCredential("Generic API Key", key);
  }
  async setCredential(name, key) {
    const existing = Services.logins.findLogins(this.loginOrigin, null, name);
    if (!key) { for (const login of existing) Services.logins.removeLogin(login); return; }
    const login = Components.classes["@mozilla.org/login-manager/loginInfo;1"].createInstance(Components.interfaces.nsILoginInfo);
    login.init(this.loginOrigin, null, name, name, key, "", "");
    if (existing.length) Services.logins.modifyLogin(existing[0], login);
    else if (Services.logins.addLoginAsync) await Services.logins.addLoginAsync(login);
    else Services.logins.addLogin(login);
  }
  async saveConfig(input, key) {
    const config = LexiNoteCore.validate(input, !input.enabled);
    // Keep newly entered Baidu credentials available for this running Zotero
    // session. The separately persisted preference below deliberately omits
    // them, while the login manager remains the durable credential store.
    const runtimeConfig = { ...config };
    const baidu = ["baidu", "baidu-general"].includes(config.provider);
    if (baidu && !config.useBaiduTrial) {
      const names = this.baiduCredentialNames(config.provider);
      await this.setCredential(names.apiKey, input.baiduApiKey || "");
      await this.setCredential(names.secretKey, input.baiduSecretKey || "");
    } else if (!baidu) {
      await this.setKey(key);
    }
    // Credentials belong exclusively in Zotero's login manager, never in the
    // JSON preference that stores the rest of the add-on configuration.
    config.baiduApiKey = "";
    config.baiduSecretKey = "";
    Zotero.Prefs.set(this.pref, JSON.stringify(config), true);
    this.config = runtimeConfig;
    this.revision++;
    this.updateNoteLocatorScanning();
    this.clearCache();
    for (const popup of [...this.popups]) popup.dispose();
  }
  clearCache() {
    this.cache.clear();
    for (const req of [...this.requests]) req.cancel();
  }
  readerFrame(reader) {
    try {
      let frame = reader?._iframeWindow;
      if (frame && typeof Components !== "undefined") frame = Components.utils.waiveXrays(frame);
      return frame || null;
    } catch (_) {}
    return null;
  }
  readerInternal(reader) {
    // Zotero exposes a light wrapper to plugins. The live reader lives in the
    // PDF iframe; use it first so that addAnnotation also updates the canvas.
    const frame = this.readerFrame(reader);
    if (frame?._reader?._annotationManager) return frame._reader;
    return reader?._internalReader || null;
  }
  captureHighlightDraft(reader, params, word, pageLabel) {
    try {
      const internal = this.readerInternal(reader);
      const view = internal?._lastView || internal?._primaryView;
      const ranges = view?._selectionRanges;
      if (view && ranges?.length && typeof view._getAnnotationFromSelectionRanges === "function") {
        // Selection ranges are owned by the reader iframe and vanish once the
        // popup is focused. Convert to plain data while the selection is live.
        const draft = view._getAnnotationFromSelectionRanges(ranges, this.config.highlightType, this.config.highlightColor);
        if (draft?.position?.rects?.length && draft.sortIndex) return JSON.parse(JSON.stringify(draft));
      }
    } catch (_) {}
    const annotation = params?.annotation;
    if (annotation?.position?.rects?.length && annotation.sortIndex) {
      return JSON.parse(JSON.stringify({
        ...annotation,
        type: this.config.highlightType,
        color: this.config.highlightColor,
        text: annotation.text || word,
        pageLabel: annotation.pageLabel || pageLabel
      }));
    }
    return null;
  }
  autoMark(reader, draft) {
    if (!this.config.autoHighlight) return { marked: false, reason: "disabled" };
    if (!draft?.position?.rects?.length || !draft.sortIndex) return { marked: false, reason: "未取得选中文本的标注位置。" };
    try {
      const manager = this.readerInternal(reader)?._annotationManager;
      if (!manager?.addAnnotation) return { marked: false, reason: "未连接到 Zotero 标注阅读器。" };
      const data = { ...draft, type: this.config.highlightType, color: this.config.highlightColor };
      // addAnnotation reads a content-window object. Passing a chrome-window
      // object through Xray wrappers loses dictionary properties such as color.
      const frame = this.readerFrame(reader);
      const annotation = frame?.JSON?.parse ? frame.JSON.parse(JSON.stringify(data)) : data;
      const created = manager.addAnnotation(annotation);
      return { marked: Boolean(created || annotation.id), annotationID: created?.id || annotation.id || "" };
    } catch (error) {
      return { marked: false, reason: error?.message || "Zotero 拒绝创建标注。" };
    }
  }
  existingMark(reader, draft) {
    if (!draft?.position?.rects?.length) return null;
    try {
      const annotations = this.readerInternal(reader)?._annotationManager?._annotations || [];
      const covers = (outer, inner) => outer[0] <= inner[0] + 0.5 && outer[1] <= inner[1] + 0.5
        && outer[2] >= inner[2] - 0.5 && outer[3] >= inner[3] - 0.5;
      return annotations.find(annotation => {
        if (!annotation?.id || annotation.type !== this.config.highlightType) return false;
        const position = annotation.position;
        if (position?.pageIndex !== draft.position.pageIndex || !position.rects?.length) return false;
        // A manual mark may cover a phrase. It is still the intended mark when
        // every rectangle of this word selection is inside that annotation.
        return draft.position.rects.every(selected => position.rects.some(marked => covers(marked, selected)));
      }) || null;
    } catch (_) { return null; }
  }
  markForNewEntry(reader, draft) {
    const existing = this.existingMark(reader, draft);
    if (existing) return { marked: true, existing: true, annotationID: existing.id };
    return { ...this.autoMark(reader, draft), existing: false };
  }
  trialCredentials() {
    const source = typeof LexiNoteTrialCredentials === "object" ? LexiNoteTrialCredentials : {};
    return { apiKey: String(source.baiduApiKey || "").trim(), secretKey: String(source.baiduSecretKey || "").trim() };
  }
  trialDate(now = new Date()) {
    return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  }
  trialStatus() {
    let usage = {};
    try { usage = JSON.parse(Zotero.Prefs.get(this.trialUsagePref, true) || "{}"); } catch (_) {}
    const count = usage.date === this.trialDate() ? Math.max(0, Number(usage.count) || 0) : 0;
    return { configured: Boolean(this.trialCredentials().apiKey && this.trialCredentials().secretKey), used: count, limit: 50, remaining: Math.max(0, 50 - count) };
  }
  consumeTrialQuota() {
    const status = this.trialStatus();
    if (!status.configured) throw new Error("试用密钥尚未内置，请联系插件发布者。");
    if (status.remaining < 1) throw new Error("今日试用额度已用完（50/50），请明天再试或填写自己的百度密钥。");
    Zotero.Prefs.set(this.trialUsagePref, JSON.stringify({ date: this.trialDate(), count: status.used + 1 }), true);
    return { ...status, used: status.used + 1, remaining: status.remaining - 1 };
  }
  isConfigured(config = this.config) {
    if (["baidu", "baidu-general"].includes(config.provider)) {
      if (config.useBaiduTrial) return this.trialStatus().configured;
      const credentials = this.baiduCredentials(config);
      return Boolean(credentials.apiKey && credentials.secretKey);
    }
    return Boolean(config.endpoint?.trim());
  }
  async lookup(word, input = this.config, keyOverride, owner = {}) {
    if (!this.alive) throw new Error("插件已停用。");
    const config = LexiNoteCore.validate(input);
    if (["baidu", "baidu-general"].includes(config.provider)) return this.lookupBaidu(word, config, owner);
    const cacheable = input === this.config && keyOverride === undefined;
    const cacheKey = word; // Keep case: US and us can have different definitions.
    const cached = cacheable && this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < 15 * 60 * 1000) {
      this.cache.delete(cacheKey); this.cache.set(cacheKey, cached);
      return cached.value;
    }
    if (this.requests.size >= 3) throw new Error("正在查询其他单词，请稍后重试。");
    const key = keyOverride === undefined ? this.getKey() : keyOverride;
    const request = LexiNoteCore.request(config, word, key);
    const revision = this.revision;
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest({ mozAnon: true });
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        this.requests.delete(entry);
        if (owner.cancel === entry.cancel) owner.cancel = null;
        xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = xhr.onprogress = null;
        error ? reject(error) : resolve(value);
      };
      const entry = { cancel: () => { finish(new Error("查询已取消。")); xhr.abort(); } };
      owner.cancel = entry.cancel;
      this.requests.add(entry);
      try {
        xhr.open(request.method, request.url, true);
        xhr.timeout = config.timeout;
        for (const [header, value] of Object.entries(request.headers)) xhr.setRequestHeader(header, value);
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) {
            finish(new Error(xhr.status === 401 || xhr.status === 403 ? "接口拒绝访问，请检查密钥及权限。" : xhr.status === 429 ? "接口请求过于频繁，请稍后重试。" : "接口返回 HTTP " + xhr.status + "。"));
            return;
          }
          if (xhr.responseText.length > 1024 * 1024) { finish(new Error("接口响应超过 1 MB。")); return; }
          try { finish(null, JSON.parse(xhr.responseText)); }
          catch (_) { finish(new Error("接口返回的不是有效 JSON。")); }
        };
        xhr.onerror = () => finish(new Error("无法连接接口，请检查网络和接口地址。"));
        xhr.ontimeout = () => finish(new Error("查询超时，请稍后重试。"));
        xhr.onabort = () => finish(new Error("查询已取消。"));
        xhr.onprogress = event => {
          if (event.loaded > 1024 * 1024) { finish(new Error("接口响应超过 1 MB。")); xhr.abort(); }
        };
        xhr.send(request.body);
      } catch (_) { finish(new Error("无法发送请求，请检查接口地址和请求头。")); }
    });
    const result = LexiNoteCore.response(data, config);
    if (cacheable && this.alive && revision === this.revision) {
      this.cache.set(cacheKey, { time: Date.now(), value: result });
      while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    }
    return result;
  }
  async lookupCandidates(word, input = this.config, owner = {}) {
    const matches = [], errors = [];
    for (const candidate of LexiNoteCore.wordCandidates(word)) {
      try { matches.push({ word: candidate, result: await this.lookup(candidate, input, undefined, owner) }); }
      catch (error) { errors.push(error); }
    }
    if (matches.length) return matches;
    const messages = errors.map(error => error?.message || "").filter(Boolean);
    if (messages.length && messages.every(text => /没有返回结果|没有找到释义/.test(text))) throw new Error("未找到可用释义。");
    throw errors[0] || new Error("未找到可用释义。");
  }
  async lookupBaidu(word, config, owner = {}) {
    const trial = config.useBaiduTrial;
    const trialCredentials = this.trialCredentials();
    const credentials = this.baiduCredentials(config);
    const apiKey = trial ? trialCredentials.apiKey : credentials.apiKey;
    const secretKey = trial ? trialCredentials.secretKey : credentials.secretKey;
    if (!apiKey || !secretKey) throw new Error("请在设置中填写百度 API Key 和 Secret Key。");
    if (trial) this.consumeTrialQuota();
    const tokenKey = "__lexinote_baidu_token:" + config.provider + ":" + (trial ? "trial" : "user");
    let token = this.cache.get(tokenKey)?.value;
    if (!token || Date.now() >= token.expiresAt - 3600000) {
      const tokenURL = "https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id="
        + encodeURIComponent(apiKey) + "&client_secret=" + encodeURIComponent(secretKey);
      const tokenXHR = await Zotero.HTTP.request("POST", tokenURL, { body: "", headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: config.timeout, cancellerReceiver: cancel => { owner.cancel = cancel; } });
      let tokenData; try { tokenData = JSON.parse(tokenXHR.responseText); } catch (_) { throw new Error("百度 Token 响应不是有效 JSON。"); }
      if (!tokenData.access_token) throw new Error(tokenData.error_description || "百度 access_token 获取失败。");
      token = { value: tokenData.access_token, expiresAt: Date.now() + Math.max(60000, Number(tokenData.expires_in || 2592000) * 1000) };
      this.cache.set(tokenKey, { time: Date.now(), value: token });
    }
    const endpoint = config.provider === "baidu-general" ? "https://aip.baidubce.com/rpc/2.0/mt/texttrans/v1" : "https://aip.baidubce.com/rpc/2.0/mt/texttrans-with-dict/v1";
    const response = await Zotero.HTTP.request("POST", endpoint + "?access_token=" + encodeURIComponent(token.value), {
      body: JSON.stringify({ from: "en", to: config.target === "zh-CN" ? "zh" : config.target, q: word.trim() }),
      headers: { "Content-Type": "application/json" }, timeout: config.timeout,
      cancellerReceiver: cancel => { owner.cancel = cancel; }
    });
    let data; try { data = JSON.parse(response.responseText); } catch (_) { throw new Error("百度词典响应不是有效 JSON。"); }
    const row = (config.provider === "baidu-general"
      ? (data?.result?.trans_result?.[0] || data?.trans_result?.[0])
      : data?.result?.trans_result?.[0]);
    if (!row) throw new Error(data?.error_msg || "百度词典没有返回结果。");
    if (config.provider === "baidu-general") return { meaning: String(row.dst || "暂无翻译结果"), phonetic: "", example: "" };
    let dictionary = {};
    if (row.dict) { try { dictionary = JSON.parse(row.dict); } catch (_) {} }
    const wr = dictionary.word_result || {};
    const lines = [], seen = new Set();
    const symbols = Array.isArray(wr.simple_means?.symbols) ? wr.simple_means.symbols : [];
    const phonetic = symbols.find(s => s.ph_en)?.ph_en;
    if (phonetic) lines.push("/" + phonetic + "/");
    for (const symbol of symbols) for (const part of (symbol.parts || [])) {
      const pos = String(part.part || "").trim(); const means = (part.means || []).map(String).map(x => x.trim()).filter(Boolean);
      if (pos && means.length && !seen.has(pos)) { seen.add(pos); lines.push(pos + " " + means.join("；")); }
    }
    for (const item of (wr.edict?.item || [])) {
      const pos = String(item.pos || "").trim(); const defs = (item.tr_group || []).flatMap(g => g.tr || []).map(String).filter(Boolean);
      if (pos && defs.length && !seen.has(pos)) { seen.add(pos); lines.push(pos + " " + defs.slice(0, 4).join("；")); }
    }
    const examples = (wr.edict?.item || []).flatMap(item => (item.tr_group || []).flatMap(g => g.example || [])).map(String).map(x => x.trim()).filter(Boolean).slice(0, 2);
    if (examples.length) lines.push("\n例句\n" + examples.map(x => "    " + x).join("\n"));
    return { meaning: (lines.join("\n").trim() || row.dst || "暂无翻译结果"), phonetic: "", example: "" };
  }
  selection({ reader, doc, params, append }) {
    // Reader events expose waived-Xray DOM objects. Restore Xrays so WebIDL
    // dictionaries (MutationObserver/addEventListener options) cross scopes correctly.
    if (typeof Components !== "undefined") doc = Components.utils.unwaiveXrays(doc);
    this.byReader.get(reader)?.dispose();
    if (!this.alive || !this.config.enabled) return;
    const word = LexiNoteCore.wordFrom(params?.annotation?.text);
    if (!word) return;
    const attachmentID = reader.itemID;
    this.revealSavedWord(attachmentID, word).catch(() => {});
    // Capture the originating attachment/page before any network operation.
    const pageLabel = String(params.annotation.pageLabel || "");
    const pageIndex = params.annotation.position?.pageIndex;
    const make = (tag, text) => {
      const element = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      if (text) element.textContent = text;
      return element;
    };
    const box = make("div");
    box.className = "lexinote-popup";
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "划词释义");
    box.style.cssText = "box-sizing:border-box;display:block!important;position:fixed!important;width:560px!important;max-width:calc(100vw - 24px)!important;min-width:320px!important;max-height:72vh;padding:16px;border:1px solid #8886;border-radius:8px;background:Canvas;color:CanvasText;box-shadow:0 4px 18px #0004;font:14px/1.6 system-ui;white-space:normal;overflow:auto;overflow-wrap:anywhere;z-index:2147483647;";
    const heading = make("strong", word);
    heading.style.cssText = "font-size:17px;display:block;overflow-wrap:anywhere;";
    const detail = make("div", "正在查词…");
    detail.setAttribute("aria-live", "polite");
    detail.style.cssText = "display:block;box-sizing:border-box;width:100%;min-width:0;white-space:pre-wrap;max-height:360px;overflow:auto;overflow-wrap:anywhere;word-break:break-word;margin:10px 0;user-select:text;";
    const actions = make("div");
    actions.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
    const button = label => {
      const b = make("button", label); b.type = "button";
      b.style.cssText = "font:inherit;border:1px solid #8888;border-radius:5px;padding:4px 9px;cursor:pointer;color:inherit;background:transparent;";
      return b;
    };
    const retry = button("重试"); retry.hidden = true;
    const close = button("关闭");
    const status = make("div"); status.setAttribute("aria-live", "polite");
    status.style.cssText = "font-size:12px;margin-top:6px;";
    const queryForm = make("div");
    queryForm.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:10px;";
    const queryInput = make("input");
    queryInput.type = "text";
    queryInput.value = word;
    queryInput.maxLength = 80;
    queryInput.setAttribute("aria-label", "查询单词");
    queryInput.style.cssText = "box-sizing:border-box;flex:1;min-width:0;padding:5px 7px;border:1px solid #8888;border-radius:5px;background:Canvas;color:CanvasText;font:inherit;";
    const queryButton = button("查询");
    queryForm.append(queryInput, queryButton);
    actions.append(retry, close);
    box.append(heading, detail, actions, status, queryForm);
    let timer, observer, disposed = false, resultGroups = [], highlightDraft, retryWord = word;
    const owners = new Set();
    const popup = {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer); for (const owner of owners) owner.cancel?.(); observer?.disconnect();
        doc.defaultView?.removeEventListener("unload", popup.dispose);
        box.remove(); this.popups.delete(popup);
        if (this.byReader.get(reader) === popup) this.byReader.delete(reader);
      }
    };
    close.addEventListener("click", () => popup.dispose());
    // Keep reader shortcuts from intercepting interaction inside the popup.
    for (const name of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup"]) {
      box.addEventListener(name, event => event.stopPropagation());
    }
    box.addEventListener("keydown", event => { if (event.key === "Escape") popup.dispose(); });
    const formatResult = entry => [entry.result.phonetic, entry.result.meaning, entry.result.example && "例句\n" + entry.result.example].filter(Boolean).join("\n\n");
    const saveMatch = async (entry, saveButton) => {
      if (saveButton.disabled) return;
      saveButton.disabled = true; status.textContent = "正在保存…";
      try {
        const saved = await this.saveWord({ attachmentID, word: entry.word, originalWord: word, result: entry.result, pageLabel, pageIndex });
        let marking = null;
        // Persist the highlighter identifier before opening the note. Opening
        // first can leave the note iframe on an older revision without the
        // annotation URL parameter used for exact navigation.
        if (!saved.duplicate) {
          marking = this.markForNewEntry(reader, highlightDraft);
          if (marking.annotationID) await this.saveAnnotationID(saved.noteID, entry.word, word, marking.annotationID, attachmentID);
          await this.openNotebookAtEnd(saved.noteID);
        } else {
          // Re-saving an existing word is allowed to repair a missing
          // association, but must never create a second PDF annotation.
          const existing = this.existingMark(reader, highlightDraft);
          if (existing?.id && !await this.savedAnnotationID(saved.noteID, entry.word, word)) {
            await this.saveAnnotationID(saved.noteID, entry.word, word, existing.id, attachmentID);
            marking = { marked: true, existing: true, annotationID: existing.id };
          }
        }
        if (!disposed) {
          status.textContent = saved.duplicate
            ? (saved.formatUpdated ? "该词已在这篇文献的生词本中，已更新为当前格式。" : "该词已在这篇文献的生词本中。")
            : "已追加到这篇文献的生词本。";
          if (!saved.duplicate) {
            if (marking.marked) status.textContent += marking.existing ? " 已关联已有标记。" : " 已自动标记选中文本。";
            else if (this.config.autoHighlight && marking.reason !== "disabled") status.textContent += " 自动标记未完成：" + marking.reason;
            if (marking.annotationID) status.textContent += " 高亮关联已保存。";
          } else if (marking?.existing) {
            status.textContent += " 已关联已有标记并补全高亮 ID。";
          }
          saveButton.textContent = "已保存";
        }
      } catch (error) {
        if (!disposed) { status.textContent = error.message; saveButton.disabled = false; }
      }
    };
    const renderMatches = () => {
      detail.replaceChildren();
      for (const group of resultGroups) {
        const groupElement = make("div");
        groupElement.style.cssText = "padding:8px 0;border-top:1px solid #8884;";
        if (!group.initial || resultGroups.length > 1) {
          const groupTitle = make("strong", group.word);
          groupTitle.style.cssText = "display:block;margin-bottom:4px;";
          groupElement.append(groupTitle);
        }
        for (const entry of group.entries) {
          const section = make("div");
          section.style.cssText = "padding:4px 0;";
          if (group.entries.length > 1) {
            const title = make("strong", entry.word);
            title.style.cssText = "display:block;margin-bottom:4px;";
            section.append(title);
          }
          section.append(make("div", formatResult(entry)));
          const saveButton = button("保存 " + entry.word);
          saveButton.style.marginTop = "8px";
          saveButton.addEventListener("click", () => saveMatch(entry, saveButton));
          section.append(saveButton);
          groupElement.append(section);
        }
        detail.append(groupElement);
      }
    };
    const run = async (queryWord, initial = false) => {
      if (disposed || !box.isConnected) { popup.dispose(); return; }
      const owner = {};
      owners.add(owner);
      retry.hidden = true; queryButton.disabled = true; status.textContent = "正在查词…";
      if (!resultGroups.length) detail.textContent = "正在查词…";
      try {
        const entries = await this.lookupCandidates(queryWord, this.config, owner);
        if (disposed) return;
        resultGroups.push({ word: queryWord, entries, initial });
        renderMatches();
        queryInput.value = queryWord;
        status.textContent = "";
      } catch (error) {
        if (!disposed) {
          if (!resultGroups.length) detail.textContent = error.message;
          else status.textContent = error.message;
          retryWord = queryWord; retry.hidden = false;
        }
      } finally {
        owners.delete(owner);
        if (!disposed) queryButton.disabled = false;
      }
    };
    const submitQuery = () => {
      const queryWord = LexiNoteCore.wordFrom(queryInput.value);
      if (!queryWord) { status.textContent = "请输入一个单词。"; return; }
      run(queryWord);
    };
    retry.addEventListener("click", () => run(retryWord));
    queryButton.addEventListener("click", submitQuery);
    queryInput.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); submitQuery(); }
    });
    this.popups.add(popup); this.byReader.set(reader, popup);
    doc.defaultView.addEventListener("unload", popup.dispose, { once: true });
    // The reader's native selection popup constrains children to a narrow column.
    // Mount the panel in the document body and anchor it to the current selection
    // so the panel can use its own width without being clipped by that popup.
    const selectionRect = (() => {
      try {
        const selection = doc.getSelection?.();
        return selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
      } catch (_) { return null; }
    })();
    const viewport = doc.defaultView;
    if (selectionRect && viewport) {
      const panelWidth = Math.min(560, Math.max(320, viewport.innerWidth - 24));
      const left = Math.max(12, Math.min(selectionRect.left, viewport.innerWidth - panelWidth - 12));
      const estimatedHeight = Math.min(520, Math.max(220, viewport.innerHeight * 0.55));
      const top = selectionRect.bottom + 12 + estimatedHeight <= viewport.innerHeight
        ? selectionRect.bottom + 12
        : Math.max(12, selectionRect.top - estimatedHeight - 12);
      box.style.left = left + "px";
      box.style.top = top + "px";
    } else {
      box.style.left = "12px";
      box.style.top = "12px";
    }
    highlightDraft = this.captureHighlightDraft(reader, params, word, pageLabel);
    // Capture the selection before mounting the popup, since mounting it can
    // cause the reader to clear its native text selection.
    (doc.body || doc.documentElement).append(box);
    timer = setTimeout(() => {
      if (!box.isConnected) { popup.dispose(); return; }
      observer = new doc.defaultView.MutationObserver(() => { if (!box.isConnected) popup.dispose(); });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      run(word, true);
    }, this.config.delay);
  }
  saveWord(entry) {
    // Serialize saves across all readers: first-save races cannot create two notes.
    const pending = this.noteQueue.then(() => this.writeWord(entry));
    this.noteQueue = pending.catch(() => {});
    return pending;
  }
  matchesSavedWord(heading, normalizedWord) {
    return heading.dataset.lexinoteWord === normalizedWord
      || heading.dataset.lexinoteOriginalWord === normalizedWord
      || LexiNoteCore.normalize(heading.textContent.trim()) === normalizedWord;
  }
  annotationIDForHeading(heading) {
    if (heading.dataset.lexinoteAnnotationId) return heading.dataset.lexinoteAnnotationId;
    try {
      const source = this.entrySourceLine(heading)?.querySelector?.('a[href^="zotero://open-pdf/"]');
      return new URL(source?.href || "").searchParams.get("annotation") || "";
    } catch (_) { return ""; }
  }
  headingMatchData(heading) {
    const word = String(heading.textContent || "").trim();
    return {
      word,
      normalizedWord: heading.dataset.lexinoteWord || LexiNoteCore.normalize(word),
      normalizedOriginalWord: heading.dataset.lexinoteOriginalWord || "",
      annotationID: this.annotationIDForHeading(heading)
    };
  }
  highlightMatchMethod(entryAnnotationID, entryNormalizedWord, entryNormalizedOriginalWord, highlightID, highlightNormalizedWord) {
    if (entryAnnotationID && entryAnnotationID === highlightID) return "annotation";
    return entryNormalizedWord === highlightNormalizedWord || entryNormalizedOriginalWord === highlightNormalizedWord ? "word" : "";
  }
  entrySourceLine(heading) {
    for (let element = heading.nextElementSibling; element && element.tagName !== "H3"; element = element.nextElementSibling) {
      if (element.querySelector?.('a[href^="zotero://open-pdf/"]')) return element;
    }
    return null;
  }
  sourceLinkText(link) {
    try {
      const page = new URL(link.href).searchParams.get("page");
      return page && /^\d+$/.test(page) ? "第 " + page + " 页" : "查看位置";
    } catch (_) { return "查看位置"; }
  }
  createSourceLink(document, attachment, pageLabel, pageIndex) {
    const link = document.createElement("a");
    const library = Zotero.Libraries.get(attachment.libraryID);
    const libraryPath = library.libraryType === "group" ? "groups/" + library.groupID : "library";
    link.href = "zotero://open-pdf/" + libraryPath + "/items/" + attachment.key
      + (Number.isInteger(pageIndex) ? "?page=" + (pageIndex + 1) : "");
    link.textContent = pageLabel ? "第 " + pageLabel + " 页" : "查看位置";
    return link;
  }
  updateSavedWordFormat(document, root, heading, originalWord, attachment, pageLabel, pageIndex, annotationID = "", replaceOriginalWord = false) {
    const before = document.body.innerHTML;
    let sourceLine = this.entrySourceLine(heading);
    const savedOriginalWord = sourceLine?.textContent.match(/^原文词：(.+?) · /)?.[1];
    const storedOriginalWord = replaceOriginalWord ? originalWord : (savedOriginalWord || originalWord);
    const normalizedOriginalWord = LexiNoteCore.normalize(storedOriginalWord);
    heading.dataset.lexinoteWord = LexiNoteCore.normalize(heading.textContent.trim());
    heading.dataset.lexinoteOriginalWord = normalizedOriginalWord;
    const existingAnnotationID = (() => {
      try { return new URL(sourceLine?.querySelector?.('a[href^="zotero://open-pdf/"]')?.href || "").searchParams.get("annotation") || heading.dataset.lexinoteAnnotationId || ""; }
      catch (_) { return heading.dataset.lexinoteAnnotationId || ""; }
    })();
    const effectiveAnnotationID = annotationID || existingAnnotationID;
    if (effectiveAnnotationID) {
      heading.dataset.lexinoteAnnotationId = effectiveAnnotationID;
      heading.dataset.lexinoteAttachmentId = String(attachment.id);
    }
    if (!sourceLine) {
      sourceLine = document.createElement("p");
      let nextHeading = heading.nextElementSibling;
      while (nextHeading && nextHeading.tagName !== "H3") nextHeading = nextHeading.nextElementSibling;
      root.insertBefore(sourceLine, nextHeading);
    }
    const previousLink = sourceLine.querySelector?.('a[href^="zotero://open-pdf/"]');
    const suffix = [];
    for (let node = previousLink?.nextSibling; node; node = node.nextSibling) suffix.push(node);
    const link = this.createSourceLink(document, attachment, pageLabel, pageIndex);
    if (effectiveAnnotationID) {
      const url = new URL(link.href); url.searchParams.set("annotation", effectiveAnnotationID); link.href = url.href;
    }
    sourceLine.replaceChildren(document.createTextNode("原文词：" + storedOriginalWord + " · "), link, ...suffix);
    return document.body.innerHTML !== before;
  }
  currentPDFReader() {
    try {
      const main = Zotero.getMainWindow?.();
      const tabID = main?.Zotero_Tabs?.selectedID;
      const direct = tabID && Zotero.Reader.getByTabID?.(tabID);
      if (direct?.itemID) return direct;
      const readers = Zotero.Reader._readers;
      const values = readers instanceof Map ? [...readers.values()] : Object.values(readers || {});
      return values.find(reader => reader?.itemID) || null;
    } catch (_) { return null; }
  }
  currentFormatHighlights(reader) {
    try {
      const annotations = this.readerInternal(reader)?._annotationManager?._annotations;
      const values = annotations instanceof Map ? [...annotations.values()] : (Array.isArray(annotations) ? annotations : Object.values(annotations || {}));
      const expectedColor = String(this.config.highlightColor || "").toLowerCase();
      const seen = new Set();
      return values.flatMap(annotation => {
        const word = LexiNoteCore.wordFrom(annotation?.text);
        const pageIndex = annotation?.position?.pageIndex;
        if (!annotation?.id || annotation.type !== this.config.highlightType || String(annotation.color || "").toLowerCase() !== expectedColor
          || !word || !Number.isInteger(pageIndex) || seen.has(annotation.id)) return [];
        seen.add(annotation.id);
        return [{ id: annotation.id, word, normalizedWord: LexiNoteCore.normalize(word), pageIndex, pageLabel: String(annotation.pageLabel || pageIndex + 1) }];
      });
    } catch (_) { return []; }
  }
  async syncCurrentPDFHighlightsToNotebook() {
    const reader = this.currentPDFReader();
    if (!reader?.itemID) throw new Error("请先在 Zotero 主窗口中打开并选中一个 PDF。" );
    const highlights = this.currentFormatHighlights(reader);
    if (!highlights.length) return { scanned: 0, matched: 0, updated: 0 };
    const attachment = await Zotero.Items.getAsync(reader.itemID);
    if (!attachment?.parentID) throw new Error("当前 PDF 没有可用的父文献，无法查找生词本。" );
    const parent = await Zotero.Items.getAsync(attachment.parentID);
    if (!parent || parent.deleted) throw new Error("找不到当前 PDF 所属的文献。" );
    const notes = await Zotero.Items.getAsync(parent.getNotes());
    const parser = new DOMParser();
    let matched = 0, updated = 0;
    for (const note of notes) {
      if (note.deleted || !note.hasTag(this.tag)) continue;
      if (!note.isEditable?.()) throw new Error("生词本笔记不可编辑，无法更新格式。" );
      const document = parser.parseFromString(note.getNote(), "text/html");
      const root = document.body.querySelector("div[data-schema-version]") || document.body;
      const before = document.body.innerHTML;
      for (const highlight of highlights) {
        if (!highlight.normalizedWord) continue;
        const heading = [...root.querySelectorAll("h3")].find(item => {
          const entry = this.headingMatchData(item);
          return this.highlightMatchMethod(entry.annotationID, entry.normalizedWord, entry.normalizedOriginalWord, highlight.id, highlight.normalizedWord);
        });
        if (!heading) continue;
        matched++;
        this.updateSavedWordFormat(document, root, heading, highlight.word, attachment, highlight.pageLabel, highlight.pageIndex, highlight.id, true);
      }
      if (document.body.innerHTML !== before) {
        note.setNote(document.body.innerHTML);
        await note.saveTx();
        updated++;
      }
    }
    return { scanned: highlights.length, matched, updated };
  }
  async diagnoseCurrentPDFHighlightMatches() {
    let stage = "读取当前 PDF";
    try {
      const reader = this.currentPDFReader();
      if (!reader?.itemID) throw new Error("请先在 Zotero 主窗口中打开并选中一个 PDF。");
      stage = "读取符合条件的高亮";
      const highlights = this.currentFormatHighlights(reader);
      stage = "读取当前 PDF 附件";
      const attachment = await Zotero.Items.getAsync(reader.itemID);
      if (!attachment?.parentID) throw new Error("当前 PDF 没有可用的父文献，无法查找生词本。");
      stage = "读取父文献";
      const parent = await Zotero.Items.getAsync(attachment.parentID);
      if (!parent || parent.deleted) throw new Error("找不到当前 PDF 所属的文献。");
      stage = "读取生词本笔记";
      const notes = await Zotero.Items.getAsync(parent.getNotes());
      const parser = new DOMParser();
      const entries = [];
      for (const note of notes) {
        if (note.deleted || !note.hasTag(this.tag)) continue;
        stage = "解析生词本词条";
        const document = parser.parseFromString(note.getNote(), "text/html");
        const root = document.body.querySelector("div[data-schema-version]") || document.body;
        for (const heading of root.querySelectorAll("h3")) {
          entries.push({ ...this.headingMatchData(heading), noteID: note.id });
        }
      }
      stage = "匹配高亮与词条";
      const rows = highlights.map(highlight => {
        const entry = entries.find(item => this.highlightMatchMethod(item.annotationID, item.normalizedWord, item.normalizedOriginalWord, highlight.id, highlight.normalizedWord));
        return {
          id: highlight.id,
          word: highlight.word,
          pageLabel: highlight.pageLabel,
          method: entry ? this.highlightMatchMethod(entry.annotationID, entry.normalizedWord, entry.normalizedOriginalWord, highlight.id, highlight.normalizedWord) : "",
          entryWord: entry?.word || "",
          entryAnnotationID: entry?.annotationID || ""
        };
      });
      // Preferences runs in a less-privileged document. Return serialized data
      // so Gecko never needs to marshal an array across the privilege boundary.
      return JSON.stringify({ scanned: highlights.length, entries: entries.length, matched: rows.filter(row => row.method).length, rows });
    } catch (error) {
      return JSON.stringify({ error: String(error?.message || error), stage, stack: String(error?.stack || "") });
    }
  }
  async findSavedWord(attachmentID, word) {
    const attachment = await Zotero.Items.getAsync(attachmentID);
    if (!attachment?.parentID) return null;
    const parent = await Zotero.Items.getAsync(attachment.parentID);
    if (!parent || parent.deleted) return null;
    const normalizedWord = LexiNoteCore.normalize(word);
    const notes = await Zotero.Items.getAsync(parent.getNotes());
    const parser = new DOMParser();
    for (const note of notes) {
      if (note.deleted || !note.hasTag(this.tag)) continue;
      const document = parser.parseFromString(note.getNote(), "text/html");
      const root = document.body.querySelector("div[data-schema-version]") || document.body;
      const heading = [...root.querySelectorAll("h3")].find(h => this.matchesSavedWord(h, normalizedWord));
      if (heading) return { noteID: note.id, normalizedWord };
    }
    return null;
  }
  async revealSavedWord(attachmentID, word) {
    if (!this.config.autoLocateSavedWord) return false;
    const saved = await this.findSavedWord(attachmentID, word);
    return saved ? this.openNotebookAtEnd(saved.noteID, saved.normalizedWord) : false;
  }
  async openNotebookAtEnd(noteID, normalizedWord = "") {
    if (!this.config.openNoteAfterSave) return false;
    try {
      const note = await Zotero.Items.getAsync(noteID);
      const contextPane = Zotero.getMainWindow?.()?.ZoteroContextPane;
      const context = contextPane?.context;
      if (!note || !context) return false;
      contextPane.collapsed = false;
      context.mode = "notes";
      const notesContext = context._getNotesContext(note.libraryID);
      notesContext._setPinnedNote(note);
      const editor = notesContext._getCurrentEditor();
      if (!editor) return false;
      await editor.focus();
      const document = editor.getCurrentInstance?.()?._iframeWindow?.document;
      const scrollContainer = document?.querySelector(".editor-core");
      if (!scrollContainer) return false;
      this.attachNoteLocator(document, note);
      if (normalizedWord) {
        const heading = [...document.querySelectorAll("h3")].find(h => this.matchesSavedWord(h, normalizedWord));
        if (heading) { heading.scrollIntoView({ block: "center" }); return true; }
      }
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      return true;
    } catch (error) {
      Zotero.logError?.(error);
      return false;
    }
  }
  async saveAnnotationID(noteID, word, originalWord, annotationID, attachmentID) {
    const note = await Zotero.Items.getAsync(noteID);
    if (!note?.isEditable?.()) return;
    const document = new DOMParser().parseFromString(note.getNote(), "text/html");
    const normalized = LexiNoteCore.normalize(word), original = LexiNoteCore.normalize(originalWord);
    const heading = [...document.querySelectorAll("h3")].find(h => this.matchesSavedWord(h, normalized) || this.matchesSavedWord(h, original));
    if (!heading) return;
    heading.dataset.lexinoteAnnotationId = annotationID;
    heading.dataset.lexinoteAttachmentId = String(attachmentID);
    const source = this.entrySourceLine(heading)?.querySelector?.('a[href^="zotero://open-pdf/"]');
    if (source) {
      const url = new URL(source.href); url.searchParams.set("annotation", annotationID); source.href = url.href;
      const line = source.parentElement;
      // The ID is persisted in the native source-link URL. Do not render it in
      // the note: editor reconciliation can make diagnostic text flash and it
      // is not needed for normal use.
      for (const node of [...(line?.childNodes || [])]) {
        if (node.nodeType === 1 && node.matches?.("span[data-lexinote-highlight-id]")) node.remove();
        else if (node.nodeType === 3) node.nodeValue = node.nodeValue.replace(/ · 高亮 ID：[^ ·]+/g, "");
      }
    }
    note.setNote(document.body.innerHTML); await note.saveTx();
  }
  async savedAnnotationID(noteID, word, originalWord) {
    const note = await Zotero.Items.getAsync(noteID);
    if (!note) return "";
    const document = new DOMParser().parseFromString(note.getNote(), "text/html");
    const normalized = LexiNoteCore.normalize(word), original = LexiNoteCore.normalize(originalWord);
    const heading = [...document.querySelectorAll("h3")].find(h => this.matchesSavedWord(h, normalized) || this.matchesSavedWord(h, original));
    const source = heading && this.entrySourceLine(heading)?.querySelector?.('a[href^="zotero://open-pdf/"]');
    try { return new URL(source?.href || "").searchParams.get("annotation") || ""; }
    catch (_) { return heading?.dataset.lexinoteAnnotationId || ""; }
  }
  attachNoteLocator(document, note) {
    // The Zotero iframe can be returned through a fresh Xray wrapper during
    // the periodic discovery scan. A Map keyed by that wrapper is not stable,
    // so use a marker on the underlying document as the duplicate guard.
    const root = document.documentElement;
    if (root?.getAttribute("data-lexinote-locator-attached") === "true") return;
    root?.setAttribute("data-lexinote-locator-attached", "true");
    this.showNoteLocateStatus(document, this.config.noteLocateMode === "off" ? "生词本原文定位：已关闭" : "生词本原文定位：监听已就绪");
    const locate = event => {
      if (this.config.noteLocateMode === "off") return;
      // A completed drag emits mouseup followed by click. In select mode the
      // latter can still see the old range and made an ordinary click navigate
      // unexpectedly (and reported the same highlighter ID twice).
      if (this.config.noteLocateMode === "select" && event.type !== "mouseup") return;
      if (this.config.noteLocateMode === "click" && event.type !== "click") return;
      const selection = document.getSelection?.();
      const rangeNode = selection?.rangeCount ? selection.getRangeAt(0).commonAncestorContainer : null;
      const selectionElement = rangeNode?.nodeType === 1 ? rangeNode : rangeNode?.parentElement;
      const selectedHeading = selectionElement?.closest?.("h3");
      const heading = this.config.noteLocateMode === "select"
        ? selectedHeading
        : event.target?.closest?.("h3");
      if (!heading || (this.config.noteLocateMode === "select" && !selection?.toString().trim())) return;
      this.showNoteLocateStatus(document, "已读取词条，正在查找原文位置…");
      const source = this.entrySourceLine(heading)?.querySelector?.('a[href^="zotero://open-pdf/"]');
      const annotationID = (() => { try { return new URL(source?.href || "").searchParams.get("annotation") || heading.dataset.lexinoteAnnotationId; } catch (_) { return heading.dataset.lexinoteAnnotationId; } })();
      if (!annotationID) {
        this.openSourceLocation(source?.href).then(opened => {
          heading.title = opened ? "未记录高亮 ID，已跳转到原文页码。" : "未能打开原文页码。";
          this.showNoteLocateStatus(document, heading.title, !opened);
        });
        return;
      }
      this.showNoteLocateStatus(document, "已读取高亮 ID：" + annotationID + "，正在打开 PDF 并定位…");
      this.openSourceLocation(source?.href, annotationID).then(opened => this.showNoteLocateStatus(document, opened ? "已发送高亮定位请求。" : "未能定位高亮，已跳转到原文页码。", !opened));
    };
    document.addEventListener("click", locate);
    document.addEventListener("mouseup", locate);
    this.noteLocatorDocuments.set(document, { locate, root });
  }
  detachNoteLocator(document, handlers) {
    document.removeEventListener("click", handlers.locate);
    document.removeEventListener("mouseup", handlers.locate);
    handlers.root?.removeAttribute("data-lexinote-locator-attached");
    this.noteLocatorDocuments.delete(document);
  }
  clearNoteLocators() {
    for (const [document, handlers] of this.noteLocatorDocuments) this.detachNoteLocator(document, handlers);
  }
  updateNoteLocatorScanning() {
    if (this.config.noteLocateMode === "off") {
      clearInterval(this.noteLocatorTimer);
      this.noteLocatorTimer = null;
      this.clearNoteLocators();
      return;
    }
    if (this.noteLocatorTimer) return;
    this.attachOpenNoteLocators();
    // Editor discovery is only needed while source locating is enabled. A
    // modest interval handles manually opened notes without polling the
    // complete Zotero window every second.
    this.noteLocatorTimer = setInterval(() => this.attachOpenNoteLocators(), 5000);
  }
  pruneNoteLocators() {
    for (const [document, handlers] of this.noteLocatorDocuments) {
      if (document.defaultView?.closed || !handlers.root?.isConnected) this.detachNoteLocator(document, handlers);
    }
  }
  async openSourceLocation(href, annotationID = "") {
    try {
      const url = new URL(href);
      const key = url.pathname.match(/\/items\/([^/]+)$/)?.[1];
      if (!key) return false;
      let attachment = null;
      for (const library of Zotero.Libraries.getAll?.() || []) {
        attachment = Zotero.Items.getByLibraryAndKey?.(library.libraryID, key);
        if (attachment) break;
      }
      if (!attachment) return false;
      const page = Number(url.searchParams.get("page"));
      const location = annotationID ? { annotationID } : (Number.isInteger(page) && page > 0 ? { pageIndex: page - 1 } : {});
      await Zotero.getMainWindow?.()?.ZoteroPane?.viewPDF?.(attachment.id, location);
      return true;
    } catch (_) { return false; }
  }
  showNoteLocateStatus(document, text, error = false) {
    try {
      let status = document.getElementById("lexinote-locate-status");
      if (!status) {
        status = document.createElement("div"); status.id = "lexinote-locate-status";
        status.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:340px;padding:6px 9px;border:1px solid #8888;border-radius:5px;background:Canvas;color:CanvasText;font:12px/1.4 system-ui;box-shadow:0 2px 8px #0003;pointer-events:none;";
        document.body.append(status);
      }
      status.textContent = "LexiNote：" + text;
      status.style.borderColor = error ? "#c44" : "#8888";
    } catch (_) {}
  }
  attachOpenNoteLocators() {
    if (!this.alive) return;
    try {
      this.pruneNoteLocators();
      const context = Zotero.getMainWindow?.()?.ZoteroContextPane?.context;
      for (const library of Zotero.Libraries.getAll?.() || []) {
        const editor = context?._getNotesContext?.(library.libraryID)?._getCurrentEditor?.();
        const document = editor?.getCurrentInstance?.()?._iframeWindow?.document;
        if (document) this.attachNoteLocator(document, null);
      }
      const main = Zotero.getMainWindow?.()?.document;
      const visit = document => {
        if (!document) return;
        if (document.querySelector?.(".editor-core")) this.attachNoteLocator(document, null);
        for (const frame of document.querySelectorAll?.("iframe") || []) visit(frame.contentDocument);
      };
      visit(main);
    } catch (_) {}
  }
  async writeWord({ attachmentID, word, originalWord, result, pageLabel, pageIndex }) {
    if (!this.alive) throw new Error("插件已停用。");
    const attachment = await Zotero.Items.getAsync(attachmentID);
    if (!attachment || attachment.deleted || !attachment.isAttachment()) throw new Error("原文附件已不存在。");
    if (!attachment.parentID) throw new Error("请先为这个独立附件创建父条目，再保存生词。");
    const parent = await Zotero.Items.getAsync(attachment.parentID);
    if (!parent || parent.deleted || !parent.isRegularItem()) throw new Error("找不到附件所属文献。");
    if (!parent.isEditable()) throw new Error("此文献库为只读，无法保存笔记。");
    const parser = new DOMParser();
    const normalizedWord = LexiNoteCore.normalize(word);
    const savedOriginalWord = LexiNoteCore.wordFrom(originalWord) || word;
    const normalizedOriginalWord = LexiNoteCore.normalize(savedOriginalWord);
    const notes = await Zotero.Items.getAsync(parent.getNotes());
    const notebooks = notes.filter(n => !n.deleted && n.hasTag(this.tag));
    let note = null;
    // Older plugin versions could leave more than one LexiNote note. Search
    // every one before choosing where a new word should be appended.
    for (const candidate of notebooks) {
      const candidateDocument = parser.parseFromString(candidate.getNote(), "text/html");
      const candidateRoot = candidateDocument.body.querySelector("div[data-schema-version]") || candidateDocument.body;
      const duplicate = [...candidateRoot.querySelectorAll("h3")].find(h =>
        this.matchesSavedWord(h, normalizedWord) || this.matchesSavedWord(h, normalizedOriginalWord)
      );
      if (duplicate) {
        const formatUpdated = candidate.isEditable() && this.updateSavedWordFormat(candidateDocument, candidateRoot, duplicate,
          savedOriginalWord, attachment, pageLabel, pageIndex);
        if (formatUpdated) {
          candidate.setNote(candidateDocument.body.innerHTML);
          try { await candidate.saveTx(); }
          catch (_) { throw new Error("已保存的生词格式更新失败，请检查文献库权限后重试。"); }
        }
        return { noteID: candidate.id, duplicate: true, formatUpdated };
      }
      if (!note && candidate.isEditable()) note = candidate;
    }
    if (!note && notebooks.length) throw new Error("生词本笔记不可编辑。");
    const fresh = !note;
    if (fresh) {
      note = new Zotero.Item("note"); note.libraryID = parent.libraryID; note.parentID = parent.id;
      note.addTag(this.tag);
    }
    const document = parser.parseFromString(fresh ? '<div data-schema-version="9"><h1>生词本 · LexiNote</h1></div>' : note.getNote(), "text/html");
    const root = document.body.querySelector("div[data-schema-version]") || document.body;
    if ([...root.querySelectorAll("h3")].some(h => h.dataset.lexinoteWord === normalizedWord || LexiNoteCore.normalize(h.textContent.trim()) === normalizedWord)) {
      return { noteID: note.id, duplicate: true };
    }
    const add = (tag, text) => { const el = document.createElement(tag); el.textContent = text; root.append(el); return el; };
    const wordHeading = add("h3", word);
    wordHeading.dataset.lexinoteWord = normalizedWord;
    wordHeading.dataset.lexinoteOriginalWord = normalizedOriginalWord;
    if (result.phonetic) add("p", result.phonetic);
    for (const line of result.meaning.split("\n")) if (line) add("p", line);
    if (result.example) add("p", "例句：" + result.example);
    const p = add("p", "");
    const link = this.createSourceLink(document, attachment, pageLabel, pageIndex);
    p.append(document.createTextNode("原文词：" + savedOriginalWord + " · "), link,
      document.createTextNode(" · " + new Date().toLocaleDateString()));
    note.setNote(document.body.innerHTML);
    // Use the common data API; this does not depend on collection selection APIs changed in v10.
    try { await note.saveTx(); }
    catch (_) {
      if (!fresh) await note.reload(["note"], true).catch(() => {});
      throw new Error("笔记保存失败，请检查文献库权限后重试。");
    }
    return { noteID: note.id, duplicate: false };
  }
  stop() {
    this.alive = false;
    Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this.handler);
    clearInterval(this.noteLocatorTimer);
    this.noteLocatorTimer = null;
    this.clearNoteLocators();
    for (const popup of [...this.popups]) popup.dispose();
    this.clearCache();
  }
};
