export function parseLrc(lyrics) {
  const offsetMs = Number(/^\s*\[offset:([+-]?\d+)\]/im.exec(lyrics)?.[1] || 0);
  const offset = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0;
  const timed = [];
  const marker = /\[(\d{1,4}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g;
  for (const line of lyrics.split('\n')) {
    const timestamps = [...line.matchAll(marker)];
    if (!timestamps.length) continue;
    const text = line.replace(marker, '').trim() || '♪';
    for (const [, minutes, seconds, fraction] of timestamps) {
      timed.push({ time: Math.max(0, Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction || 0}`) + offset), text });
    }
  }
  timed.sort((a, b) => a.time - b.time);
  return timed;
}
