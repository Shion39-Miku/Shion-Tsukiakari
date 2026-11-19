// Activity contains IDs and event names, never question text or media bytes.
const entryPath = location.pathname;
let segment;
let queue = Promise.resolve();
let elapsed = 0;
let visibleSince = document.hidden ? null : performance.now();
function body(data) { return JSON.stringify({ ...data, segmentId: segment }); }
function send(data) {
  const payload = body(data);
  queue = queue.catch(() => {}).then(async () => {
    const response = await fetch('/api/public/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, cache: 'no-store' });
    if (!response.ok) throw new Error('activity unavailable');
    return response.json();
  });
  queue.catch(() => {});
  return queue;
}
function total() { return Math.round(elapsed + (visibleSince === null ? 0 : performance.now() - visibleSince)); }
function heartbeat(ended = false, beacon = false) {
  if (!segment) return;
  const payload = { type: 'heartbeat', visibleMs: total(), hidden: document.hidden, ended };
  if (beacon) {
    const content = body(payload);
    if (!navigator.sendBeacon?.('/api/public/activity', new Blob([content], { type: 'application/json' }))) {
      fetch('/api/public/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: content, keepalive: true }).catch(() => {});
    }
  } else send(payload);
}
export function trackRoute(path) {
  if (segment) heartbeat(true);
  segment = crypto.randomUUID();
  elapsed = 0;
  visibleSince = document.hidden ? null : performance.now();
  const params = new URLSearchParams(location.search);
  send({ type: 'page.enter', path, entryPath,
    referrer: document.referrer.slice(0, 1000), channel: (params.get('utm_source') || params.get('from') || '').slice(0, 60) });
}
export function track(type, targetId = '') {
  if (segment) send({ type, targetId: String(targetId), eventId: crypto.randomUUID() });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (visibleSince !== null) elapsed += performance.now() - visibleSince;
    visibleSince = null;
    heartbeat();
  } else { visibleSince ??= performance.now(); heartbeat(); }
});
addEventListener('pagehide', () => heartbeat(true, true));
addEventListener('pageshow', (event) => { if (event.persisted) { visibleSince = document.hidden ? null : performance.now(); heartbeat(); } });
setInterval(() => { if (!document.hidden) heartbeat(); }, 15000);
