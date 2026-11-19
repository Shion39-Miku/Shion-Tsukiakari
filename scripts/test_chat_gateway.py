import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bot.astrbot_plugin_moonlit.chat_gateway import ChatGateway


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="hoshifuru-gateway-")
        self.token = "local-test-" + "a" * 40
        path = Path(self.directory.name) / "token.txt"
        path.write_text(self.token)
        self.calls = 0
        owner = self

        class Provider:
            async def text_chat_stream(self, **kwargs):
                owner.calls += 1
                owner.assertIsNone(kwargs["func_tool"])
                owner.assertEqual(kwargs["contexts"][-1]["content"], "你好")
                for text in ["星光", "与你"]:
                    yield SimpleNamespace(is_chunk=True, completion_text=text)
                yield SimpleNamespace(is_chunk=False, completion_text="星光与你")

        provider = Provider()
        context = SimpleNamespace(get_provider_by_id=lambda value: provider if value == "test-provider" else None)
        self.gateway = ChatGateway(context, {"port": 0, "provider_id": "test-provider", "token_file": str(path)}, message_factory=lambda **kwargs: kwargs)
        await self.gateway.start()

    async def asyncTearDown(self):
        await self.gateway.close()
        self.directory.cleanup()

    async def request(self, token, payload):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.gateway.port)
        data = json.dumps(payload).encode()
        writer.write(f"POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n\r\n".encode() + data)
        await writer.drain()
        result = await reader.read()
        writer.close()
        await writer.wait_closed()
        return result.decode()

    async def test_authentication_and_sdk_stream_without_duplicate_aggregate(self):
        payload = {"model": "test", "messages": [{"role": "user", "content": "你好"}], "stream": True}
        denied = await self.request("wrong-token", payload)
        self.assertIn("401 Unauthorized", denied)
        self.assertEqual(self.calls, 0)
        response = await self.request(self.token, payload)
        self.assertIn("200 OK", response)
        chunks = [json.loads(line[6:]) for line in response.splitlines() if line.startswith("data: {")]
        content = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks)
        self.assertEqual(content, "星光与你")
        self.assertIn("data: [DONE]", response)
        self.assertEqual(self.calls, 1)

    async def test_invalid_messages_do_not_reach_model(self):
        response = await self.request(self.token, {"messages": [{"role": "tool", "content": "你好"}]})
        self.assertIn("400 Bad Request", response)
        self.assertEqual(self.calls, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
