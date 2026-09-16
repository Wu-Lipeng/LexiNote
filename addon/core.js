/* Shared pure logic: no dependencies on Zotero or Node. */
var LexiNoteCore = (() => {
  "use strict";
  const defaults = Object.freeze({
    enabled: true, provider: "generic", endpoint: "", method: "GET", headers: "{}",
    baiduApiKey: "", baiduSecretKey: "", useBaiduTrial: false,
    body: '{"word":"{{word}}","target":"{{target}}"}',
    meaningPath: "translation", phoneticPath: "", examplePath: "",
    target: "zh-CN", delay: 350, timeout: 12000,
    autoHighlight: false, highlightColor: "#ffd400", highlightType: "highlight"
  });
  function wordFrom(text) {
    const value = String(text || "").normalize("NFC").trim()
      .replace(/^[\s“”‘’".,;:!?()[\]{}]+|[\s“”‘’".,;:!?()[\]{}]+$/gu, "");
    return value.length <= 80 && /^[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*$/u.test(value)
      ? value : "";
  }
  function wordCandidates(word) {
    const value = String(word || "");
    // Only ordinary title-case English words need a lower-case fallback.
    // Acronyms such as USA and mixed-case proper names remain untouched.
    if (!/^[A-Z][a-z]+(?:['-][A-Za-z]+)*$/.test(value)) return [value];
    return [value, value[0].toLowerCase() + value.slice(1)];
  }
  function normalize(word) { return word.normalize("NFC").toLocaleLowerCase("en-US"); }
  function json(value, label) {
    try { return JSON.parse(value); }
    catch (_) { throw new Error(label + "必须是有效 JSON。"); }
  }
  function template(value, vars, encode = false) {
    return String(value).replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (!(key in vars)) throw new Error("未知占位符：" + key);
      return encode ? encodeURIComponent(vars[key]) : vars[key];
    });
  }
  function mapStrings(value, vars) {
    if (typeof value === "string") return template(value, vars);
    if (Array.isArray(value)) return value.map(x => mapStrings(x, vars));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, vars)]));
    }
    return value;
  }
  function pathParts(path) {
    if (!path || path === "$") return [];
    const clean = path.replace(/^\$\.?/, "").replace(/\[(\d+|\*)\]/g, ".$1").replace(/^\./, "");
    const parts = clean.split(".");
    if (parts.some(p => !/^(?:[\w-]+|\*)$/.test(p) || ["__proto__", "prototype", "constructor"].includes(p))) {
      throw new Error("响应路径格式不正确，请使用 translation、data.meanings[*].text 等形式。");
    }
    return parts;
  }
  function valuesAt(data, path) {
    let values = [data];
    for (const part of pathParts(path)) {
      values = values.flatMap(value => {
        if (part === "*") return Array.isArray(value) ? value : [];
        return value != null && Object.prototype.hasOwnProperty.call(value, part) ? [value[part]] : [];
      });
    }
    return values.flat(Infinity).filter(v => typeof v === "string" || typeof v === "number")
      .map(String).map(v => v.trim()).filter(Boolean);
  }
  function validate(input, allowEmpty = false) {
    const c = { ...defaults, ...input };
    c.endpoint = c.endpoint.trim();
    if (!["generic", "baidu", "baidu-general"].includes(c.provider)) throw new Error("词典接口类型不正确。");
    if (["baidu", "baidu-general"].includes(c.provider)) {
      if (typeof c.useBaiduTrial !== "boolean") throw new Error("试用接口设置不正确。");
      if (c.useBaiduTrial && c.provider !== "baidu-general") throw new Error("试用接口仅支持百度文本翻译·通用版。");
      if (!allowEmpty && !c.useBaiduTrial && (!c.baiduApiKey.trim() || !c.baiduSecretKey.trim())) throw new Error("请填写百度 API Key 和 Secret Key，或启用试用接口。");
      return c;
    }
    if (!c.endpoint && !allowEmpty) throw new Error("请先在设置中填写接口地址。");
    if (!["GET", "POST"].includes(c.method)) throw new Error("仅支持 GET 或 POST 请求。");
    const h = json(c.headers, "请求头");
    if (!h || Array.isArray(h) || typeof h !== "object" || Object.values(h).some(v => typeof v !== "string")) {
      throw new Error("请求头必须是字符串键值组成的 JSON 对象。");
    }
    for (const [key, value] of Object.entries(h)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value)) throw new Error("请求头名称或内容不合法。");
    }
    if (c.method === "POST") json(c.body, "请求体");
    if (!c.meaningPath.trim()) throw new Error("请填写释义字段路径，根节点为字符串时填写 $。");
    for (const p of [c.meaningPath, c.phoneticPath, c.examplePath]) pathParts(p);
    if (!Number.isInteger(c.delay) || c.delay < 150 || c.delay > 3000) throw new Error("划词延迟应为 150–3000 毫秒。");
    if (!Number.isInteger(c.timeout) || c.timeout < 1000 || c.timeout > 60000) throw new Error("超时应为 1000–60000 毫秒。");
    if (!c.target.trim()) throw new Error("请填写目标语言。");
    if (typeof c.autoHighlight !== "boolean") throw new Error("自动标记设置不正确。");
    if (!/^#[0-9a-f]{6}$/i.test(c.highlightColor)) throw new Error("标记颜色格式不正确。");
    if (!["highlight", "underline"].includes(c.highlightType)) throw new Error("标记样式不正确。");
    const vars = { word: "test", target: c.target, apiKey: "test-key" };
    mapStrings(h, vars);
    if (c.method === "POST") mapStrings(json(c.body, "请求体"), vars);
    if (c.endpoint) {
      let url;
      try { url = new URL(template(c.endpoint, vars, true)); } catch (_) { throw new Error("接口地址格式不正确。"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("接口地址须为 HTTP(S)，且不能包含用户名或密码。");
      if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("远程接口请使用 HTTPS；HTTP 仅用于本机服务。");
      if (url.hash) throw new Error("接口地址不能包含 # 片段。");
      // Secrets belong in headers/body: URLs can be recorded by proxies and logs.
      if (c.endpoint.includes("{{apiKey}}")) throw new Error("请把 {{apiKey}} 放入请求头或 JSON 请求体，不要放入网址。");
      const originTemplate = c.endpoint.match(/^https?:\/\/([^/\s?#]+)/i)?.[1] || "";
      if (originTemplate.includes("{{")) throw new Error("接口域名不能使用占位符。");
      if (!(c.endpoint + (c.method === "POST" ? c.body : "")).includes("{{word}}")) throw new Error("接口地址或 POST 请求体中必须包含 {{word}}。");
    }
    return c;
  }
  function request(c, word, apiKey) {
    const vars = { word, target: c.target, apiKey };
    if ((c.headers + (c.method === "POST" ? c.body : "")).includes("{{apiKey}}") && !apiKey) throw new Error("此接口需要密钥，请在设置中填写并保存。");
    const headers = mapStrings(json(c.headers, "请求头"), vars);
    if (c.method === "POST" && !Object.keys(headers).some(k => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
    return {
      url: template(c.endpoint, vars, true), method: c.method, headers,
      body: c.method === "POST" ? JSON.stringify(mapStrings(json(c.body, "请求体"), vars)) : null
    };
  }
  function response(data, c) {
    const meaning = [...new Set(valuesAt(data, c.meaningPath))].join("\n").slice(0, 16000);
    if (!meaning) throw new Error("响应中没有找到释义，请检查释义字段路径或接口返回内容。");
    return {
      meaning,
      phonetic: c.phoneticPath ? valuesAt(data, c.phoneticPath).join(" / ").slice(0, 1000) : "",
      example: c.examplePath ? valuesAt(data, c.examplePath).join("\n").slice(0, 6000) : ""
    };
  }
  function escape(text) {
    return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  return { defaults, wordFrom, wordCandidates, normalize, validate, request, response, valuesAt, escape };
})();
if (typeof module !== "undefined") module.exports = LexiNoteCore;
