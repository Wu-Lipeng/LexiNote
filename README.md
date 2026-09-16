# LexiNote 划词生词本 0.2.7-beta.2

在 Zotero 内置 PDF 阅读器中选中一个单词，显示释义浮窗；点击“保存到生词本”，将单词追加到所属文献的同一条子笔记。

## 安装和使用

1. 在 Zotero 中打开“工具 → 插件”（部分版本称“附加组件”）。
2. 点击右上角齿轮，选择“从文件安装插件”，选择 `lexinote-0.2.7-beta.2.xpi`。
3. 打开 Zotero 的设置，进入“划词生词本”，填写接口配置及密钥。
4. 点击“测试当前配置”。测试成功后点击“保存设置”。测试按钮本身不会保存配置。
5. 在一篇有父条目的 PDF 中双击一个单词或拖动选中一个单词，等待浮窗显示，然后点击“保存到生词本”。

本插件不捆绑付费服务或公共 API 密钥，未配置接口时不会查询。接口服务由使用者选择。

## 接口配置

插件支持“百度文本翻译·词典版”和“百度文本翻译·通用版”。两者均使用百度 API Key 和 Secret Key 获取 access_token，并在内存中缓存。词典版调用 `texttrans-with-dict/v1`，返回词性、音标和例句；通用版调用 `texttrans/v1`，仅返回翻译结果。

百度通用版可启用试用密钥，每日最多查询 50 次；设置页会显示当天剩余额度。

通用接口、百度词典版和百度通用版各自的 API Key、Secret Key 使用独立的 Zotero 凭据存储；插件不会把 Secret Key 写进配置 JSON、通用模板或笔记。切换接口类型后，先前填写的凭据会保留，并在切回对应接口时自动恢复。百度接口返回的词性、释义、音标和例句会合并成浮窗内容，并按普通文字写入笔记。

设置页会根据所选接口只显示相关字段；启用百度通用版试用后，会隐藏用户自己的百度 Key 与 Secret Key 输入框。

如果你使用的就是 BingeWord 当前配置，选择百度模式即可，不需要填写通用接口地址、请求头、请求体或响应路径。

当前支持 HTTPS 的 GET / POST JSON 接口，以及 `localhost`、`127.0.0.1`、`[::1]` 上的 HTTP 本地服务。

假设你的接口返回：

```json
{
  "data": {
    "translation": ["示例", "例子"],
    "phonetic": "/ɪɡˈzɑːmpəl/",
    "examples": ["This is an example."]
  }
}
```

设置为：

| 设置项 | 示例值 |
|---|---|
| 接口地址 | `https://你的服务域名/lookup?word={{word}}&target={{target}}` |
| 请求方式 | `GET` |
| API 密钥 | 你的密钥；无需认证可留空 |
| 请求头 JSON | `{"Authorization":"Bearer {{apiKey}}"}`，无需认证时填 `{}` |
| 释义字段路径 | `data.translation` |
| 音标字段路径 | `data.phonetic`，可留空 |
| 例句字段路径 | `data.examples`，可留空 |
| 目标语言 | `zh-CN`，按接口文档填写 |

如果使用 POST，接口地址填写实际端点，请求体例如：

```json
{"word":"{{word}}","target":"{{target}}"}
```

请求体和请求头必须是有效 JSON。占位符必须放在 JSON 字符串内；插件自动处理 JSON 转义和 URL 编码。POST 默认发送 `Content-Type: application/json`。接口返回整个字符串时，释义路径填 `$`。

字段路径支持 `data.meanings[0].text`、`data.meanings[*].text`，以及多层数组，例如 `[*].meanings[*].definitions[*].definition`。不支持任意 JavaScript、完整 JSONPath 表达式或 XML/HTML 响应。接口返回对象时，应选择其内部的文字字段。

动态签名、OAuth 授权、流式输出和特殊二进制响应需要单独适配。只有接口地址和密钥，并不一定足以接入所有词典服务。

## 笔记行为

- 每篇父文献使用一条带有 `LexiNote:生词本` 标签的子笔记。首次保存时创建；之后追加。不要删除这个识别标签。
- 同一文献的多个附件共用这条笔记。不同文献分别保存。
- 重复单词按 Unicode 规范化、忽略大小写进行检查，不重复添加。可在笔记中直接编辑已有释义。
- 保存单词、释义、可选音标、例句、保存日期和返回原文的页码链接。
- 已保存的手工补充内容会保留。独立附件需要先创建父条目；只读文献库会提示无法保存。
- 生词本进入回收站后，下次保存会创建新的生词本。
- 关闭浮窗不删除已经保存的词。卸载插件不会删除文献笔记。

## 配置、隐私和性能

配置完成并启用后，选择的单词会发送到使用者配置的服务；插件不会发送整篇 PDF。密钥使用 Zotero 的凭据存储，不写入配置 JSON 或笔记。不要在 URL 或模板里硬编码密钥，应使用 `{{apiKey}}`。清空密钥字段并保存可删除已保存密钥。

默认延迟 350 ms 查询，选择多个单词或超过 80 字符时不查询。最多并行 3 个请求，默认超时 12 秒，响应上限 1 MB。最近 200 个词的查询结果缓存在内存中，15 分钟失效。换词、关闭浮窗、停用插件会取消对应查询；保存设置会清空缓存。启动时不扫描文献库，也不建立全文索引。

当前版本通过 GitHub Releases 分发。Zotero 会从仓库中的 `update.json` 检查新版本。推送 `v*` 标签会触发工作流构建 XPI 并创建 GitHub Release；发布新版本时仍需在同一提交中手动更新 `update.json`，使版本号、下载地址和兼容范围与新 XPI 一致。

## 开发

使用原生 JavaScript，运行时没有第三方依赖。通过官方 `renderTextSelectionPopup` 事件扩展阅读器，使用 Zotero Item API 保存笔记。基础机制面向 Zotero 7–10，具体实测版本和范围见 `TESTING.md`。

```powershell
node --test tests/core.test.cjs
./build.ps1
```

可选浏览器 DOM 测试需要 Playwright 与 Microsoft Edge：

```powershell
npm install --no-save playwright
node --test tests/dom.test.cjs
```

`tests/integration.js` 是独立测试配置中运行的 Zotero 集成测试，不包含在正式 XPI 中。它会创建临时文献和笔记并在完成后退出测试实例；必须配置独立的 profile、dataDir、`extensions.lexinote.testData` 和 `extensions.lexinote.testOutput`。请勿将测试脚本放入正式个人配置。

开发参考：

- https://www.zotero.org/support/dev/zotero_7_for_developers
- https://www.zotero.org/support/dev/zotero_8_for_developers
- https://www.zotero.org/support/dev/zotero_9_for_developers
- https://www.zotero.org/support/dev/zotero_10_for_developers
- https://www.zotero.org/support/dev/client_coding/javascript_api
