import asyncio
import json
import sys
import uuid
from pathlib import Path
import urllib.request
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from bot.astrbot_plugin_moonlit.bridge import Bridge,BridgeError

async def main(config):
    bridge=Bridge(config);base=config['api_base'];identity='test-platform:admin';origin=config['reminder_targets'][0]
    def public(path,payload=None):
        body=json.dumps(payload).encode() if payload is not None else None
        request=urllib.request.Request(base+path,data=body,headers={'Content-Type':'application/json','Idempotency-Key':str(uuid.uuid4())} if body else {})
        with urllib.request.urlopen(request,timeout=30) as response:return response.read()
    def data(path):return json.loads(public(path))
    try:
        try:bridge.propose('test-platform:impostor',origin,'bad','question',{'question':'拒绝'})
        except BridgeError:pass
        else:raise AssertionError('unauthorized identity accepted')
        question=json.loads(public('/api/public/questions',{'question':'网页投稿到Bot提醒验收','anonymous':True}))
        delivered=[]
        async def send(target,text):delivered.append((target,text))
        assert (await bridge.poll(send))['sent']==1
        assert (await bridge.poll(send))['sent']==0
        assert len(delivered)==1 and question['id'] in delivered[0][1]
        current=await bridge.question(identity,question['id'])
        operation=bridge.propose(identity,origin,'reply-1','reply',{'id':current['id'],'reply':'Bot管理员明确确认的回信','version':current['version']})
        assert len(data('/api/public/questions')['items'])==0
        try:await bridge.confirm(identity,'wrong-origin',operation)
        except BridgeError:pass
        else:raise AssertionError('cross-session confirmation accepted')
        reply=await bridge.confirm(identity,origin,operation)
        assert len(data('/api/public/questions')['items'])==0
        current=await bridge.question(identity,question['id'])
        publish=bridge.propose(identity,origin,'publish-1','publish',{'id':current['id'],'version':current['version']})
        await bridge.confirm(identity,origin,publish,publish=True)
        assert len(data('/api/public/questions')['items'])==1
        for path in ('/','/questions'):
            html=public(path).decode();raw=html.split('<script id="page-data" type="application/json">',1)[1].split('</script>',1)[0]
            assert json.loads(raw)['questions'][0]['reply']=='Bot管理员明确确认的回信'
        print('通过：网页投稿 → 模拟提醒目标仅收一次 → 同账号同会话确认回复及发布 → 两页一致',flush=True)
        root=Path(config['state_path']).parent
        attachments=[{'path':str(root/'demo.wav'),'name':'demo.wav','kind':'audio','field':'audio'},{'path':str(root/'demo.lrc'),'name':'demo.lrc','kind':'lyrics','field':'lyricsFile'}]
        create=bridge.propose(identity,origin,'music-1','music',{'fields':{'title':'Bot桥接演示曲','artistName':'桥接演示歌手','note':'确认后才上传；另一次确认才同步'}},attachments)
        assert data('/api/public/music')['items']==[]
        saved=await bridge.confirm(identity,origin,create)
        assert saved==await bridge.confirm(identity,origin,create)
        assert saved['batch']['newItems'][0]['title']=='Bot桥接演示曲'
        assert data('/api/public/music')['items']==[]
        current=await bridge.draft(identity,saved['id'])
        sync=bridge.propose(identity,origin,'sync-1','sync',{'id':current['draftId'],'version':current['version']})
        published=await bridge.confirm(identity,origin,sync,publish=True)
        assert published==await bridge.confirm(identity,origin,sync,publish=True)
        batch=await bridge.batch(identity,saved['batchId']);assert len(batch['newItems'])==1 and len(batch['updatedItems'])==0
        found=await bridge.catalog('music');assert found[0]['url'].startswith('https://shion.wiki/music?id=')
        assert (await bridge.poll(send))['sent']==1
        assert (await bridge.poll(send))['sent']==0
        assert saved['batchId'] in delivered[-1][1]
        assert data('/api/public/releases')['items'][0]['batchId']==saved['batchId']
        print('通过：Bot附件独立上传 → 私有草稿 → 明确确认同步 → 正式域名链接、批次清单和通知去重',flush=True)
        public('/api/public/questions',{'question':'发送结果不确定时保留事件','anonymous':True})
        async def fail(target,text):raise TimeoutError()
        try:await bridge.poll(fail)
        except BridgeError:pass
        else:raise AssertionError('ambiguous send was not retained')
        assert (await bridge.poll(send))['sent']==0
        eid=bridge.db.execute("SELECT event_id FROM deliveries WHERE state='uncertain'").fetchone()[0]
        bridge.retry_notification(identity,eid)
        assert (await bridge.poll(send))['sent']==1
        bridge.close();bridge=Bridge(config)
        assert (await bridge.poll(send))['sent']==0
        assert await bridge.confirm(identity,origin,create)==saved
        print('通过：发送失败保留游标、人工确认重试、重启后提醒与操作去重',flush=True)
    finally:bridge.close()

asyncio.run(main(json.load(sys.stdin)))
