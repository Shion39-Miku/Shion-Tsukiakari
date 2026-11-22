# 月明かり v0.4.6 预发布

修复旧版 Android System WebView 缺少 `AbortSignal.timeout` 或 `AbortSignal.any` 时请求无法发出的问题，保留登录和消息请求的超时与取消行为。

Windows 安装版、免安装版和 Android APK 默认连接同一套 HTTPS 聊天服务。打开应用后直接输入聊天账号和密码。同一账号的会话、消息和已读状态跨端同步。桌面端按 Alt 后可在「月明かり」菜单查看升级前的本地聊天资料。

Android 支持 Android 9 及以上，手机使用分级聊天导航，平板有足够空间时使用双栏。APK 沿用旧发行版的包名和签名，可覆盖升级。Windows 提供 x64 安装版和免安装版，测试构建尚无 Authenticode 签名。 [安装与升级](android.md)

这次更新沿用独立运行的聊天服务及数据库。服务器按创建时间保留最近 30×24 小时的消息，网站内容由原有网站后端管理。 [部署、备份与回退](chat-retention.md)
