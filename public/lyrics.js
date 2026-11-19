import { copy, el, reducedMotion } from './ui.js';

import { parseLrc } from './parse-lrc.js';
export { parseLrc } from './parse-lrc.js';

export function renderLyrics(lyrics) {
  const timed = parseLrc(lyrics);
  if (!timed.length) {
    return { view: lyrics ? el('pre', { class: 'lyrics-plain', tabindex: '0', 'aria-label': '完整歌词' }, lyrics)
      : copy('p', 'music.noLyrics', { class: 'muted' }), update() {} };
  }
  const lines = timed.map(({ text }) => el('li', {}, text));
  const view = el('div', { class: 'lyrics-scroll', tabindex: '0', 'aria-label': '时间轴歌词' },
    el('ol', {}, lines));
  let active = -2;
  return {
    view,
    update(time, reason) {
      let low = 0;
      let high = timed.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (timed[mid].time <= time) low = mid + 1;
        else high = mid;
      }
      const next = low - 1;
      if (active === next && reason !== 'initial' && reason !== 'seek') return;
      lines[active]?.removeAttribute('aria-current');
      active = next;
      const line = lines[active];
      line?.setAttribute('aria-current', 'true');
      const center = () => {
        if (!view.isConnected || lines[active] !== line) return;
        const top = line ? line.offsetTop - (view.clientHeight - line.offsetHeight) / 2 : 0;
        view.scrollTo({ top: Math.max(0, top),
          behavior: reason === 'seek' || reason === 'initial' || reducedMotion.matches ? 'instant' : 'smooth' });
      };
      if (view.isConnected) center();
      else requestAnimationFrame(center);
    },
  };
}
