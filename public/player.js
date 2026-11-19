import { action, el, icon, iconButton, image, t, toast } from './ui.js';
import { track as record } from './activity.js';
import { renderLyrics } from './lyrics.js';
const softwareAudio = document.body.classList.contains('chat-body') || Boolean(window.hoshifuruDesktop?.desktop);
const background = document.querySelector('#background-audio') || document.createElement('audio');
const song = document.querySelector('#song-audio');
const dock = document.querySelector('#player');
let backgroundLevel = 0.05;
const ramps = new Map();
const gains = new Map();
const listeners = new Set();
let context, backgroundId, backgroundPlay, current;
let generation = 0;
let wantsSong = false;
let muted = false;
let songVolume = 0.1;
let pendingPosition;
let lastRemembered = 0;
let hasInteracted = false;
const memoryKey = 'moonlit-current-song-v1';
try { muted = localStorage.getItem('moonlit-background-muted') === 'true'; } catch { /* Apply within this tab. */ }
try {
  const saved = localStorage.getItem('moonlit-song-volume');
  if (saved !== null && Number.isFinite(Number(saved))) songVolume = Math.max(0, Math.min(1, Number(saved)));
  // Migrate the previous 50% default once; preserve other chosen volumes and the
  // independent background-off preference. Never touch the playback bookmark.
  if (localStorage.getItem('moonlit-audio-preferences-version') !== '2') {
    if (saved === null || Number(saved) === .5) songVolume = .1;
    localStorage.setItem('moonlit-song-volume', String(songVolume));
    localStorage.setItem('moonlit-audio-preferences-version', '2');
  }
} catch { /* Keep the first-use default. */ }
background.volume = backgroundLevel;
const needsGain = Math.abs(background.volume - backgroundLevel) > 0.01;
background.muted = muted;
export const clock = (seconds) => {
  const value = Math.max(0, Math.floor(seconds || 0));
  return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
};
const level = (media) => gains.get(media)?.gain.value ?? media.volume;
function setLevel(media, value) {
  if (gains.has(media)) gains.get(media).gain.value = value;
  else media.volume = value;
}
function cancelRamp(media) {
  const previous = ramps.get(media);
  if (!previous) return;
  clearInterval(previous.timer);
  previous.resolve(false);
  ramps.delete(media);
}
function fade(media, target) {
  cancelRamp(media);
  const start = level(media);
  if (document.hidden || Math.abs(start - target) < 0.002) { setLevel(media, target); return Promise.resolve(true); }
  return new Promise((resolve) => {
    const begin = performance.now();
    const timer = setInterval(() => {
      const fraction = Math.min(1, (performance.now() - begin) / 500);
      setLevel(media, start + (target - start) * fraction);
      if (fraction >= 1) { clearInterval(timer); ramps.delete(media); resolve(true); }
    }, 16);
    ramps.set(media, { timer, resolve });
  });
}
function enableGain() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (needsGain && !context && AudioCtx) {
    try {
      context = new AudioCtx();
      for (const media of [background, song]) {
        const gain = context.createGain();
        gain.gain.value = media.volume;
        context.createMediaElementSource(media).connect(gain).connect(context.destination);
        gains.set(media, gain);
        media.volume = 1;
      }
    } catch { /* Fall back to platform media volume. */ }
  }
  if (context?.state === 'suspended') context.resume().catch(() => {});
}
function canBackgroundPlay() { return !softwareAudio && Boolean(backgroundId) && !muted && !wantsSong && song.paused; }
function resumeBackground() {
  if (!canBackgroundPlay()) return;
  if (!background.paused) { fade(background, backgroundLevel); return; }
  if (backgroundPlay) return;
  cancelRamp(background);
  // An audible autoplay attempt must be evaluated at its configured volume.
  // Starting at zero can make Chrome classify it as inaudible autoplay.
  setLevel(background, hasInteracted ? 0 : backgroundLevel);
  const id = backgroundId;
  const promise = background.play();
  backgroundPlay = promise;
  promise.then(() => {
    if (id !== backgroundId) return;
    if (canBackgroundPlay()) { if (!hasInteracted) setLevel(background, 0); fade(background, backgroundLevel); }
    else { cancelRamp(background); setLevel(background, 0); background.pause(); }
  }).catch(() => {
    if (id === backgroundId && canBackgroundPlay()) backgroundSwitch.title = '等待首次有效交互启动背景音乐';
  }).finally(() => { if (backgroundPlay === promise) backgroundPlay = null; update(); });
}
async function pauseBackground() {
  if (background.paused) { cancelRamp(background); setLevel(background, 0); return true; }
  const completed = await fade(background, 0);
  if (completed && (wantsSong || muted)) background.pause();
  return completed;
}
export function setBackground(item) {
  if(softwareAudio){backgroundId=null;background.pause();background.removeAttribute('src');return;}
  backgroundLevel = Number.isFinite(item?.volume) ? Math.max(0, Math.min(1, item.volume)) : .05;
  if ((item?.id ?? null) === backgroundId) {
    if (canBackgroundPlay()) resumeBackground();
    return;
  }
  backgroundId = item?.id ?? null;
  cancelRamp(background);
  background.pause();
  backgroundPlay = null;
  setLevel(background, 0);
  if (item) { background.src = item.url; resumeBackground(); }
  else { background.removeAttribute('src'); background.load(); }
  update();
}
export function state() {
  return { current, playing: wantsSong, audible: !song.paused, time: song.currentTime || 0,
    duration: Number.isFinite(song.duration) ? song.duration : 0, muted, volume: songVolume };
}
function remember(force = false) {
  if (!current?.audio || pendingPosition) return;
  if (!force && Date.now() - lastRemembered < 1000) return;
  lastRemembered = Date.now();
  try { localStorage.setItem(memoryKey, JSON.stringify({ id: current.id, resource: current.audio.version || current.audio.id,
    position: song.ended ? 0 : song.currentTime || 0, ended: song.ended, savedAt: Date.now() })); } catch { /* Playback continues if storage is unavailable. */ }
}
export function setSongVolume(value) {
  songVolume = Math.max(0, Math.min(1, Number(value) || 0));
  try { localStorage.setItem('moonlit-song-volume', String(songVolume)); } catch { /* Use the current tab. */ }
  if (wantsSong && !song.paused) {
    if (ramps.has(song)) fade(song, songVolume);
    else setLevel(song, songVolume);
  }
  update('volume');
}
export async function toggle(item = current) {
  if (!item?.audio) return;
  const playing = current?.id === item.id ? !wantsSong : true;
  const attempt = ++generation;
  wantsSong = playing;
  cancelRamp(song);
  if (current?.id !== item.id || current.audio.id !== item.audio.id) {
    pendingPosition = undefined;
    song.pause(); current = item; song.src = item.audio.url; setLevel(song, 0);
    remember(true);
  }
  update('intent');
  if (!playing) {
    await fade(song, 0);
    if (attempt !== generation) return;
    song.pause(); remember(true); record('song.pause', current.id); resumeBackground(); update(); return;
  }
  try {
    await pauseBackground();
    if (attempt !== generation || !wantsSong) return;
    if (song.ended) song.currentTime = 0;
    if (song.paused) setLevel(song, 0);
    await song.play();
    if (attempt !== generation) { if (!wantsSong) song.pause(); return; }
    record('song.play', current.id);
    await fade(song, songVolume);
    if (attempt === generation) update();
  } catch {
    if (attempt !== generation) return;
    wantsSong = false; toast(t('error.play'), 'error'); resumeBackground(); update();
  }
}
export async function stop() {
  const attempt = ++generation;
  wantsSong = false; update('intent');
  await fade(song, 0);
  if (attempt !== generation) return;
  song.pause();
  if (current) record('song.stop', current.id);
  remember(true); resumeBackground(); update();
}
function setMuted(value) {
  muted = value;
  try { localStorage.setItem('moonlit-background-muted', String(muted)); } catch { /* Apply within this tab. */ }
  background.muted = muted;
  cancelRamp(background);
  if (muted) { setLevel(background, 0); background.pause(); } else resumeBackground();
  update();
}
const unlock = (event) => { if (event.isTrusted) { hasInteracted = true; enableGain(); resumeBackground(); } };
if(!softwareAudio){document.addEventListener('click', unlock, { capture: true });
document.addEventListener('keydown', unlock, { capture: true });}
addEventListener('storage', (event) => {
  if (event.key === 'moonlit-background-muted' && muted !== (event.newValue === 'true')) setMuted(event.newValue === 'true');
});
export function seek(ratio) {
  const { duration } = state();
  if (!duration) return;
  song.currentTime = Math.max(0, Math.min(duration, ratio * duration)); update('seek');
  remember(true);
}
export function seekControl(label) {
  const control = el('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'seek', 'aria-label': label, disabled: true });
  control.addEventListener('input', () => seek(Number(control.value) / 1000)); return control;
}
export function reflectSeek(control, { time, duration }) {
  const progress = duration ? Math.min(1, time / duration) : 0;
  control.disabled = !duration; control.value = Math.round(progress * 1000);
  control.setAttribute('aria-valuetext', clock(time) + ' / ' + clock(duration));
  control.style.setProperty('--progress', progress * 100 + '%');
}
export function subscribe(listener) {
  listeners.add(listener); listener(state(), 'initial'); return () => listeners.delete(listener);
}
const title = el('strong', { class: 'dock-title' });
const artist = el('small');
const time = el('span', { class: 'dock-time' }, '0:00');
const scrub = seekControl('歌曲播放进度');
const toggleButton = iconButton('play', t('player.play'), { class: 'icon-button dock-play' });
toggleButton.addEventListener('click', () => toggle());
const stopButton = iconButton('stop', t('player.stop'), { class: 'icon-button dock-stop' });
stopButton.addEventListener('click', stop);
const backgroundSwitch = action('关闭背景音乐', 'moon', { class: 'button background-switch', 'aria-pressed': String(!muted) });
backgroundSwitch.addEventListener('click', () => setMuted(!muted));
if(!softwareAudio)dock.before(backgroundSwitch);
const expand = el('button', { type: 'button', class: 'dock-expand', 'aria-label': '展开歌曲详情', 'aria-haspopup': 'dialog' }, title, artist);
expand.addEventListener('click', expandPlayer);
const track = el('div', { class: 'dock-track', hidden: true }, toggleButton,
  el('div', { class: 'dock-song' }, el('div', { class: 'dock-line' }, expand, time), scrub), stopButton);
export function volumeControl(label = '歌曲音量') {
  const input = el('input', { type: 'range', min: 0, max: 100, step: 1, value: Math.round(songVolume * 100), class: 'seek song-volume-input', 'aria-label': label });
  const percent = el('output', { class: 'song-volume-percent' }, Math.round(songVolume * 100) + '%');
  input.addEventListener('input', () => setSongVolume(Number(input.value) / 100));
  return el('label', { class: 'song-volume' }, el('span', {}, t('player.songVolume')), input, percent);
}
dock.setAttribute('aria-label', '分享歌曲播放器');
dock.hidden = true;
dock.replaceChildren(el('div', { class: 'dock-content' }, track, volumeControl('全站歌曲音量')));
dock.addEventListener('click', (event) => {
  // A play click can replace its SVG during the same event; use the original
  // event path so detached icon nodes never turn a pause into an expand action.
  if (!event.composedPath().some((node) => node !== dock && node.matches?.('button,input,label'))) expandPlayer();
});
const expanded = el('dialog', { id: 'song-player-dialog', class: 'song-player-dialog', 'aria-labelledby': 'song-player-title' });
document.body.append(expanded);
let expandedId, expandedLyrics, expandedUnsubscribe;
function drawExpanded() {
  expandedUnsubscribe?.(); expandedId = current.id;
  expandedLyrics = renderLyrics(current.lyrics || '');
  const playback = detailPlayback(current, expandedLyrics.update); expandedUnsubscribe = playback.unsubscribe;
  const close = iconButton('close', '收起歌曲详情'); close.addEventListener('click', () => expanded.close());
  const artwork = current.cover;
  expanded.replaceChildren(el('div', { class: 'dialog-frame' },
    el('header', { class: 'dialog-bar' }, el('h2', { id: 'song-player-title' }, current.title), close),
    el('div', { class: 'expanded-song-layout' },
      el('div', { class: 'expanded-art' }, artwork ? image(artwork.url, current.title + '高清封面', { loading: 'eager' }) : icon('music', 70),
        artwork && el('a', { class: 'button', href: artwork.url, target: '_blank', rel: 'noopener' }, '查看原图')),
      el('section', { class: 'expanded-song-copy' }, el('p', { class: 'eyebrow' }, current.artist), el('p', { class: 'detail-note' }, current.note), playback.controls, expandedLyrics.view))));
}
function expandPlayer() {
  if (!current) return;
  if (!expanded.open) { drawExpanded(); expanded.showModal(); expandedLyrics.update(state().time, 'seek'); }
}
expanded.addEventListener('close', () => { expandedUnsubscribe?.(); expandedUnsubscribe = null; expandedId = null; });
new ResizeObserver(() => { if (expanded.open) expandedLyrics?.update(state().time, 'seek'); }).observe(expanded);
function update(reason = 'media') {
  const value = state();
  document.querySelectorAll('.song-volume-input').forEach((input) => {
    input.value = Math.round(songVolume * 100); input.setAttribute('aria-valuetext', input.value + '%');
    input.style.setProperty('--progress', input.value + '%');
    input.closest('.song-volume').querySelector('output').textContent = input.value + '%';
  });
  dock.hidden = !current; track.hidden = !current;
  const backgroundLabel = t(muted ? 'player.backgroundOn' : 'player.backgroundOff');
  backgroundSwitch.setAttribute('aria-label', backgroundLabel);
  backgroundSwitch.setAttribute('aria-pressed', String(!muted));
  backgroundSwitch.replaceChildren(icon(muted ? 'muted' : 'moon', 17), backgroundLabel);
  stopButton.setAttribute('aria-label', t('player.stop'));
  dock.classList.toggle('is-playing', value.playing || (!background.paused && !current));
  if (current) {
    if (expanded.open && expandedId !== current.id) drawExpanded();
    title.textContent = current.title; artist.textContent = current.artist;
    time.textContent = clock(value.time) + ' / ' + clock(value.duration);
    const label = t(value.playing ? 'player.pause' : 'player.play');
    if (toggleButton.getAttribute('aria-label') !== label) {
      toggleButton.setAttribute('aria-label', label); toggleButton.title = label;
      toggleButton.replaceChildren(icon(value.playing ? 'pause' : 'play', 18));
    }
    reflectSeek(scrub, value);
  }
  listeners.forEach((listener) => listener(value, reason));
}
song.addEventListener('ended', () => { generation++; wantsSong = false; remember(true); setLevel(song, 0); resumeBackground(); update(); });
song.addEventListener('pause', () => { remember(true); if (!wantsSong) resumeBackground(); update(); });
song.addEventListener('error', () => { generation++; wantsSong = false; toast(t('error.play'), 'error'); resumeBackground(); update(); });
for (const event of ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked', 'seeking', 'playing']) {
  song.addEventListener(event, () => { remember(event === 'seeked'); update(event.startsWith('seek') ? 'seek' : event); });
}
song.addEventListener('loadedmetadata', () => {
  if (!pendingPosition || pendingPosition.resource !== (current?.audio.version || current?.audio.id)) return;
  const position = pendingPosition.position; pendingPosition = undefined;
  song.currentTime = Number.isFinite(song.duration) && position < song.duration - .05 ? position : 0;
  remember(true); update('seek');
});
addEventListener('pagehide', () => remember(true));
for (const event of ['playing', 'pause']) background.addEventListener(event, () => update());
background.addEventListener('error', () => { if (backgroundId) backgroundSwitch.title = t('player.backgroundError'); });
addEventListener('site-config-changed', () => update());
export function detailPlayback(item, lyricUpdate) {
  const play = action(t('player.play'), 'play', { class: 'button button-primary' });
  play.addEventListener('click', () => toggle(item));
  const timeline = seekControl('此歌曲播放进度');
  const timeText = el('span', { class: 'mono lyric-time' }, '0:00 / 0:00');
  const controls = el('div', { class: 'song-controls' }, el('div', { class: 'detail-controls' }, play, el('div', { class: 'detail-seek' }, timeText, timeline)), volumeControl());
  const unsubscribe = subscribe((value, reason) => {
    const same = value.current?.id === item.id;
    const playing = same && value.playing;
    const label = t(playing ? 'player.pause' : 'player.play');
    if (play.textContent !== label) play.replaceChildren(icon(playing ? 'pause' : 'play', 17), label);
    const position = same ? value.time : 0;
    const duration = same ? value.duration : 0;
    timeText.textContent = clock(position) + ' / ' + clock(duration);
    reflectSeek(timeline, { time: position, duration }); lyricUpdate(position, reason);
  });
  return { controls, unsubscribe };
}

async function restoreCurrent() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(memoryKey) || 'null'); } catch { return; }
  if (!saved || !/^[0-9a-f-]{36}$/i.test(saved.id) || !Number.isFinite(saved.position) || saved.position < 0) return;
  const attempt = generation;
  try {
    const response = await fetch('/api/public/music/' + saved.id, { cache: 'no-store' });
    if (!response.ok) { if (response.status === 404) localStorage.removeItem(memoryKey); return; }
    const { item } = await response.json();
    if (generation !== attempt || current) return;
    current = item; wantsSong = false;
    const resource = item.audio.version || item.audio.id;
    pendingPosition = { resource, position: resource === saved.resource && !saved.ended ? saved.position : 0 };
    song.preload = 'metadata'; song.src = item.audio.url; setLevel(song, 0); song.load(); update('restore');
  } catch { /* A temporary outage does not erase the saved position. */ }
}
restoreCurrent();
