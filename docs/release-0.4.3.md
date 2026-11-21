# 月明かり v0.4.3 预发布

本次加入可直接安装的 Android APK，与 Windows x64 安装版、免安装版一同发布。发行附件对应同一 Git 标签，附带 SHA-256 文件。 [下载与校验](https://github.com/Shion39-Miku/Shion-Tsukiakari/releases/tag/v0.4.3)

## 安卓安装和升级

- 下载 `Tsukiakari-0.4.3-Android.apk`。支持 Android 9 及以上，目标 API 35。打开文件，由 Android 确认安装。
- 包名是 `wiki.shion.tsukiakari`，`versionCode` 为 3。沿用之前交付的 0.1.1 签名，适合更新同包名、同签名的旧版本。Actions 的 `.ci` 和 `.qa` 包各用独立包名及临时签名。 [安卓指南](android.md)
- 打开应用后直接输入账号和密码。手机使用底部导航和全屏聊天，平板使用会话与聊天并列的布局，支持展开群成员面板。

## 功能与验收范围

安卓和桌面共享服务使用同一账号和数据库，支持同步私聊、群聊及 AI 回复，断网恢复后按游标补齐。服务端以消息创建时间为准保留最近 30×24 小时，清理任务、附件引用与恢复前清理规则随源码交付。 [共享后端与保留策略](chat-retention.md)

Android 15 模拟器验收覆盖直接登录页、手机和平板布局、通知、进程重启、切换账号及隔离服务的桌面双端同步。AI 流式场景使用模拟 AstrBot。Windows 发布包为 x64 测试构建，尚无 Authenticode 签名。

标准包预置 `https://shion.wiki`。本次验收时生产聊天会话接口返回 404，实际账号登录与云端同步仍待开通共享聊天路由。
