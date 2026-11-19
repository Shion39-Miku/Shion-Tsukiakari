# Bot HTTP API v1

本机及服务器内部地址 `http://127.0.0.1:4173`，路由前缀 `/api/v1`，使用 `Authorization: Bearer <token>`。正式对外分享地址为 `https://shion.wiki`。AstrBot 插件与配置方式见 [Bot 接入说明](../bot/README.md)，实际聊天平台账号尚需配置；平台校验发送同步指令的管理员身份后，才能使用审核／同步权限。

## 环境变量与权限

用 `node -p "require('node:crypto').randomBytes(32).toString('base64url')"` 生成随机令牌。将不同角色的定义写入 `.env` 的一行 `BOT_TOKENS` JSON 数组，重启服务生效：

```dotenv
BOT_TOKENS=[{"id":"writer","token":"REPLACE_WITH_RANDOM_WRITE_TOKEN","scopes":["music:write","games:write","batches:read"]},{"id":"reviewer","token":"REPLACE_WITH_RANDOM_REVIEW_TOKEN","scopes":["content:sync","questions:review","batches:read"]},{"id":"listener","token":"REPLACE_WITH_RANDOM_LISTEN_TOKEN","scopes":["catalog:read","events:read","events:ack"]}]
```

上面是结构示例，必须替换成各自生成的 32—256 位随机令牌，未替换或长度不足会校验失败。不得把真实密钥提交到代码仓库。

| 权限 | 能力 |
| --- | --- |
| catalog:read | 查询已同步音乐／游戏／猫图及公开歌手 |
| music:write／games:write | 写入对应类别的私有草稿，不能自动发布 |
| content:sync | 审核并同步音乐和游戏草稿，可读取这些草稿与批次 |
| batches:read | 查询自己的上传批次；有 content:sync 时可查询音乐／游戏的其他批次 |
| questions:submit | 投稿，进入待处理状态 |
| questions:review | 读取待处理问题、保存回复、明确确认同步发布 |
| events:read | 拉取问题创建与公开内容同步事件，包含私有待处理问题 |
| content-events:read | 只拉取 content.synced，不读取私有问题 |
| events:ack | 确认已处理的事件游标 |

猫图、背景音乐、站点设置、角色和文字仅可由后台管理。Bot 不可读访客日志和审计日志。相同 Bot id 更换令牌可续用其确认游标。

## 查询并分享

`GET /api/v1/catalog/{music,games,cats}?limit=20&offset=0` 返回 `{items,nextOffset}`。音乐可传 artistId，游戏可传 genre 精确筛选。`GET /api/v1/catalog/{category}/{id}` 返回完整详情，`GET /api/v1/artists` 返回已有公开歌手。公开查询仅使用已同步数据，不包含私有草稿或只在草稿中使用的歌手。

条目含 id、title（猫图除外）、createdAt、demo、version、前台 url，以及封面／音频／游戏图片等媒体信息。媒体含 id、version、mime、size、width、height、url、thumbnail、previews、srcset。列表不读取原始媒体块或歌词；详情按需读取。音频支持 `Range: bytes=0-1023`、206 和拖动进度。公开链接优先使用 PUBLIC_BASE_URL，否则使用本机请求 origin。

## 保存音乐／游戏草稿

`POST /api/v1/music` 与 `POST /api/v1/games` 保存私有草稿，需要 Idempotency-Key（8—128 位字母、数字、横线或下划线）。相同角色、相同键与相同请求重试返回一致结果，不重复创建；不同内容复用同一键返回 409。

可直接使用 multipart/form-data：

| 类别 | 文字字段 | 文件字段 |
| --- | --- | --- |
| music | title 必填100、note 必填500；translation100；artistId 或新 artistName80；producer80 或已有 producerId；lyricist80；lyrics24000；可选 coverId 复用已有封面 | audio 必填；cover、artistImage、lyricsFile 可选。已有歌手与 artistImage 不可同时传 |
| games | title 必填100、genre 或 genreId 必填48、note 必填500、description 必填6000，translation100 | logo 必填，images 同名传 1—5 张 |

音频为有效 MP3／PCM WAV／Opus 或 Vorbis Ogg，最多 **100,000,000 字节（包含等于上限）**。静态 JPEG／PNG／WebP 单张最多 8 MiB、2400 万像素。歌词为 UTF-8 .lrc／.txt，最多 64 KiB，和文字 lyrics 二选一。单次 multipart 总请求最多 150,000,000 字节；生产 Nginx 请求体预留为 160m，后端仍严格限制单个音频，客户端及代理超时 900 秒。

推荐先逐文件调用 `POST /api/v1/files`，multipart 字段 `kind=audio|image|lyrics` 和 `file`，附独立 Idempotency-Key；返回 201 `{item:{id,mime,size,sha256,url,...}}`。客户端据实际发送字节显示各文件和整体进度，传输结束等待数据库保存；随后用这些 ID 提交下面的 JSON 草稿。文件保持私有，保存草稿不会自动发布。图片需要 music:write 或 games:write；音频和歌词必须 music:write。不接受 JSON 中的本地路径或伪造文件对象。列表查询不读取二进制；详情同时提供原歌词媒体地址 `lyricsSource` 及 `timedLyrics`。

```powershell
curl.exe -X POST 'http://127.0.0.1:4173/api/v1/music' `
  -H "Authorization: Bearer $env:BOT_WRITE_TOKEN" `
  -H 'Idempotency-Key: upload-song-001' `
  -F 'title=月色练习曲' -F 'note=一段夜间练习' -F 'artistName=夜灯' `
  -F 'audio=@C:/music/sample.wav'
```

已有媒体也可通过 JSON 复用：

```json
{"fields":{"title":"新曲","note":"复用已有素材","artistId":"<已有歌手UUID>","producerId":"<已有P主UUID>","coverId":"<已有公开图片UUID>"},"files":{"audio":["<已有音频UUID>"]}}
```

更新已有内容时，同一路由传 JSON 顶层 objectId，fields.version 为编辑版本；文件可省略以保留已有媒体。游戏可传 keepImages 的 JSON 字符串选择保留的原图；新图追加，最终 1—5 张。没有改歌词时保留歌词及来源引用。`GET /api/v1/drafts?category=music`（或 games）可取自己的草稿；有 content:sync 时可查看同类全部草稿。

保存返回 201：`{id,objectId,category,version,state:"draft",batchId,item,batch}`。id 为稳定草稿 ID，objectId 为内容 ID。此时没有对访客开放的前台分享链接，媒体仍需管理员或获授权 Bot 读取，匿名请求被拦截。

## 明确同步发布

需要 content:sync，且仅支持音乐和游戏：

```http
POST /api/v1/drafts/<draftId>/sync
Authorization: Bearer <reviewer-token>
Content-Type: application/json

{"version":1}
```

同步校验已保存版本，成功才原子更新公开内容、媒体权限、批次、审计及内容事件。后台页面使用完全相同的校验和发布逻辑。未知或过期的未发布版本返回 409。已完成的版本重试返回原同步结果，不重复发事件，也不会误同步另一份新草稿。已删除内容的重试返回 410，不能恢复记录。

## 本次新增／更新清单

`GET /api/v1/batches/<batchId>` 返回批次。每次成功保存生成新的稳定 batchId；相同保存请求重试保持同一个 batchId。

```json
{"batchId":"<UUID>","state":"draft","newItems":[{"id":"<内容ID>","draftId":"<草稿ID>","category":"music","title":"新曲","operation":"new","state":"draft","result":"success","version":1,"createdAt":"<ISO时间>"}],"updatedItems":[],"materials":[{"kind":"artist","id":"<已有署名ID>","name":"夜灯","reused":true}]}
```

更新放在 updatedItems，复用封面／歌手／P主／分类列为 materials，不计入新增内容。同步后清单状态变为 synced，并附前台 url。旧草稿被再次保存替代时，旧批次项标记 superseded；删除标记 deleted。Bot 可据此回答「本次新增了哪些内容，更新了哪些内容」。

## 问题事件与回复

访客 `POST /api/public/questions`；Bot 使用 `POST /api/v1/questions`（questions:submit）及 Idempotency-Key，JSON `{question,author?,anonymous?}`。问题最多1200、署名40字符；空署名或 anonymous:true 为匿名。成功 `{id,state:"pending",message:"已收到，等待回复"}`，问题和事件同事务创建。

审核角色 `GET /api/v1/questions?state=pending` 或 published。先 `PUT /api/v1/questions/<id>/draft`，JSON `{reply,version?}` 保存私有回复（最多2400）；再 `POST /api/v1/questions/<id>/sync`，JSON `{version:<已保存版本>}` 明确发布。发布必须非空。兼容 `/publish` 的明确发布命令，带 reply 时内部也先保存再同步；普通投稿和 draft 接口始终不会发布。

首页和提问箱共用同一份已同步问答。删除保留墓碑并移除问题／署名／答复，重复投稿或发布不能恢复。

## 事件拉取与确认

`GET /api/v1/events?limit=30&after=0`，响应 `{items,nextCursor,acknowledgedThrough,hasMore}`。省略 after 则从该 Bot 已确认游标继续。事件 id 为稳定递增整数，重拉可用它去重：

- question.created：questionId、createdAt、当前 state，未删除时含署名和问题；仅 events:read 可读。
- content.synced：同步成功后产生，包含 batchId、newItems、updatedItems、materials 及已发布的前台链接。只保存草稿不会产生此事件，重复同步不会重复产生。

平台提醒成功后 `POST /api/v1/events/ack`，JSON `{"through":123}`。游标只前进；只读公开内容通知的令牌不能确认未获授权的问题事件。每个 Bot 的游标独立。

错误格式 `{error:{code,message}}`，常见 400／401／403／404／409／410／413／415／429／503。429 附 Retry-After。服务重启后内容、草稿、文件、批次、事件与确认位置均保留。

`pnpm bot:demo` 在临时数据库和随机令牌上跑通网页投稿、事件拉取、回复草稿、明确同步、两个前台页面一致、音乐新增／更新批次、内容通知去重及确认，无需实际聊天平台。

公开更新：后台与 Bot 同步使用同一份 batches/batch_items，成功同步后批次详情含 syncedAt。首页 `/api/public/releases` 以 batchId 去重，公开内容批次与 `content.synced` 的 batchId 一致。保存时间 createdAt 与实际发布时间 syncedAt 分开；重复同步不重新计时或新增通知。草稿仅在获授权的后台／Bot 接口可读。
