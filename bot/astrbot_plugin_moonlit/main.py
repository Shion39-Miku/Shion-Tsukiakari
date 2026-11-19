import asyncio
import contextlib
import json
import os
from pathlib import Path
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.star import Context, Star, register
from astrbot.api import logger
from .bridge import Bridge, BridgeError

HELP = '''月站指令：
/月站 查询 音乐|游戏|猫图 [关键词]
/月站 音乐 {"title":"歌名","artistName":"歌手","note":"寄语"}（附音频、可选封面/LRC）
/月站 游戏 {"title":"游戏名","genre":"分类","note":"寄语","description":"介绍"}（附Logo与1至5张图片）
/月站 提问 {"question":"内容","anonymous":true}
/月站 回复 <问题ID> 回复文字
/月站 发布答复 <问题ID>
/月站 同步 <草稿ID>
/月站 确认保存 <确认编号>；/月站 确认同步 <确认编号>
/月站 批次 <批次ID>；/月站 身份；/月站 确认重试提醒 <事件ID>
写入先生成待确认编号。模型建议不会自动执行。'''

@register('moonlit_site', 'Shion', '月下花笺网站接口与审核发布', '1.1.0')
class MoonlitSite(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        path=Path(os.environ.get('MOONLIT_BRIDGE_CONFIG','data/config/moonlit-bridge.json'))
        if not path.is_file(): raise BridgeError('请先创建服务端 moonlit-bridge.json；配置示例随插件提供')
        self.bridge=Bridge(json.loads(path.read_text(encoding='utf-8')))
        self.task=None
        self.chat_gateway=None
        self.chat_gateway_task=None

    async def initialize(self):
        self._start()

    @filter.on_astrbot_loaded()
    async def loaded(self):
        self._start()

    def _start(self):
        if self.task is None or self.task.done(): self.task=asyncio.create_task(self._poll_loop())
        if self.bridge.config.get('chat_gateway',{}).get('enabled') and self.chat_gateway_task is None:
            self.chat_gateway_task=asyncio.create_task(self._start_chat_gateway())

    async def _start_chat_gateway(self):
        from .chat_gateway import ChatGateway
        self.chat_gateway=ChatGateway(self.context,self.bridge.config['chat_gateway'])
        try:await self.chat_gateway.start()
        except Exception as error:logger.warning('独立聊天连接器未启动：%s',type(error).__name__)

    async def _poll_loop(self):
        while True:
            try:
                await self.bridge.poll(lambda target,text:self.context.send_message(target,MessageChain().message(text)))
            except asyncio.CancelledError: raise
            except Exception as error: logger.warning('月站提醒尚未确认：%s',type(error).__name__)
            await asyncio.sleep(max(3,int(self.bridge.config.get('poll_seconds',5))))

    async def terminate(self):
        if self.chat_gateway_task:
            self.chat_gateway_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):await self.chat_gateway_task
        if self.chat_gateway:await self.chat_gateway.close()
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):await self.task
        self.bridge.close()

    @staticmethod
    def _identity(event):
        platform=str(getattr(event.platform_meta,'id',''))
        sender=str(event.get_sender_id())
        if not platform or not sender:raise BridgeError('当前平台未提供可验证的账号身份')
        return platform+':'+sender

    @staticmethod
    def _text(event):
        parts=event.message_str.strip().lstrip('/').split(None,2)
        return parts[2] if len(parts)>2 else ''

    async def _attachments(self,event,category):
        files=[];images=0;audio=0;lyrics=0
        for component in event.get_messages():
            if type(component).__name__!='File':continue
            path=await component.get_file()
            name=str(getattr(component,'name','') or Path(path).name)
            suffix=Path(name).suffix.lower()
            if suffix in ('.mp3','.wav','.ogg','.opus'):
                field='audio';kind='audio';audio+=1
            elif suffix in ('.lrc','.txt'):
                field='lyricsFile';kind='lyrics';lyrics+=1
            elif suffix in ('.png','.jpg','.jpeg','.webp'):
                field='cover' if category=='music' else 'logo' if images==0 else 'images';kind='image';images+=1
            else:raise BridgeError('附件仅支持音频、LRC/TXT或JPEG/PNG/WebP，请以文件附件发送')
            files.append({'field':field,'kind':kind,'name':name,'path':path})
        if audio>1 or lyrics>1 or (category=='music' and images>1) or (category=='games' and (images>6 or audio or lyrics)):
            raise BridgeError('音乐最多1个音频、封面及歌词；游戏为1张Logo及1至5张介绍图片')
        return files

    async def _dispatch(self,event,operation):
        if hasattr(event,'stop_event'):event.stop_event()
        try:
            raw=self._text(event);identity=self._identity(event);origin=str(event.unified_msg_origin)
            message_id=str(getattr(event.message_obj,'message_id',''))
            if operation=='帮助':return HELP
            if operation=='身份':return '已验证平台身份：'+identity+'\n当前会话：'+origin
            if operation=='查询':
                parts=raw.split(None,1);category={'音乐':'music','游戏':'games','猫图':'cats','猫猫图':'cats'}.get(parts[0] if parts else '',parts[0] if parts else '')
                items=await self.bridge.catalog(category,parts[1] if len(parts)>1 else '')
                return '\n\n'.join((item.get('title') or '猫猫图')+'\n'+item['url'] for item in items) or '月下暂时没有找到这份收藏。'
            self.bridge.authorize(identity)
            if not message_id:raise BridgeError('平台未提供消息ID，不能可靠去重写入请求')
            if operation in ('确认保存','确认同步'):
                result=await self.bridge.confirm(identity,origin,raw.strip(),publish=operation=='确认同步')
                item=result.get('item',{});batch=result.get('batchId') or item.get('batchId') or result.get('draft',{}).get('batchId')
                draft=result.get('id') if result.get('category') else item.get('draftId')
                return ('同步完成，刷新网站查看。' if operation=='确认同步' else '已保存，待同步。')+'\n'+('草稿：'+str(draft)+'\n' if draft else '')+('批次：'+batch if batch else '')
            if operation=='批次':
                batch=await self.bridge.batch(identity,raw.strip())
                return '批次 '+batch['batchId']+'\n新增：'+('、'.join(item['title'] for item in batch['newItems']) or '无')+'\n更新：'+('、'.join(item['title'] for item in batch['updatedItems']) or '无')
            if operation=='确认重试提醒':
                self.bridge.retry_notification(identity,int(raw.strip()));return '已恢复提醒重试；如上一条已送达，可能再次收到同一事件，请按事件ID核对。'
            attachments=[]
            if operation in ('音乐','游戏'):
                fields=json.loads(raw);kind='music' if operation=='音乐' else 'games';attachments=await self._attachments(event,kind)
                payload={'fields':fields};
            elif operation=='提问':kind='question';payload=json.loads(raw)
            elif operation=='回复':
                ident,reply=raw.split(None,1);current=await self.bridge.question(identity,ident);kind='reply';payload={'id':ident,'reply':reply,'version':current['version']}
            elif operation=='发布答复':
                current=await self.bridge.question(identity,raw.strip());kind='publish'
                if not current.get('reply','').strip() or not current.get('draftId'):raise BridgeError('请先通过回复指令保存答复草稿')
                payload={'id':current['id'],'version':current['version']}
            elif operation=='同步':
                current=await self.bridge.draft(identity,raw.strip());kind='sync';payload={'id':current['draftId'],'version':current['version']}
            else:return HELP
            if not isinstance(payload,dict):raise BridgeError('请提供JSON对象')
            ident=self.bridge.propose(identity,origin,message_id,kind,payload,attachments)
            action='确认同步' if kind in ('sync','publish') else '确认保存'
            summary=json.dumps(payload,ensure_ascii=False)[:2200]
            if attachments:summary+='\n附件：'+'、'.join(item['name'] for item in attachments)
            return '已记录待确认操作，尚未写入或发布网站。\n'+summary+'\n请核对内容后发送：/月站 '+action+' '+ident
        except (BridgeError,ValueError,KeyError) as error:return '月站：'+str(error)
        except Exception as error:
            logger.warning('月站操作失败：%s',type(error).__name__)
            return '月站：连接暂时未完成，已保留确认编号与上传进度，可用同一编号重试。'

    @filter.command_group('月站')
    def moonlit(self):pass

    @moonlit.command('帮助')
    async def help(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'帮助'))
    @moonlit.command('身份')
    async def identity(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'身份'))
    @moonlit.command('查询')
    async def query(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'查询'))
    @moonlit.command('音乐')
    async def music(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'音乐'))
    @moonlit.command('游戏')
    async def game(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'游戏'))
    @moonlit.command('提问')
    async def question(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'提问'))
    @moonlit.command('回复')
    async def reply(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'回复'))
    @moonlit.command('发布答复')
    async def publish(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'发布答复'))
    @moonlit.command('同步')
    async def sync(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'同步'))
    @moonlit.command('确认保存')
    async def confirm_save(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'确认保存'))
    @moonlit.command('确认同步')
    async def confirm_sync(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'确认同步'))
    @moonlit.command('批次')
    async def batch(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'批次'))
    @moonlit.command('确认重试提醒')
    async def retry(self,event:AstrMessageEvent):yield event.plain_result(await self._dispatch(event,'确认重试提醒'))
