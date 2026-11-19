// Private messages and authenticated API responses are never cached by the worker.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate' || !new URL(event.request.url).pathname.startsWith('/chat')) return;
  event.respondWith(fetch(event.request).catch(() => new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>月明かり</title><body bgcolor="#101321" text="#e8deec"><h1>月明かり</h1><p>暂时离线。连接恢复后刷新，即可继续聊天。</p><a href="/chat">重新连接</a></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })));
});
