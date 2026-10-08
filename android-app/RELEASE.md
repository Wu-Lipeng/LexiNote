# Android 发布与更新

Android App 和 Zotero 插件使用独立的版本号、标签和 GitHub Actions 工作流。

## 发布 Android App

1. 将 `app/build.gradle.kts` 的 `versionCode` 递增，并更新 `versionName`，例如 `0.1.0-beta.8`。
2. 运行 `./gradlew testDebugUnitTest assembleDebug`，完成测试。
3. 推送标签 `android-v0.1.0-beta.8`。
4. `android-release.yml` 会构建签名 APK，并创建同名 GitHub Release，上传 `lexinote-0.1.0-beta.8.apk`。

仓库需要配置四项 Actions Secrets：

- `ANDROID_KEYSTORE_BASE64`：稳定发布密钥库的 Base64 内容。
- `ANDROID_STORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

所有 Android Release 必须使用同一份发布密钥，否则已安装的用户无法覆盖更新。

## App 内更新

App 启动时读取固定 GitHub Release `android-update` 中的 `android-update.json`。每次 Android 发布工作流都会覆盖该清单，写入版本号与对应 APK 地址；这样不依赖 GitHub REST API 的匿名请求额度，也不会被插件 Release 数量影响。发现更高版本后，首页显示“下载并更新”。下载完成会打开 Android 系统安装器；系统必须由用户确认安装，App 无法静默更新。

`versionCode` 是 Android 安装器使用的单调递增内部版本；`versionName` 和 GitHub 标签则是面向用户的版本号。

## 与 Zotero 插件发布的区别

| 项目 | Zotero 插件 | Android App |
|---|---|---|
| 标签 | `v*`，如 `v0.2.17` | `android-v*`，如 `android-v0.1.0-beta.8` |
| 工作流 | `release.yml` | `android-release.yml` |
| 构建产物 | XPI | 已签名 APK |
| 更新机制 | Zotero 读取根目录 `update.json` | App 读取 GitHub Releases API |
| 版本位置 | `package.json`、插件 manifest、`update.json` | `android-app/app/build.gradle.kts` |
