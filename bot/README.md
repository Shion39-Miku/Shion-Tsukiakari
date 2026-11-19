# 月站 Bot 桥接

`astrbot_plugin_moonlit` 使用AstrBot4的事件、指令组和主动消息接口，协议核心bridge.py只用Python标准库，无模型依赖。本次已安装到预载 AstrBot **4.29.1**，插件启动加载及与正式网站 API 的连接已验证。实际目录为 `/var/lib/astrbot/data/plugins/astrbot_plugin_moonlit`，配置 `/var/lib/astrbot/data/config/moonlit-bridge.json`，状态 `/var/lib/astrbot/data/moonlit-site`。详细结果见 [上线交付记录](../docs/deployment-report-20261113.md)。

## 权限与配置

把插件目录安装到实际AstrBot的data/plugins中；将config.example.json复制到实际服务端data/config/moonlit-bridge.json，设置路径、令牌、allowlist和提醒目标。也可用MOONLIT_BRIDGE_CONFIG指定受限配置文件。令牌通过服务端文件提供，不出现在指令、模型上下文或源码中。

四个独立网站Bot令牌推荐权限：

| 角色 | 权限 |
|---|---|
| reader | catalog:read |
| writer | music:write、games:write、questions:submit |
| reviewer | content:sync、questions:review、batches:read |
| notifier | events:read、events:ack |

每个实例使用不同Bot ID，避免共用通知游标。admin_identities格式为`平台实例ID:发送者账号ID`，值从平台已验证的event.platform_meta.id及event.get_sender_id取得，不能用昵称、聊天正文或模型判断。`/月站 身份`显示当前真实身份和会话，管理员在服务端填入允许列表。reminder_targets由服务器配置，只向这些管理员目标发送私有问题；默认空列表不发提醒。

宿主机使用127.0.0.1:4173；Docker需实际受限内部代理，不能将内部地址误作分享链接。网站PUBLIC_BASE_URL在生产设置为https://shion.wiki。

## 指令

- `/月站 查询 音乐|游戏|猫图 [关键词]`：只读已同步内容与正式分享链接。
- `/月站 音乐 {"title":"歌名","artistName":"歌手","note":"寄语"}`：与音频文件附件一起发送，可附封面与LRC/TXT；歌手可改为已有artistId。
- `/月站 游戏 {"title":"游戏名","genre":"类型","note":"寄语","description":"完整介绍"}`：附Logo和1至5张介绍图。
- `/月站 提问 {"question":"问题","anonymous":true}`：进入待处理。
- `/月站 回复 <问题ID> 回复文字`：提出答复草稿。
- `/月站 发布答复 <问题ID>`：请求将已保存答复同步。
- `/月站 同步 <草稿ID>`：请求发布音乐或游戏草稿。
- `/月站 确认保存 <确认编号>`、`/月站 确认同步 <确认编号>`：在核对展示内容后明确执行；仅原管理员和原会话可确认，24小时过期。
- `/月站 批次 <批次ID>`：区分新增、已有更新与复用材料。
- `/月站 确认重试提醒 <事件ID>`：管理员核实不确定发送结果后恢复重试。

附件当前使用平台的File组件，请以文件方式发送。附件只能来自已配置的Bot下载根目录，先私有保留，确认后逐个上传到/api/v1/files，再将媒体ID提交到网站草稿；音频上限精确为100,000,000字节。每文件使用稳定幂等键，网络失败保留确认和已完成媒体ID。网站草稿成功后删除本地传输副本。

任何写入都先形成待确认操作；没有可由模型直接调用的写入工具。确认保存不会发布，确认同步是另一条独立指令。游戏、音乐与回复仍由网站服务端校验权限、版本与发布规则。猫图和背景音乐不能由Bot写入。

## 提醒语义

SQLite保存操作、批次确认和发送记录，网站保存稳定事件ID及确认游标。问题按questionId、更新按batchId及目标去重，只有全部目标送达并落库才确认事件。API临时失败自动重拉，不提前推进游标。

拉取到已经发布或删除的问题会跳过提醒，避免重连后把已处理记录当作新待办。当前实际服务器尚未接入聊天平台，因此真实管理员身份及提醒目标保持空列表；不会根据昵称或模型输出擅自授权。接入平台后用「月站 身份」取得已验证的身份与会话值，再由服务器配置管理员允许列表和提醒目标并重启 `astrbot.service`。人格保持原样，后续由站长提供。

跨聊天平台的发送和本地数据库不能组成同一个事务。发送超时或进程在发送中断时标记uncertain，不自动重复发给管理员；保留网站游标，管理员核实后可用确认重试提醒指令重发。这样不会把结果不明的发送冒充为可靠的“恰好一次”。

## 本地联调

`pnpm bot:bridge-demo` 启动独立临时网站和Python桥接，使用随机令牌与模拟提醒目标，验证：

1. 网页投稿 → 提醒只收一次 → 同账号同会话确认回复 → 确认发布 → 首页和提问箱同一记录。
2. Bot音频/LRC分别上传 → 私有草稿 → 另一次明确确认同步 → 公开查询正式域名链接 → 本批次新增清单和通知去重。
3. 冒名账号与跨会话确认拒绝；重复确认一致；发送结果不明保留游标；人工恢复重试；重启后仍去重。

Python默认取Codex本地捆绑的3.12，其他机器可设置PYTHON_BIN。人格配置不在本次插件中，后续由站长提供。

官方接口依据：[AstrBot插件开发文档](https://docs.astrbot.app/dev/star/plugin-new.html)、[AstrBot插件安装](https://docs.astrbot.app/use/plugin.html)。现场已核对安装版本的 SDK、插件加载日志和原有 DeepSeek 模型连通；真实聊天平台回调身份须在提供平台账号后验证。
