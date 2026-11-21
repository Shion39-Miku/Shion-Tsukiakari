# 构建和发布月明かり预发布版

应用版本来自根目录 `package.json`、`desktop/package.json` 和 `android/app/build.gradle`。发布时三处版本一致，更新 Android `versionCode`，使用同版本的 `v` 标签。保留旧标签和已经发布的附件。

## 产物和签名

- 普通 Checks 运行在隔离设计的 `.ci` 包上验收 Android HTTPS 入口，下载项名为 `Tsukiakari-Android-CI`。`.qa` 用于转发到演示服务。报告和截图单独上传为 `Tsukiakari-Android-QA`。
- Release APK 用延续旧版本的签名在受控构建机生成。Windows 默认从当前用户的本地应用数据读取已有签名目录，也可用 `TSUKIAKARI_ANDROID_SIGNING_DIR` 指向受控目录。目录内的 `local-test.keystore` 和 `signing.private.json` 沿用既有配置。仓库只保存公开证书指纹，缺少原签名材料或指纹不同时构建失败。
- `pnpm android:build` 需要干净的发布提交。输出包含 APK、单文件 `.sha256` 和 `android-build.json`。包内的源码提交由同一签名保护。`pnpm security:check android release` 会核对提交、签名、包名、版本、HTTPS 和 APK 内容。

## 从验证到公开下载

1. 按开发规范扫描源码、配置、暂存文件和 Git 历史。人工核对文档、测试截图和报告中的隐私。功能提交通过 Checks 后，在目标提交建立新的注释标签。实际推送经过仓库钩子。
2. 在对应的干净提交运行 `pnpm android:build` 及 `pnpm security:check android release`。用 `gh release create` 建立同标签的草稿预发布，使用 `--verify-tag --draft --prerelease --notes-file`。添加经审计的 APK、单文件校验和构建清单。
3. 在该标签上以 `release_tag` 参数手动运行 `checks.yml`。任务从草稿取得实际签名 APK，重新扫描并在 Android 15 模拟器安装启动。同时用隔离的 QA 包执行双端聊天测试。Windows 从同一提交构建、运行并检查两种发行文件。发布准备任务将已验证的 Windows 文件和汇总校验表添加到草稿。
4. 验证整个运行成功、标签指向目标提交，复核草稿附件名称、字节摘要与测试产物。随后用 `gh release edit` 将草稿公开为预发布。核对匿名下载与校验值。 [GitHub CLI 创建 Release](https://cli.github.com/manual/gh_release_create)
