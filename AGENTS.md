# LexiNote 项目协作指令

## Android 测试版发布

对 `android-app/` 的功能性修改完成后，必须按以下流程交付测试版，除非用户明确要求不发布或仅要求诊断：

1. 递增 `android-app/app/build.gradle.kts` 中的 `versionCode`，并将 `versionName` 设为新的 `-beta.N` 测试版本；同步更新 `android-app/README.md` 中的版本号。
2. 在 `android-app/` 目录运行 `./gradlew testDebugUnitTest assembleDebug`；仅在测试与构建均成功后继续。
3. 提交本次改动，提交信息说明功能或修复内容。
4. 推送 `main`，创建并推送匹配版本的标签 `android-v<versionName>`，以触发 `.github/workflows/android-release.yml`。
5. 确认 GitHub Actions 已开始运行，并向用户报告测试版发布状态与构建链接。

不得仅生成本地 Debug APK 就将 Android 功能更新视为交付完成。
