# 架构与运行

## 服务边界

- **桌面**：Electron 45.3.1，窗口启用sandbox、contextIsolation，禁用Node集成与任意页面导航。显示名月明かり，程序名Tsukiakari。
- **软件后端**：Node.js24、原生SQLite，管理用户、好友、群、消息、附件、在线连接、AI任务、摘要和记忆。管理路由 `/api/chat/admin/*`，账号兼容入口 `/api/admin/accounts`。
- **网站后端**：独立SQLite，管理网站内容、媒体、草稿和发布批次；网站模式不提供聊天路由。软件通过固定地址的受控接口访问。
- **AstrBot**：权威人格、模型和独立AI会话；连接器鉴权再次区分聊天令牌与人格管理令牌。软件不把模型建议当成写入授权。

桌面本地由一个Node子进程运行两个回环HTTP服务，便于无需额外安装即可启动；两套后端路由、权限和数据库独立。生产环境可拆成两个进程，并分别使用环境变量配置。不会因本机启动自动部署到云端。

## 数据与升级

新安装版默认 `%APPDATA%/Tsukiakari`，新便携版为EXE旁的 `Tsukiakari-data`。若发现旧版 `%APPDATA%/HoshifuruYoruNi` 或旧便携版 `星降る夜に-data`，直接使用原完整目录；不会只拷贝数据库或覆盖已有记录。显式 `TSUKIAKARI_DESKTOP_DATA` 优先，旧HOSHIFURU环境变量保留兼容。

安装升级保留内部appId `wiki.shion.hoshifuru`，以继续识别同一个卸载项和升级链。显示名称与程序文件名均已更新；这些旧标识只用于兼容，不作为产品显示名。保留旧目录同时保留Chromium Cookie、localStorage、窗口状态和Windows加密凭据。新程序与旧程序共用同一数据目录时，单实例锁避免同时启动。

`data/chat.sqlite` 是软件权威库，`data/website.sqlite` 是本地网站权威库。此前单库的 `moonlit.sqlite` 保留，缺失新库时通过在线备份初始化；再次启动不覆盖。迁移001—007按编号执行，已有ID、消息、群成员和媒体关联不变。为兼容历史，库里可留有另一业务的旧表；各自服务不使用这些旧表提供跨业务权限。

公开安装包的种子库由脚本从可公开素材和合成演示音乐生成，不打包本机用户数据库。没有管理员、会话、聊天记录或默认密码，首次使用在桌面完成管理员初始化。这个初始化接口只在内置桌面后端启用，并由每次启动随机桌面访问标识隔离外部客户端。

## 环境变量

`.env.example` 是网站及独立服务示例，不包含真实值。

| 配置 | 用途 |
| --- | --- |
| HOST / PORT | 默认127.0.0.1；服务端口 |
| DATABASE_PATH | 当前服务自己的SQLite路径 |
| SERVICE_MODE | website、chat；legacy用于旧入口兼容 |
| WEBSITE_BASE_URL | 软件联动的网站HTTP回环或HTTPS地址 |
| WEBSITE_EVENT_TOKEN | 网站授予的受限事件读取令牌 |
| ASTRBOT_CONFIG_FILE | 仅后端读取的JSON，baseUrl/chatToken/adminToken |
| ASTRBOT_BASE_URL / CHAT_TOKEN / ADMIN_TOKEN | 对应连接配置，令牌不发到前台 |
| TSUKIAKARI_DESKTOP_DATA | 桌面数据目录 |
| TSUKIAKARI_ASTRBOT_FILE | 桌面读取的私有AstrBot配置引用 |
| TSUKIAKARI_MODEL_FILE | 兼容旧独立模型模式的私有配置 |
| TSUKIAKARI_CHAT_SERVER_URL | 只连接已有HTTPS软件后端；默认本地 |
| PUBLIC_BASE_URL / COOKIE_SECURE | 独立部署时的正式地址与安全Cookie |
| TRUSTED_PROXIES | 仅填写实际可信代理IP/CIDR |

桌面通过「软件管理 → 服务与AI接入」保存连接时，经主进程safeStorage进行Windows加密，写入 `connection-credentials.json`；读取时只返回是否配置，不返回令牌。独立服务由环境变量持有配置时，该页面显示只读连接字段。旧模型菜单是兼容备用入口，配置AstrBot后优先使用AstrBot。

独立软件服务：`node server/chat-index.mjs`，需要自己的DATABASE_PATH和WEBSITE_BASE_URL。网站：设置SERVICE_MODE=website运行 `node server/index.mjs`。各自用 `pnpm admin:init` 初始化管理员；两个服务的管理员会话分别验证，密码不同时可由 `/api/chat/site/login` 单独连接网站。

## 关键软件接口

所有登录写接口校验真实会话、同源和CSRF，消息和媒体写入另使用Idempotency-Key。管理员不能因自己的角色直接读取他人私聊正文。

| 路径 | 权限与用途 |
| --- | --- |
| /api/chat/profile | 本人资料与版本控制 |
| /api/chat/users、friends、friend-requests | 搜索、申请、接受/拒绝/撤销 |
| /api/chat/threads/:id | 当前成员才能读取历史、发送、修改或退出 |
| /api/chat/invitations | 绑定邀请人、目标、群、有效期和离群版本 |
| /api/chat/threads/:id/ai | 当前成员邀请AI，移除需群主或邀请人 |
| /api/chat/memories | 本人记忆及共享/撤销 |
| /api/chat/admin/overview、groups、friends | 软件管理员元数据管理，不返回未加入会话的正文 |
| /api/chat/admin/service | 软件默认设置、受限连接；令牌只写不读 |
| /api/chat/admin/personas | 服务器人格列表、详情、创建、编辑、角色卡导入与待提交草稿 |
| /api/chat/preferences、notifications/claim | 个人通知设置与完整消息去重 |

网站接口及保存/同步规则见 [workroom-api.md](workroom-api.md)、[bot-api.md](bot-api.md)。

## AstrBot连接器

代码在 `bot/astrbot_plugin_hoshifuru/`。保留内部插件ID和 `/v2/*` 协议兼容既有服务器部署；产品名称更改不会新建或丢失旧AI会话。已联调AstrBot4.29.1。插件只绑定127.0.0.1:6199，通过可信网关或受限内网连接。

人格原生字段保存在AstrBot；图片、开场和扩展信息由服务器扩展库保存。写入以If-Match核验服务器版本，使用稳定操作ID，完成后回读。普通令牌不允许管理人格。

群会话稳定映射为 `hoshifuru:GroupMessage:<thread-id>_<ai-id>`；私聊用FriendMessage，真实发送者另带稳定用户ID、名称、消息ID和时间。记忆召回先按当前成员及共享范围过滤，再按文本相关性取有限数量。默认群记忆只在来源群，私聊记忆只用于本人AI私聊；用户可明确跨群共享或撤销。

每群每AI串行处理，整体最多4个范围并行；重启读取已完成结果，未完成付费调用不自动重复。成员/AI或授权变化提高持久化版本并停止旧上下文，版本化撤销可处理乱序和重复请求。

## 备份、恢复与回退

退出软件后备份整个数据目录，或运行 `pnpm backup:desktop` 生成各库一致性快照。不要运行中只复制SQLite主文件而漏掉WAL。恢复应到新目录，执行integrity_check和媒体校验，再用TSUKIAKARI_DESKTOP_DATA指向恢复目录。私有配置单独限制访问；Windows加密凭据跨账号或机器需重新配置。

回退前保留新数据库及整个配置目录。旧程序使用其原目录和协议；新产生的资料及设置不保证能被更老版本展示，但不得用旧种子覆盖当前库。建议在备份副本中验证回退。

云端备份应覆盖软件库、网站库及AstrBot原生/扩展库、插件、私有配置和部署配置。仓库提供SQLite在线快照及验证脚本，具体服务器路径与保留策略由实例自己配置，仓库不包含个人服务器记录。
