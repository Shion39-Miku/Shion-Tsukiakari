# 后台、草稿与实时接口

本机 origin 默认 `http://127.0.0.1:4173`。所有 `/api/admin/`（登录除外）要求管理员会话；写请求还须 X-CSRF-Token 并校验同源。Bot 使用独立的 `/api/v1`，不能调用后台日志、配置或角色接口。

## 三个操作

- 还原修改：浏览器恢复最近保存草稿；未保存的新建表单恢复初始值。
- 保存修改：上传必要文件，提交私有草稿与新批次，返回「已保存，待同步」。不修改公开版本。
- 同步修改：只同步指定已保存版本，更新公开数据、媒体权限、批次、审计与事件。存在未保存编辑时前端提示先保存，服务端验证版本。成功显示「同步完成，刷新前台查看」。

删除须在后台确认，成功后直接删除公开内容并标记草稿和批次；永久墓碑阻止旧请求恢复音乐、游戏、猫图或问题。背景音乐删除后允许另存并同步新曲，不回退旧曲。

| 路由 | 用途 |
| --- | --- |
| POST /api/admin/login | JSON username／password；返回 username／csrf 并设置 HttpOnly Cookie |
| GET /api/admin/session | 校验会话 |
| POST /api/admin/logout | 注销 |
| POST /api/admin/files | multipart：kind=image／audio／lyrics，file 单文件；Idempotency-Key 必须；只暂存私有媒体 |
| GET /api/admin/materials?kind=artists／producers／covers／genres&q=关键词 | 搜索可复用素材，图片含预览；不读取原图数据块 |
| GET /api/admin/content/{music,games,cats} | 合并已同步内容与草稿的后台列表，带状态 |
| GET /api/admin/content/{category}/{id} | 最新编辑基准，优先保存草稿；包含 version／draftId／batchId |
| POST /api/admin/uploads/{music,games,cats,background} | 保存新草稿；支持 multipart 或 JSON fields／files；Idempotency-Key 必须 |
| PUT /api/admin/content/{category}/{id} | 保存已有内容草稿，须 version 与 Idempotency-Key |
| DELETE /api/admin/content/{category}/{id} | 删除公开内容及草稿 |
| GET /api/admin/background | 获取背景音乐草稿或已同步基准 |
| DELETE /api/admin/background | 移除背景音乐 |
| GET /api/admin/settings | 返回 item（最新编辑基准）、published（已同步配置）、fields（文字字段注册表） |
| PUT /api/admin/settings | 保存配置草稿，字段 version、patch JSON，新图片 asset0 等；支持独立上传后的 files 引用 |
| GET /api/admin/drafts?category=music | 草稿列表，其他类别同理 |
| GET /api/admin/drafts/{draftId} | 完整草稿和批次 |
| POST /api/admin/drafts/{draftId}/sync | JSON version，同步保存版本 |
| GET /api/admin/batches/{batchId} | 本次新增／更新／关联素材清单 |
| GET /api/admin/questions?state=pending 或 published | 分组审核列表；私有草稿回复仅此类获授权接口可见 |
| PUT /api/admin/questions/{id}/draft | JSON reply／version，保存草稿 |
| POST /api/admin/questions/{id}/sync | JSON version，明确发布；兼容 publish 命令 |
| DELETE /api/admin/questions/{id} | 删除及墓碑 |
| GET /api/admin/logs/visitors | 分页访客日志 |
| GET /api/admin/logs/modifications | 分页修改记录，含 batch_id |

独立文件上传返回媒体 ID；随后保存请求可为：

```json
{"fields":{"version":"1","title":"新歌名","note":"月下寄语","artistId":"<署名ID>"},"files":{"audio":["<已上传媒体ID>"],"lyricsFile":["<LRC媒体ID>"]}}
```

前端使用每文件独立 XHR 和整体字节进度；文件选中或解析时不上传。成功暂存文件可在失败重试时复用，未提交为公开内容前始终私有。文本、引用、草稿、批次与成功审计原子保存；同步时再次验证数据和基准版本。相同请求重试保持批次和对象 ID；相同键的不同内容为409。未知或冲突草稿版本为 draft_conflict；删除后为410。

音乐／游戏字段和大小限制见 [Bot API](bot-api.md)。未替换媒体时保留原引用。游戏 keepImages 是保留原图 ID 数组的 JSON 字符串，最终 1—5 张。图片原件与多尺寸预览均在数据库中，srcset／sizes 由前端按布局选择，预览 URL 带版本。

设置 patch 支持 name、englishName、heroTitle、heroCredit、demoLabel、motto、socials、heroMediaId、logoMediaId、about、characters、texts。about 含自我介绍、喜好、近况、建站缘由和展示图；角色固定 shion／zhiyao，每组最多8张图，含 name、alias、role、summary、appearance、world、human、divine、images。图片项 `{mediaId,label}`，新图片写 file:asset0 对应上传字段；每次最多8张新文件。

## 日志

参数 page（从1开始）、limit（1—100，默认30）、from／to（ISO时间）、type（事件／修改动作）、path（页面路径或内容类别），返回 items／total／page／pages。修改动作包括 file.upload、draft.save、draft.sync、delete，旧版操作保留。成功文件上传记录在草稿保存后关联到批次，失败只记录错误码，不记录敏感输入。

## 公开配置、图片与 SSE

GET /api/public/site 只返回已同步配置；其他 public 内容接口只读取已同步表。未同步媒体即使知道 URL 也需管理员或获授权 Bot，匿名不可读取。原件和预览均支持 GET／HEAD，原图按需载入，范围请求返回206。

GET /api/public/updates 保留轻量 SSE。ready 表示重校验，changes 的数据只含 revision 与 topics。保存草稿不会发公开配置／内容更新，只有同步和删除后公开版本变化；刷新、重连或恢复焦点都读取已同步数据。首页与提问箱共享同一份问答记录，消息不含私有文本或密钥。

## 匿名行为采集

POST /api/public/activity 接受同源 JSON：page.enter 包含 segmentId、path、entryPath、可选 referrer／channel；heartbeat 包含 segmentId、visibleMs、hidden、ended；功能事件含 type、segmentId、eventId、targetId。ID 为 UUID，首次访问设置随机 HttpOnly Cookie，数据库只存摘要。

30秒同访客同页原子合并，网络重试不增加次数；不同页面与独立行为保留。可见状态才累计时间，15秒心跳，结束尽力补报；异常断开标为最后心跳估算。来源未知如实显示，渠道参数注明访客提供，Referer只留域名。采集有独立限流，失败不影响浏览或播放。

## 全局操作栏与公开更新（004）

`GET /api/admin/drafts` 不带 category 时返回全部类别，待同步项为 status=draft。后台一条置顶栏统一还原／保存／同步，切换栏目保留未保存字段。保存先检查全部已编辑表单，失败展开对应栏目并定位；未触碰的空白新增表单不参与。三个配置栏目依次合并到同一个配置草稿，并复用本次操作已取得的版本号。存在其他窗口的版本变化仍返回409。

`POST /api/admin/drafts/sync-all` 需管理员会话、同源及 CSRF：

```json
{"items":[{"id":"<draftId>","version":2},{"id":"<anotherDraftId>","version":1}]}
```

一次最多200项，拒绝重复草稿 ID。所有草稿重新校验；公开内容、媒体权限、批次状态、Bot事件、审计在一个事务内一起提交或回滚。重复已完成版本保持原结果。返回 `{items:[<同步结果>...]}`。该路由不向 Bot 开放，Bot 仍按原有权限单项同步。

背景音乐保存使用 `POST /api/admin/uploads/background`，字段 `version` 与 `volume`（0—1字符串，例如 `"0.05"`），无新音频则复用已有音频。后台百分比转换为该字段；读取 `/api/admin/background` 的 item.volume 为数字。`GET /api/public/background` 仅返回已同步音量，不暴露未同步修改。

`GET /api/public/releases` 返回最多8个公开更新批次，按实际同步时间倒序：

```json
{"items":[{"batchId":"<UUID>","publishedAt":"<ISO同步时间>","summary":"新增音乐","newItems":[{"id":"<UUID>","category":"music","title":"新曲","url":"/music?id=<UUID>"}],"updatedItems":[]}]}
```

以 batchId 去重，与 Bot 的 content.synced.batchId 相同。只有 synced 批次及 synced 清单项可见；不返回草稿、后台身份、私有媒体、问题正文或未公开回复。已删除内容对应清单移除。批次详情增加 syncedAt（保存草稿时为 null）。首页在 SSE、重连与焦点恢复时局部重读，播放器与页面位置保留。

访客日志增加 country／province／city／location_kind（estimated、unknown、local）；依照 README 的 TRUSTED_PROXIES 规则取 IP。原有来源、心跳停留、事件、分页、保留期限和30秒去重不变。
