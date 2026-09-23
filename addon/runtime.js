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
      manager.addAnnotation(annotation);
      return { marked: true };
    } catch (error) {
      return { marked: false, reason: error?.message || "Zotero 拒绝创建标注。" };
    }
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
        const saved = await this.saveWord({ attachmentID, word: entry.word, result: entry.result, pageLabel, pageIndex });
        if (!saved.duplicate) await this.openNotebookAtEnd(saved.noteID);
        if (!disposed) {
          status.textContent = saved.duplicate ? "该词已在这篇文献的生词本中。" : "已追加到这篇文献的生词本。";
          const marking = this.autoMark(reader, highlightDraft);
          if (marking.marked) status.textContent += " 已自动标记选中文本。";
          else if (this.config.autoHighlight && marking.reason !== "disabled") status.textContent += " 自动标记未完成：" + marking.reason;
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
  async openNotebookAtEnd(noteID) {
    if (!this.config.openNoteAfterSave || !Zotero.Notes?.open) return false;
    try {
      const editor = await Zotero.Notes.open(noteID);
      const scrollContainer = editor?._iframeWindow?.document?.querySelector(".editor-core");
      if (!scrollContainer) return false;
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      return true;
    } catch (error) {
      Zotero.logError?.(error);
      return false;
    }
  }
  async writeWord({ attachmentID, word, result, pageLabel, pageIndex }) {
    if (!this.alive) throw new Error("插件已停用。");
    const attachment = await Zotero.Items.getAsync(attachmentID);
    if (!attachment || attachment.deleted || !attachment.isAttachment()) throw new Error("原文附件已不存在。");
    if (!attachment.parentID) throw new Error("请先为这个独立附件创建父条目，再保存生词。");
    const parent = await Zotero.Items.getAsync(attachment.parentID);
    if (!parent || parent.deleted || !parent.isRegularItem()) throw new Error("找不到附件所属文献。");
    if (!parent.isEditable()) throw new Error("此文献库为只读，无法保存笔记。");
    const parser = new DOMParser();
    const normalizedWord = LexiNoteCore.normalize(word);
    const notes = await Zotero.Items.getAsync(parent.getNotes());
    const notebooks = notes.filter(n => !n.deleted && n.hasTag(this.tag));
    let note = null;
    // Older plugin versions could leave more than one LexiNote note. Search
    // every one before choosing where a new word should be appended.
    for (const candidate of notebooks) {
      const candidateDocument = parser.parseFromString(candidate.getNote(), "text/html");
      const candidateRoot = candidateDocument.body.querySelector("div[data-schema-version]") || candidateDocument.body;
      const duplicate = [...candidateRoot.querySelectorAll("h3")].some(h =>
        h.dataset.lexinoteWord === normalizedWord || LexiNoteCore.normalize(h.textContent.trim()) === normalizedWord
      );
      if (duplicate) return { noteID: candidate.id, duplicate: true };
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
    if (result.phonetic) add("p", result.phonetic);
    for (const line of result.meaning.split("\n")) if (line) add("p", line);
    if (result.example) add("p", "例句：" + result.example);
    const p = add("p", "");
    const link = document.createElement("a");
    const library = Zotero.Libraries.get(attachment.libraryID);
    const libraryPath = library.libraryType === "group" ? "groups/" + library.groupID : "library";
    link.href = "zotero://open-pdf/" + libraryPath + "/items/" + attachment.key
      + (Number.isInteger(pageIndex) ? "?page=" + (pageIndex + 1) : "");
    link.textContent = pageLabel ? "原文 · 第 " + pageLabel + " 页" : "查看原文";
    p.append(link, document.createTextNode(" · " + new Date().toLocaleDateString()));
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
    for (const popup of [...this.popups]) popup.dispose();
    this.clearCache();
  }
};
