"""Optional loopback-only OpenAI-compatible text gateway for 月明かり.

No agent tools or website writes are exposed here. The app controls the website
through its own authenticated native APIs, independently of this connector.
"""
import asyncio
import contextlib
import hmac
import json
import re
import uuid
from pathlib import Path


class ChatGateway:
    def __init__(self, context, config, message_factory=None):
        self.context = context
        self.config = config
        self.message_factory = message_factory
        self.server = None
        self.tasks = set()
        self.active = 0
        self.token = ""

    async def start(self):
        if self.server:
            return
        if self.config.get("host", "127.0.0.1") != "127.0.0.1":
            raise ValueError("chat gateway must listen on loopback")
        port = int(self.config.get("port", 6198))
        if not (port == 0 or 1024 <= port <= 65535):
            raise ValueError("invalid chat gateway port")
        self.token = Path(self.config["token_file"]).read_text(encoding="utf-8-sig").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", self.token):
            raise ValueError("chat gateway token must be an independent random secret")
        if not self.config.get("provider_id"):
            raise ValueError("configure a chat provider id")
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", port, limit=16_384)

    @property
    def port(self):
        return self.server.sockets[0].getsockname()[1] if self.server else None

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        for task in list(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)
        self.token = ""

    @staticmethod
    async def _json(writer, code, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        reason = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 429: "Too Many Requests", 503: "Service Unavailable"}.get(code, "Error")
        writer.write(f"HTTP/1.1 {code} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {len(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".encode() + body)
        await writer.drain()

    async def _handle(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        streaming = False
        counted = False
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            lines = head.decode("ascii").split("\r\n")
            method, path, version = lines[0].split(" ")
            if version != "HTTP/1.1":
                raise ValueError("invalid HTTP version")
            headers = {}
            for line in lines[1:]:
                if not line:
                    continue
                key, value = line.split(":", 1)
                key = key.strip().lower()
                if key in headers:
                    raise ValueError("duplicate header")
                headers[key] = value.strip()
            provided = headers.get("authorization", "")
            if not hmac.compare_digest(provided, "Bearer " + self.token):
                await self._json(writer, 401, {"error": {"message": "invalid connector token"}})
                return
            if method == "GET" and path == "/health":
                await self._json(writer, 200, {"ok": True, "ready": bool(self.context.get_provider_by_id(self.config["provider_id"]))})
                return
            if method != "POST" or path != "/v1/chat/completions":
                await self._json(writer, 404, {"error": {"message": "not found"}})
                return
            if "transfer-encoding" in headers or not headers.get("content-type", "").startswith("application/json"):
                raise ValueError("use bounded JSON")
            size = int(headers.get("content-length", "0"))
            if not 1 <= size <= 512_000:
                raise ValueError("invalid request size")
            body = json.loads(await asyncio.wait_for(reader.readexactly(size), 15))
            messages = body.get("messages")
            if not isinstance(messages, list) or not 1 <= len(messages) <= 32:
                raise ValueError("invalid messages")
            if any(not isinstance(m, dict) or m.get("role") not in ("system", "user", "assistant") or not isinstance(m.get("content"), str) for m in messages):
                raise ValueError("only text messages are supported")
            if sum(len(m["content"]) for m in messages) > 100_000:
                raise ValueError("message limit exceeded")
            if self.active >= 4:
                await self._json(writer, 429, {"error": {"message": "connector busy"}})
                return
            provider = self.context.get_provider_by_id(self.config["provider_id"])
            if provider is None:
                await self._json(writer, 503, {"error": {"message": "configured provider unavailable"}})
                return
            factory = self.message_factory
            if factory is None:
                from astrbot.core.agent.message import Message
                factory = Message
            contexts = [factory(role=m["role"], content=m["content"]) for m in messages]
            self.active += 1
            counted = True
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
            streaming = True
            identifier = "chatcmpl-" + uuid.uuid4().hex
            received_chunks = False
            async with asyncio.timeout(180):
                async with contextlib.aclosing(provider.text_chat_stream(contexts=contexts, func_tool=None, request_max_retries=1, max_tokens=min(4096, max(1, int(body.get("max_tokens", 2400)))))) as stream:
                    async for item in stream:
                        text = item.completion_text or ""
                        if item.is_chunk:
                            received_chunks = True
                        elif received_chunks:
                            continue  # SDK sends a final aggregate; never duplicate it.
                        if not text:
                            continue
                        value = {"id": identifier, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]}
                        writer.write(("data: " + json.dumps(value, ensure_ascii=False) + "\n\n").encode())
                        await asyncio.wait_for(writer.drain(), 20)
            writer.write(b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
            await writer.drain()
        except (asyncio.CancelledError, ConnectionError, BrokenPipeError):
            pass
        except Exception:
            with contextlib.suppress(Exception):
                if streaming:
                    writer.write(b'data: {"error":{"message":"AstrBot model request interrupted"}}\n\n')
                    await writer.drain()
                else:
                    await self._json(writer, 400, {"error": {"message": "invalid connector request"}})
        finally:
            if counted:
                self.active -= 1
            self.tasks.discard(task)
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
