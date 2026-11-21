# 月明かり v0.4.5 预发布

Windows 安装版、免安装版和 Android APK 默认连接同一个公开 HTTPS 聊天服务。打开应用后直接输入聊天账号及密码。桌面端按 Alt 后可在「月明かり」菜单查看升级前的本地聊天资料，再切回正式服务。

生产聊天服务使用独立进程和持久数据库。`/chat/assets/` 随聊天服务版本提供界面资源，网站的页面、资源和管理权限由原网站进程提供。服务器按创建时间保留最近 30×24 小时的消息，并记录每轮清理的脱敏摘要。 [部署、备份与回退](chat-retention.md)

Android 支持 Android 9 及以上，包名和签名延续旧发行版。Windows 提供 x64 安装版和免安装版。 [安装与升级](android.md) · [发布附件与校验](https://github.com/Shion39-Miku/Shion-Tsukiakari/releases/tag/v0.4.5)
