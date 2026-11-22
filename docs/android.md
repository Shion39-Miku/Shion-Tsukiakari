# 月明かり安卓安装与使用指南

## 安装及登录

1. 下载 `Tsukiakari-0.4.7-Android.apk`，在 Android 9 或更新的设备上按系统提示确认安装。建议保持 Android System WebView 更新。 [Android APK](https://github.com/Shion39-Miku/Shion-Tsukiakari/releases/download/v0.4.7/Tsukiakari-0.4.7-Android.apk) · [SHA-256](https://github.com/Shion39-Miku/Shion-Tsukiakari/releases/download/v0.4.7/Tsukiakari-0.4.7-Android.apk.sha256)
2. 打开月明かり，在登录页输入共享聊天账号和密码。勾选「记住登录状态」可在重启后继续使用有效会话。网络或服务暂不可用时，登录页会提供「重试连接」。在「我的」里可退出登录。
3. 手机、平板和新版 Windows 发行包使用同一账号时，会话、已读和最近 30 天的消息会自动同步。网站管理仍使用独立授权。 [共享后端上线配置](chat-retention.md)
4. Release APK 的包名为 `wiki.shion.tsukiakari`，沿用此前交付的本机 0.1.1 签名。设备上使用该签名的旧包可覆盖升级。CI 与 QA 使用独立包名，数据各自保存在系统分配的应用空间。 [Android 应用签名](https://developer.android.com/studio/publish/app-signing)

发布包使用预置的 `https://shion.wiki`。持续集成的双端同步测试使用隔离聊天服务，生产验收结果随发行记录公布。

## 手机和平板

- 手机从底部进入「聊天」「通讯录」「我的」。点会话进入全屏，返回时可以接着筛选或编辑。聊天列表可点击四个分类，也可横向划动。通讯录搜索、好友申请和群邀请集中在底部浮层。
- 有 740 个逻辑像素宽度时进入平板布局。侧边导航、会话列表和聊天并列显示。空间充足时能展开群成员；缩窄时从聊天头部打开详情。设备旋转和分屏改变布局，不需要退出当前会话。
- 点加号开始 AI、好友或群聊。群聊通过邀请加入，受邀用户在通讯录接受。选择群中允许使用的 AI 时沿用服务端人格及记忆授权。历史记录滚动到顶部后可以继续加载。
- 手机键盘的回车会换行，点击发送按钮发出消息。有外接键盘时可用 Ctrl+Enter。点附件按钮打开系统文件选择器，下载和导出会打开系统保存窗口。
- 「我的」可修改资料、头像、在线状态、记忆授权及设备通知。管理员额外看到「网站管理」与「软件管理」。网站草稿按原有保存、同步流程发布；人格由 AstrBot 后端管理并回读。
- 「我的 → 关于月明かり」说明服务器的 30 天保留期。旧聊天附件随服务器引用到期。未发送草稿留在设备，主动导出的文件由你保管。

## 通知

「我的 → 设备通知」分别控制提示卡片、提示音、振动、群提醒、免打扰、正文预览和减少动效。偏好按设备、服务和账号保留。聊天、资料和已读进度按账号同步。

应用内提示可点按进入会话。开启后台消息连接并授予系统权限后，应用会显示一条常驻连接通知，以同一账号接收新消息。系统消息按会话合并，默认只显示有新消息，点按跳转或标记已读。正文预览开启后仍受系统锁屏及勿扰设置约束。首次授权被拒绝时，可以继续前台聊天，再从应用设置进入系统授权。

后台消息连接依赖应用进程、系统权限和到服务端的连通性。设备或系统强制终止应用时需重新打开。测试版使用现有实时连接，尚无推送服务在进程停止后唤醒，也暂未开放通知快捷回复。当前会话正在查看时跳过重复提示；恢复连接后补齐服务端历史。

## 长按图标和暂别

在支持动态快捷方式的桌面长按图标，可进入「先别道晚安…」。会话失效时先登录，登录后继续打开詩音与知遥的小页面。也可以在「我的 → 暂别月光」进入。

[Android 15 启动器实拍](images/android-shortcut.png) · [暂别月光页面实拍](images/android-farewell.png)

「导出个人数据」通过系统文件选择器保存 JSON，包括个人资料、好友、会话目录和本机文字草稿。服务器聊天与附件按保留策略管理。「卸载应用」打开安卓系统确认。卸载移除本机登录、缓存和草稿。服务器账号仍可登录，已导出的文件由用户管理。

## 开发与测试

使用 Node.js 24、pnpm 11、JDK 17、Android SDK Platform 35、Build Tools 35.0.0。将 `JAVA_HOME` 指向 JDK、`ANDROID_HOME` 指向 SDK。Android Studio 可打开 `android/`；交付使用以下 SDK 构建路径。

```sh
pnpm install --frozen-lockfile
pnpm android:build --ci
pnpm android:build --debug
pnpm security:check android ci qa
```

CI 和 QA APK 的目录分别为 `artifacts/android/0.4.7-ci/` 与 `artifacts/android/0.4.7-qa/`。二者使用临时签名，适合独立安装验收。签名发布包由维护者从干净的发布提交运行 `pnpm android:build`，输出到 `artifacts/android/0.4.7/`。 [维护者签名与发布流程](releasing.md)

QA 版包名以 `.qa` 结尾，预置供 ADB 转发的回环 HTTP，默认端口 4187。开发机可用 `TSUKIAKARI_ANDROID_QA_PORT` 在构建和启动演示服务时统一选择端口。Release 与 `.ci` 均从 `deploy/chat-public.json` 编译公开 HTTPS 地址。

手动验收时，在电脑运行 `node --disable-warning=ExperimentalWarning scripts/android-fixture.mjs`。脚本启动隔离的网站、聊天数据库与模拟 AstrBot，并把演示登录信息写入忽略目录内的 `artifacts/android/fixture/fixture.private.json`。在已授权 USB 调试的设备安装 QA 包后执行 `adb reverse tcp:4187 tcp:4187`，直接用演示账号登录。桌面可以同时打开同一服务。 [本地联调配置](chat-retention.md#验证与部署)

```sh
pnpm exec playwright install chromium
pnpm check:android:ui
pnpm check:android:device artifacts/android/0.4.7-ci/Tsukiakari-0.4.7-CI.apk artifacts/android/0.4.7-qa/Tsukiakari-0.4.7-QA.apk
```

设备验收脚本默认使用隔离的 `emulator-5554`，会调整该模拟器的显示与输入设置。测试数据留在忽略的 `artifacts/`。CI 验收截图只含演示数据。
