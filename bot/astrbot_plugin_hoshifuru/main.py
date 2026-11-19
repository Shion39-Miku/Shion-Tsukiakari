import json
from pathlib import Path
from astrbot.api.star import Context, Star, register
from astrbot.api import logger
from .gateway import Gateway


@register("hoshifuru", "Shion", "月明かり受限接口与隔离会话", "0.3.0")
class Hoshifuru(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        self.gateway = None

    async def initialize(self):
        path = Path("data/config/hoshifuru-bridge.json")
        if not path.is_file():
            logger.warning("月明かり：服务端连接配置缺失，连接器未启动")
            return
        self.gateway = Gateway(self.context, json.loads(path.read_text("utf-8")))
        await self.gateway.start()

    async def terminate(self):
        if self.gateway:
            await self.gateway.close()
