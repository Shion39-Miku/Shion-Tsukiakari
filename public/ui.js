import { defaultTexts } from './copy.js';
export const data = JSON.parse(document.querySelector('#page-data').textContent);
export const { site } = data;
export const t = (key) => site.texts?.[key] || defaultTexts[key] || key;
export const copy = (tag, key, attrs = {}) => el(tag, { 'data-copy': key, ...attrs }, t(key));
export function updateCopy(root = document) {
  root.querySelectorAll('[data-copy]').forEach((node) => { node.textContent = t(node.dataset.copy); });
  root.querySelectorAll('[data-copy-placeholder]').forEach((node) => { node.placeholder = t(node.dataset.copyPlaceholder); });
  root.querySelectorAll('[data-copy-aria]').forEach((node) => {
    node.setAttribute('aria-label', t(node.dataset.copyAria));
    if (node.hasAttribute('title')) node.title = t(node.dataset.copyAria);
  });
}
export function updateSite(next) {
  Object.keys(site).forEach((key) => delete site[key]);
  Object.assign(site, next);
  updateCopy();
  bindFavicon();
  dispatchEvent(new Event('site-config-changed'));
}
const systemMotion = matchMedia('(prefers-reduced-motion: reduce)');
const motionKey = 'moonlit-reduce-motion';
let motionOverride = false;
try { motionOverride = localStorage.getItem(motionKey) === 'true'; } catch { /* Storage can be disabled. */ }
document.documentElement.classList.toggle('reduce-motion', motionOverride);
export const reducedMotion = { get matches() { return motionOverride || systemMotion.matches; } };

export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  if (tag === 'form') {
    node.noValidate = true;
    node.addEventListener('submit', (event) => {
      const invalid = [...node.elements].find((input) => input.willValidate && !input.checkValidity());
      if (!invalid) return;
      event.preventDefault(); event.stopImmediatePropagation(); invalid.setAttribute('aria-invalid', 'true');
      const label = invalid.getAttribute('aria-label') || invalid.labels?.[0]?.querySelector('span')?.textContent || invalid.name || '';
      const status = node.querySelector('.inline-status');
      if (status) showStatus(status, t(invalid.validity.valueMissing ? 'error.required' : 'error.field') + (label ? '：' + label : ''), 'error');
      invalid.focus();
    });
    node.addEventListener('input', (event) => event.target.removeAttribute?.('aria-invalid'));
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (value != null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat(Infinity).filter((item) => item != null && item !== false));
  return node;
}

const strokes = {
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  back: 'M20 12H5m6-6-6 6 6 6',
  down: 'm6 9 6 6 6-6',
  upRight: 'M6 18 18 6M8 6h10v10',
  moon: 'M20.2 15.1A8.6 8.6 0 0 1 8.9 3.8 8.6 8.6 0 1 0 20.2 15.1Z',
  sparkle: 'M12 2c0 6-4 10-10 10 6 0 10 4 10 10 0-6 4-10 10-10-6 0-10-4-10-10Z',
  mail: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm-1 2 10 7L22 7',
  music: 'M9 18V5l12-2v13M9 18a3 2 0 1 1-6 0 3 2 0 0 1 6 0Zm12-2a3 2 0 1 1-6 0 3 2 0 0 1 6 0Z',
  game: 'M7 7h10c3.2 0 4.7 2 5 6l.3 3a2 2 0 0 1-3.3 1.9L16 15H8l-3 2.9A2 2 0 0 1 1.7 16l.3-3c.3-4 1.8-6 5-6Zm0 2v4m-2-2h4m7 1h.1m3-2h.1',
  cat: 'M3 11V4l6 4a12 12 0 0 1 6 0l6-4v7a8 8 0 0 1-8 9h-2a8 8 0 0 1-8-9Zm5 2h.1m7.9 0h.1m-5 3 1 1 1-1',
  photo: 'M3 4h18v16H3zM3 16l6-5 4 4 3-3 5 5m-4-9h.1',
  play: 'm8 5 12 7-12 7Z',
  pause: 'M8 5v14m8-14v14',
  stop: 'M6 6h12v12H6z',
  volume: 'M3 9h4l5-5v16l-5-5H3zm13-2q5 5 0 10m3-13q8 8 0 16',
  muted: 'M3 9h4l5-5v16l-5-5H3zm13 0 5 6m0-6-5 6',
  close: 'm6 6 12 12M18 6 6 18',
  expand: 'M8 3H3v5m13-5h5v5m-5 13h5v-5M3 16v5h5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5',
  lock: 'M6 11h12v10H6zm2 0V7a4 4 0 0 1 8 0v4m-4 4v2',
  check: 'm4 12 5 5L20 6',
  trash: 'M4 6h16M9 6V3h6v3m3 0-1 15H7L6 6m4 4v7m4-7v7',
  heart: 'M20.8 8.6c0 4.6-8.8 10.3-8.8 10.3S3.2 13.2 3.2 8.6a4.6 4.6 0 0 1 8.8-1.8 4.6 4.6 0 0 1 8.8 1.8Z',
  bilibili: 'm7 3 4 4m6-4-4 4M4 7h16a1.6 1.6 0 0 1 1.6 1.6v9.8A1.6 1.6 0 0 1 20 20H4a1.6 1.6 0 0 1-1.6-1.6V8.6A1.6 1.6 0 0 1 4 7Zm3 6 2-1m6 0 2 1m-7 2 2 2 2-2',
  steam: 'M5.5 16.4 2 15m5.6-.1 3.9 1.5 3.3-4.9m-5.7 5.7a2.8 2.8 0 1 1-5.6 0 2.8 2.8 0 0 1 5.6 0ZM22 8.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Zm-2.8 0a2.7 2.7 0 1 1-5.4 0 2.7 2.7 0 0 1 5.4 0Z',
  x: 'M4 4h4.6L20 20h-4.6L4 4Zm16 0-6.6 7.6M4 20l6.6-7.6',
  discord: 'M8 6 6 4C3 6 2 11 2 16l5 2 1-2m8-10 2-2c3 2 4 7 4 12l-5 2-1-2M7 14q5 3 10 0M8 6q4-2 8 0m-7 5h.1m5.9 0h.1',
};

export function icon(name, size = 19) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': 1.65, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(key, value);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', strokes[name]);
  svg.append(path);
  return svg;
}

export const image = (source, alt = '', attrs = {}) => {
  const media = source && typeof source === 'object' ? source : null;
  return el('img', { src: media ? media.thumbnail || media.url : source, alt, loading: 'lazy', decoding: 'async',
    ...(media?.srcset ? { srcset: media.srcset, sizes: '(min-width: 926px) 33vw, 100vw' } : {}), ...attrs });
};

export const mark = (size, alt = '') =>
  image(site.logoMedia || site.logo, alt, { width: size, height: size, sizes: size + 'px', loading: 'eager', class: 'brand-mark' });

export function brand(attributes = {}) {
  return el('a', { class: 'brand', href: '/', ...attributes }, mark(38),
    el('span', { class: 'brand-copy' }, el('strong', {}, site.name), el('small', {}, site.englishName)));
}

export function action(text, glyph, attributes = {}) {
  return el('button', { type: 'button', class: 'button', ...attributes }, glyph && icon(glyph, 17), text);
}

export function iconButton(glyph, label, attrs = {}) {
  return el('button', { type: 'button', class: 'icon-button', 'aria-label': label, title: label, ...attrs }, icon(glyph, 18));
}

export function motionChoice() {
  const checkbox = el('input', { type: 'checkbox', checked: motionOverride });
  checkbox.addEventListener('change', () => {
    motionOverride = checkbox.checked;
    document.documentElement.classList.toggle('reduce-motion', motionOverride);
    try { localStorage.setItem(motionKey, String(motionOverride)); } catch { /* Apply to this tab. */ }
  });
  return el('label', { class: 'check-label motion-choice', title: '勾选后始终减少动效，取消后跟随系统设置' },
    checkbox, copy('span', 'motion.label'));
}

export function bindFavicon() {
  document.querySelector('link[rel="icon"]').href = site.logo;
}

export function showStatus(node, text, type = '') {
  node.textContent = text;
  node.dataset.status = type;
  node.hidden = !text;
}

let toastTimer;
export function toast(text, type = 'success') {
  const message = document.querySelector('#toast');
  showStatus(message, text, type);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { message.hidden = true; }, 4200);
}

export async function api(path, { json, headers = {}, ...options } = {}) {
  let response;
  try {
    response = await fetch(path, {
      cache: 'no-store',
      ...options,
      headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  } catch (cause) {
    throw new Error(t('error.network'), { cause });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error?.message || t('error.request')), { status: response.status, code: body.error?.code });
  return body;
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
export function displayDate(value, withTime = false) {
  const date = new Date(value);
  return dateFormatter.format(date).replaceAll('/', '.') + (withTime ? ` ${timeFormatter.format(date)}` : '');
}
export const timeTag = (value, withTime = false) => el('time', { datetime: value }, displayDate(value, withTime));

export function empty(message, glyph = 'moon') {
  return el('div', { class: 'empty' }, icon(glyph, 23), el('p', {}, message));
}

export function makeNight(layer) {
  const points = [];
  for (let i = 0; i < 32; i += 1) {
    const star = el('i', { class: 'night-star' });
    star.style.left = `${(i * 37.67 + 2.6) % 100}%`;
    star.style.top = `${(i * 21.19 + 2.4) % 100}%`;
    star.style.setProperty('--duration', `${4 + (i % 7) * 0.53}s`);
    star.style.animationDelay = `-${i * 0.43}s`;
    if (i % 8 === 0) star.classList.add('bright');
    points.push(star);
  }
  for (let i = 0; i < 7; i += 1) {
    const petal = el('i', { class: 'night-petal' });
    petal.style.left = `${12 + i * 14}%`;
    petal.style.setProperty('--duration', `${20 + i * 2}s`);
    petal.style.animationDelay = `-${i * 3.6}s`;
    points.push(petal);
  }
  layer.replaceChildren(...points);
  const pause = () => document.documentElement.classList.toggle('page-hidden', document.hidden);
  document.addEventListener('visibilitychange', pause);
  pause();
}
