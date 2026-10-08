# LexiNote Android（测试版 0.1.0-beta.13）

离线安卓背词客户端，导入由 LexiNote Zotero 插件导出的 `lexinote-wordbook` schema v1 JSON 文件。

## 功能

- 系统文件选择器导入 JSON；同一 `id` 再次导入时保留本机复习进度。
- 词库搜索、词义、音标、例句、原文句与文献页码来源查看。
- 卡片式学习界面：点击翻卡后选择“再记一次”或“认识了”；数据保存在应用私有存储，不上传网络。
- 启动时检查 GitHub Android 更新清单；用户确认下载后交由系统安装器更新。

## 打开与测试

使用 Android Studio 打开本目录，等待 Gradle 同步后运行 `app`。单元测试：`./gradlew test`。

最低 Android 版本为 8.0（API 26）。
