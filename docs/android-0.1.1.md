# 月明かり安卓 0.1.1

- 首次启动直接显示账号密码、登录和记住登录状态。服务连接失败时可在同一页重试。
- 同一账号在连接共享服务的桌面、手机和平板同步最新会话、已读状态与保留期内的消息。增量游标也覆盖已收到的 AI 消息更新。
- 服务器按消息原始创建时间保留 30×24 小时。手机和平板布局、设备通知、长按图标和彩蛋沿用已有交互。
- 包名与测试签名沿用同一构建机的 0.1.0，支持覆盖升级。兼容 Android 9 起，目标 API 35。

标准包预置 `https://shion.wiki`。本轮验收时该域名的聊天会话接口仍返回 404，正式账号登录需要先上线共享聊天路由。隔离演示可用独立的 QA 包验证。

Android 15 模拟器和 Electron 实际窗口已在隔离库上同账号登录，验证双向私聊、群消息、AI 流式回复及断网补齐。测试使用模拟 AstrBot；真实云端人格由现有部署管理。[模拟器记录](https://github.com/Shion39-Miku/Shion-Tsukiakari/actions/runs/44887118685)

[账号登录](images/android-login.png) · [服务不可用时的重试](images/android-login-retry.png) · [手机聊天](images/android-phone-chat.png) · [平板群聊](images/android-tablet.png)

[安装与使用](android.md) · [服务端迁移、备份和恢复](chat-retention.md)
