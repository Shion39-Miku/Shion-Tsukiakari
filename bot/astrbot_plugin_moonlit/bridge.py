"""Website bridge: no model dependency, no automatic writes, durable confirmations/outbox."""
from __future__ import annotations
import asyncio
import hashlib
import http.client
import json
import os
import shutil
import sqlite3
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlencode

AUDIO_LIMIT = 100_000_000

class BridgeError(Exception):
    pass

class SiteClient:
    def __init__(self, base_url, token):
        self.base = urlsplit(base_url.rstrip('/'))
        if self.base.scheme not in ('http', 'https') or not self.base.hostname or self.base.username or self.base.query or self.base.fragment:
            raise BridgeError('网站内部接口地址无效')
        self.token = token

    def _connection(self):
        cls = http.client.HTTPSConnection if self.base.scheme == 'https' else http.client.HTTPConnection
        conn = cls(self.base.hostname, self.base.port, timeout=10)
        conn.connect()
        conn.sock.settimeout(900)
        return conn

    def _path(self, path):
        if not path.startswith('/') or path.startswith('//') or '\r' in path or '\n' in path:
            raise BridgeError('接口路径无效')
        return self.base.path.rstrip('/') + '/api/v1' + path

    def request(self, path, method='GET', data=None, key=None):
        body = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
        headers = {'Authorization': 'Bearer ' + self.token}
        if body is not None: headers['Content-Type'] = 'application/json'
        if key: headers['Idempotency-Key'] = key
        conn = self._connection()
        try:
            conn.request(method, self._path(path), body=body, headers=headers)
            return self._response(conn)
        finally:
            conn.close()

    @staticmethod
    def _response(conn):
        response = conn.getresponse()
        raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024: raise BridgeError('网站返回内容过大')
        try: result = json.loads(raw)
        except (ValueError, UnicodeError): raise BridgeError('网站暂时无法返回有效数据') from None
        if response.status >= 300:
            raise BridgeError(str(result.get('error', {}).get('message', '网站接口失败')))
        return result

    def upload(self, path, name, kind, key, progress=None):
        size = Path(path).stat().st_size
        limit = AUDIO_LIMIT if kind == 'audio' else 65536 if kind == 'lyrics' else 8 * 1024 * 1024
        if not 0 < size <= limit: raise BridgeError('音频最大 100,000,000 字节；图片最大 8 MiB；歌词最大 64 KiB')
        boundary = 'Moonlit' + uuid.uuid4().hex
        # Only use the basename as a MIME filename; no header injection.
        name = Path(name).name.replace('"', '_').replace('\r', '').replace('\n', '')
        head = (f'--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n{kind}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
        tail = f'\r\n--{boundary}--\r\n'.encode()
        conn = self._connection()
        try:
            conn.putrequest('POST', self._path('/files'))
            for key_name, value in {'Authorization': 'Bearer ' + self.token, 'Idempotency-Key': key,
                'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': str(len(head) + size + len(tail))}.items(): conn.putheader(key_name, value)
            conn.endheaders(); conn.send(head); sent = 0
            with open(path, 'rb') as source:
                while block := source.read(256 * 1024):
                    conn.send(block); sent += len(block)
                    if progress: progress(sent, size)
            conn.send(tail)
            return self._response(conn)['item']
        finally:
            conn.close()

class Bridge:
    def __init__(self, config):
        self.config = config
        self.admins = set(config.get('admin_identities', []))
        self.targets = tuple(config.get('reminder_targets', []))
        self.root = Path(config['state_path']).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / 'bridge.sqlite', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, identity TEXT NOT NULL, origin TEXT NOT NULL,
          message_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created REAL NOT NULL,
          UNIQUE(identity,origin,message_id,kind));
        CREATE TABLE IF NOT EXISTS deliveries(dedupe TEXT NOT NULL, event_id INTEGER NOT NULL, target TEXT NOT NULL,
          state TEXT NOT NULL, PRIMARY KEY(dedupe,target));
        ''')
        # An interrupted external send has an uncertain outcome. Never silently resend.
        self.db.execute("UPDATE deliveries SET state='uncertain' WHERE state='sending'")
        self.db.commit()
        self.clients = {role: SiteClient(config['api_base'], config[role + '_token']) for role in ('reader','writer','reviewer','notifier')}
        self.lock = asyncio.Lock()

    def authorize(self, identity):
        if identity not in self.admins: raise BridgeError('此平台账号未获网站管理授权')

    async def catalog(self, category, query=''):
        if category not in ('music','games','cats'): raise BridgeError('类别须为 music、games 或 cats')
        result = await asyncio.to_thread(self.clients['reader'].request, '/catalog/' + category + '?limit=100')
        text = query.casefold()
        return [item for item in result['items'] if not text or text in ' '.join(str(item.get(k,'')) for k in ('title','artist','genre','note')).casefold()][:5]

    def propose(self, identity, origin, message_id, kind, payload, attachments=()):
        self.authorize(identity)
        if kind not in ('music','games','question','reply','sync','publish'): raise BridgeError('不支持此管理动作')
        prior = self.db.execute('SELECT id FROM operations WHERE identity=? AND origin=? AND message_id=? AND kind=?', (identity,origin,message_id,kind)).fetchone()
        if prior: return prior['id']
        ident = str(uuid.uuid4()); payload = json.loads(json.dumps(payload))
        if attachments:
            roots=[Path(root).resolve() for root in self.config.get('attachment_roots', [])]
            for item in attachments:
                source=Path(item['path']).resolve()
                if not any(source.is_relative_to(root) for root in roots): raise BridgeError('附件不在已配置的Bot下载目录中')
                limit=AUDIO_LIMIT if item['kind']=='audio' else 65536 if item['kind']=='lyrics' else 8*1024*1024
                if not source.is_file() or not 0 < source.stat().st_size <= limit: raise BridgeError('附件大小超限；单个音频最大 100,000,000 字节')
            folder = self.root / 'pending' / ident; folder.mkdir(parents=True,mode=0o700)
            transfers=[]
            try:
                for index, item in enumerate(attachments):
                    target=folder / str(index);shutil.copyfile(Path(item['path']).resolve(),target)
                    transfers.append({**item,'path':str(target),'media_id':None})
            except Exception:
                shutil.rmtree(folder)
                raise
            payload['transfers']=transfers
        with self.db:
            self.db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?,NULL,?)',(ident,identity,origin,message_id,kind,json.dumps(payload,ensure_ascii=False),'pending',time.time()))
        return ident

    async def confirm(self, identity, origin, ident, publish=False):
        self.authorize(identity)
        async with self.lock:
            row=self.db.execute('SELECT * FROM operations WHERE id=?',(ident,)).fetchone()
            if not row or row['identity']!=identity or row['origin']!=origin: raise BridgeError('确认编号不属于当前账号和会话')
            if (row['kind'] in ('sync','publish')) != publish: raise BridgeError('请使用对应的确认保存或确认同步指令')
            if row['state']=='done': return json.loads(row['result'])
            if time.time()-row['created']>86400: raise BridgeError('确认已过期，请重新提出操作')
            payload=json.loads(row['payload']);kind=row['kind']
            try:
                if kind in ('music','games'):
                    files=dict(payload.get('files',{}))
                    for index, transfer in enumerate(payload.get('transfers',[])):
                        if not transfer['media_id']:
                            item=await asyncio.to_thread(self.clients['writer'].upload,transfer['path'],transfer['name'],transfer['kind'],ident+'_file_'+str(index))
                            transfer['media_id']=item['id']
                            with self.db: self.db.execute('UPDATE operations SET payload=? WHERE id=?',(json.dumps(payload,ensure_ascii=False),ident))
                        files.setdefault(transfer['field'],[])
                        if transfer['media_id'] not in files[transfer['field']]: files[transfer['field']].append(transfer['media_id'])
                    body={'fields':payload['fields'],'files':files}
                    if payload.get('objectId'): body['objectId']=payload['objectId']
                    result=await asyncio.to_thread(self.clients['writer'].request,'/'+kind,'POST',body,ident)
                elif kind=='question':
                    result=await asyncio.to_thread(self.clients['writer'].request,'/questions','POST',payload,ident)
                elif kind=='reply':
                    result=await asyncio.to_thread(self.clients['reviewer'].request,'/questions/'+payload['id']+'/draft','PUT',{'reply':payload['reply'],'version':payload['version']},ident)
                elif kind=='publish':
                    result=await asyncio.to_thread(self.clients['reviewer'].request,'/questions/'+payload['id']+'/sync','POST',{'version':payload['version']},ident)
                else:
                    result=await asyncio.to_thread(self.clients['reviewer'].request,'/drafts/'+payload['id']+'/sync','POST',{'version':payload['version']},ident)
                with self.db:self.db.execute("UPDATE operations SET state='done',result=? WHERE id=?",(json.dumps(result,ensure_ascii=False),ident))
                folder=self.root/'pending'/ident
                if folder.is_dir() and folder.parent==self.root/'pending':shutil.rmtree(folder)
                return result
            except Exception:
                with self.db:self.db.execute("UPDATE operations SET state='failed' WHERE id=?",(ident,))
                raise

    async def question(self, identity, ident):
        self.authorize(identity)
        for state in ('pending','published'):
            result=await asyncio.to_thread(self.clients['reviewer'].request,'/questions?state='+state)
            for item in result['items']:
                if item['id']==ident:return item
        raise BridgeError('没有找到问题，可能已删除')

    async def draft(self, identity, ident):
        self.authorize(identity)
        for category in ('music','games'):
            result=await asyncio.to_thread(self.clients['reviewer'].request,'/drafts?category='+category)
            for item in result['items']:
                if item.get('draftId')==ident:return item
        raise BridgeError('没有找到此音乐或游戏草稿')

    async def batch(self, identity, ident):
        self.authorize(identity)
        return await asyncio.to_thread(self.clients['reviewer'].request,'/batches/'+ident)

    async def poll(self, send):
        if not self.targets:return {'sent':0,'unconfigured':True}
        async with self.lock:
            page=await asyncio.to_thread(self.clients['notifier'].request,'/events?limit=100')
            sent=0;through=None
            for event in page['items']:
                if event['type']=='question.created':
                    if event.get('state')!='pending':
                        if through is not False:through=event['id']
                        continue
                    dedupe='question:'+event['questionId']; text='新提问 '+event['questionId']+'\n'+event.get('author','匿名')+'：'+event.get('question','（已删除）')
                else:
                    dedupe='batch:'+event['batchId']; names=[item['title'] for item in event.get('newItems',[])];updates=[item['title'] for item in event.get('updatedItems',[])]
                    text='网站同步批次 '+event['batchId']+'\n新增：'+('、'.join(names) or '无')+'\n更新：'+('、'.join(updates) or '无')
                for target in self.targets:
                    known=self.db.execute('SELECT state FROM deliveries WHERE dedupe=? AND target=?',(dedupe,target)).fetchone()
                    if known and known['state'] in ('sent','uncertain','sending'):continue
                    with self.db:self.db.execute("INSERT INTO deliveries VALUES(?,?,?,'sending') ON CONFLICT(dedupe,target) DO UPDATE SET state='sending'",(dedupe,event['id'],target))
                    try:await send(target,text)
                    except Exception:
                        with self.db:self.db.execute("UPDATE deliveries SET state='uncertain' WHERE dedupe=? AND target=?",(dedupe,target))
                        raise BridgeError('提醒发送结果不确定，已保留游标；请管理员检查后手动重试') from None
                    with self.db:self.db.execute("UPDATE deliveries SET state='sent' WHERE dedupe=? AND target=?",(dedupe,target))
                    sent+=1
                complete=all(self.db.execute("SELECT 1 FROM deliveries WHERE dedupe=? AND target=? AND state='sent'",(dedupe,target)).fetchone() for target in self.targets)
                if complete and (through is not False):through=event['id']
                else:through=False
            if through:await asyncio.to_thread(self.clients['notifier'].request,'/events/ack','POST',{'through':through})
            return {'sent':sent,'uncertain':through is False}

    def retry_notification(self, identity, event_id):
        self.authorize(identity)
        with self.db:self.db.execute("UPDATE deliveries SET state='pending' WHERE event_id=? AND state='uncertain'",(event_id,))

    def close(self):
        self.db.close()
