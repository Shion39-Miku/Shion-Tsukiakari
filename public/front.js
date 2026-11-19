import {
  action, api, bindFavicon, brand, data, el, empty, icon, iconButton, image, makeNight, mark,
  motionChoice, reducedMotion, showStatus, site, timeTag, toast, copy, t, updateCopy, updateSite,
} from './ui.js';
import { detailPlayback, setBackground } from './player.js';
import { renderLyrics } from './lyrics.js';
import { track, trackRoute } from './activity.js';

const pages = {
  '/about': ['关于我', '02', 'THE KEEPER', 'moon', '写给路过这里的你。'],
  '/music': ['音乐分享', '03', 'THE NIGHT RADIO', 'music', '把在深夜想再听一遍的旋律，留在这里。'],
  '/games': ['游戏分享', '04', 'AFTER DARK ARCADE', 'game', '几扇想要重新推开的门，和门背后的世界。'],
  '/cats': ['猫猫图', '05', 'SOFT PAWS', 'cat', '月亮照不到的地方，也有猫在睡觉。'],
  '/questions': ['提问箱', '06', 'THE LETTER BOX', 'mail', '如果有想说的话，就在这里留一封信。'],
};
const socialNames = { bilibili: 'Bilibili', steam: 'Steam', x: 'X', discord: 'Discord (DC)' };

const main = document.querySelector('#main');
const detailDialog = document.querySelector('#detail-dialog');
const imageDialog = document.querySelector('#image-dialog');
const nav = new Map();
const homeLink = el('a', {
  class: 'button home-link', href: '/', 'data-nav': '', 'aria-label': '返回主页面', title: '返回主页面',
}, icon('back', 16), el('span', {}, '返回主页面'));
function drawChrome() {
nav.clear();
homeLink.hidden = location.pathname === '/';
homeLink.setAttribute('aria-label', t('nav.home'));
homeLink.title = t('nav.home');
homeLink.replaceChildren(icon('back', 16), copy('span', 'nav.home'));
const socialLinks = Object.entries(socialNames).map(([key, name]) => {
  const url = site.socials[key];
  const label = url ? name : `${name}（${t('social.unconfigured')}）`;
  if (url) return el('a', {
    class: 'icon-button social', href: url, target: '_blank', rel: 'noopener noreferrer',
    'aria-label': label, title: label,
  }, icon(key, 17));
  const button = iconButton(key, label, { class: 'icon-button social unconfigured', 'data-hint': label });
  button.addEventListener('click', () => toast(`${name} · ${t('social.unconfigured')}`, 'info'));
  return button;
});
const unconfigured = Object.keys(socialNames).every((key) => !site.socials[key]);
const links = el('nav', { class: 'site-links', 'aria-label': t('nav.label') },
  Object.entries(pages).map(([url, [name]]) => {
    const anchor = el('a', { href: url, 'data-nav': '', ...(url === location.pathname ? { 'aria-current': 'page' } : {}) }, t('nav.' + url.slice(1)));
    nav.set(url, anchor);
    return anchor;
  }));
document.querySelector('#header').replaceChildren(el('div', { class: 'frame nav-frame' },
  brand({ 'data-nav': '', 'aria-label': `${site.name} · 主页面` }),
  links,
  el('div', { class: 'nav-end' }, homeLink, el('div', { class: 'socials', role: 'group', 'aria-label': '社交链接' },
    socialLinks, unconfigured && copy('small', 'social.unconfigured', { class: 'social-note' })))));
document.querySelector('#footer').replaceChildren(el('div', { class: 'frame footer-frame' },
  el('span', {}, mark(26), el('span', {}, site.name)),
  el('div', { class: 'footer-end' }, motionChoice(),
    copy('small', 'footer.note', { class: 'footer-note' }))));
document.querySelector('.skip-link').textContent = t('skip');
}
drawChrome();
bindFavicon();
makeNight(document.querySelector('#night'));

let path;
let routeVersion = 0;
let modalVersion = 0;
let overlay;
let unsubscribeDetail;
let questions = data.questions ?? [];
let questionList;
let questionCount;
let questionFetch = 0;
let questionKnown = Array.isArray(data.questions);
let backgroundFetch = 0;
let releaseList;
let releaseFetch = 0;
async function refreshReleases() {
  if (!releaseList || !releaseList.isConnected) return;
  const request = ++releaseFetch;
  try {
    const { items } = await api('/api/public/releases');
    if (request !== releaseFetch || !releaseList?.isConnected) return;
    releaseList.replaceChildren(...(items.length ? items.map((batch) => el('article', { class: 'release-entry', 'data-batch-id': batch.batchId },
      el('header', {}, timeTag(batch.publishedAt, true), el('strong', {}, batch.summary)),
      ...[['新增', batch.newItems], ['更新', batch.updatedItems]].filter(([, entries]) => entries.length).map(([label, entries]) =>
        el('div', { class: 'release-items' }, el('span', { class: 'tag' }, label), el('ul', {}, entries.map((item) => el('li', {}, item.url ? el('a', { href: item.url, 'data-nav': '' }, item.title) : item.title)))))))
      : [copy('p', 'home.updatesEmpty', { class: 'muted' })]));
  } catch { if (!releaseList?.childNodes.length) releaseList?.append(el('p', { class: 'muted' }, '暂时未能读取更新，请稍后再来。')); }
}
function recentUpdates() {
  releaseList = el('div', { class: 'release-list' });
  requestAnimationFrame(refreshReleases);
  return el('section', { class: 'recent-updates panel', 'aria-labelledby': 'updates-heading' },
    el('header', { class: 'section-line' }, el('div', {}, el('p', { class: 'eyebrow' }, 'MOONLIT / LATEST'), copy('h2', 'home.updates', { id: 'updates-heading' })), icon('sparkle', 22)), releaseList);
}
let catalogRefresh;
let settingsFetch = 0;
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('moonlit-updates') : null;

function pageHeading(page) {
  const [, number, english, glyph] = page;
  const slug = path.slice(1);
  return el('header', { class: 'section-head' },
    el('div', {}, el('p', { class: 'eyebrow' }, el('span', {}, number), ' / ', english),
      copy('h1', slug + '.title', { tabindex: '-1' }), copy('p', slug + '.lede', { class: 'page-lede' })),
    el('div', { class: 'section-emblem', 'aria-hidden': 'true' }, icon(glyph, 30)));
}

function cardQuestions(items) {
  return items.map((item) =>
    el('article', { class: 'letter-card' },
      el('header', { class: 'letter-meta' }, el('span', {}, icon('mail', 15), item.author),
        timeTag(item.publishedAt)),
      el('h3', {}, item.question),
      el('div', { class: 'letter-reply' }, copy('span', 'questions.reply', { class: 'mono reply-label' }), el('p', {}, item.reply))));
}

function drawQuestions() {
  if (!questionList) return;
  questionList.replaceChildren(...(questions.length ? cardQuestions(questions)
    : [empty(t(questionKnown ? 'questions.empty' : 'common.lettersLoading'), 'mail')]));
  questionCount.textContent = questionKnown ? `${questions.length} 封回信` : '—';
}

async function refreshQuestions() {
  if (!questionList) return;
  const current = ++questionFetch;
  try {
    const { items } = await api('/api/public/questions');
    if (current !== questionFetch || !questionList) return;
    if (!questionKnown || JSON.stringify(items) !== JSON.stringify(questions)) {
      questions = items;
      questionKnown = true;
      drawQuestions();
    }
  } catch (error) {
    if (current === questionFetch && questionList && !questionKnown) {
      questionList.replaceChildren(empty(error.message, 'mail'));
    }
  }
}

function lettersSection(home) {
  questionCount = el('span', { class: 'mono letter-count' });
  questionList = el('div', { class: home ? 'letter-grid' : 'letter-list' });
  const section = el('section', { class: 'letters-section', 'aria-labelledby': 'letters-heading', id: 'letters' },
    el('div', { class: 'section-line' },
      el('div', {}, el('p', { class: 'eyebrow' }, el('span', {}, '✦'), copy('span', 'home.lettersEnglish')),
        copy('h2', home ? 'home.letters' : 'questions.published', { id: 'letters-heading', tabindex: '-1' })),
      questionCount),
    questionList);
  drawQuestions();
  refreshQuestions();
  return section;
}

function homePage() {
  const enter = action(t('home.enter'), null, { class: 'button button-primary enter-button' });
  enter.replaceChildren(copy('span', 'home.enter'), icon('arrow', 16));
  enter.addEventListener('click', () => {
    history.pushState(null, '', '/about');
    renderRoute();
  });
  const hero = el('section', { class: 'hero', 'aria-labelledby': 'site-title' },
    site.heroImage && image(site.heroImage, '', { class: 'hero-art', loading: 'eager', fetchpriority: 'high' }),
    el('div', { class: 'hero-wash', 'aria-hidden': 'true' }),
    el('div', { class: 'frame hero-frame' },
      el('div', { class: 'hero-content' },
        mark(70, '网站 Logo'),
        el('p', { class: 'eyebrow hero-eyebrow' }, site.englishName),
        el('h1', { id: 'site-title', tabindex: '-1' }, site.heroTitle || site.name),
        el('p', { class: 'hero-motto' }, site.motto),
        enter),
      el('div', { class: 'hero-foot' },
        site.demoLabel && el('span', {}, el('i', { class: 'status-dot' }), site.demoLabel),
        site.heroCredit && el('span', { class: 'hero-credit' }, icon('sparkle', 12), site.heroCredit))));
  return [hero, el('div', { class: 'frame home-letters' }, recentUpdates(), lettersSection(true))];
}

function aboutPage() {
  const { about } = site;
  const likes = (title, list, glyph) => el('section', { class: 'preference' },
    el('h3', {}, icon(glyph, 17), title), el('ul', { class: 'chips-list' }, list.map((text) => el('li', {}, text))));
  return el('div', { class: 'frame inner' }, pageHeading(pages[path]),
    el('div', { class: 'about-layout' },
      el('figure', { class: 'portrait' }, el('button', { type: 'button', class: 'portrait-open', 'aria-label': t('common.original') }, image(about.portraitMedia || about.portrait, about.portraitAlt, { width: 850, height: 850, sizes: '(min-width: 826px) 460px, 85vw' })),
        el('figcaption', {}, icon('sparkle', 14), about.portraitCredit)),
      el('div', { class: 'about-copy' },
        el('section', { class: 'about-intro' },
          el('p', { class: 'eyebrow' }, 'A NOTE FROM THE KEEPER'),
          copy('h2', 'about.greeting'), el('p', { class: 'prose' }, about.intro)),
        el('div', { class: 'preferences' },
          likes(t('about.likes'), about.likes, 'heart'), likes(t('about.dislikes'), about.dislikes, 'moon')),
        el('div', { class: 'recent' },
          el('section', {}, icon('music'), el('div', {}, copy('h3', 'about.listening'), el('p', {}, about.listening))),
          el('section', {}, icon('game'), el('div', {}, copy('h3', 'about.playing'), el('p', {}, about.playing)))),
        el('section', { class: 'about-why' }, copy('h2', 'about.why'), el('p', { class: 'prose' }, about.why)))),
    el('section', { class: 'characters-section' }, el('header', { class: 'section-line' }, el('div', {},
      el('p', { class: 'eyebrow' }, 'SHION & ZHIYAO'), copy('h2', 'about.characters')), copy('p', 'about.charactersNote', { class: 'muted' })),
      el('div', { class: 'characters-grid' }, (site.characters || []).map(characterCard))));
}

function characterCard(character) {
  const gallery = el('div', { class: 'character-gallery' }, character.images.map((entry) => {
    const button = el('button', { type: 'button', class: 'character-picture', 'aria-label': entry.label },
      image(entry.media, entry.label, { width: entry.media.width, height: entry.media.height, sizes: '(min-width: 926px) 650px, 90vw' }),
      el('span', {}, icon('expand', 16), entry.label));
    button.addEventListener('click', () => { track('image.open', entry.media.id); showImage(entry.media, entry.label); });
    return button;
  }));
  if (!character.images.length) gallery.append(empty('设定图片待补充，可在后台替换。', 'photo'));
  return el('article', { class: 'character-card', 'data-character': character.id },
    el('header', { class: 'character-heading' }, el('p', { class: 'eyebrow' }, character.alias),
      el('h3', {}, character.name), el('span', { class: 'tag' }, character.role)),
    el('p', { class: 'character-summary prose' }, character.summary),
    gallery, copy('small', 'character.images', { class: 'muted character-help' }),
    el('div', { class: 'character-notes' },
      el('section', {}, copy('h4', 'character.appearance'), el('p', { class: 'prose' }, character.appearance)),
      (character.human || character.divine) && el('section', { class: 'character-aspects' },
        character.human && el('p', {}, character.human), character.divine && el('p', {}, character.divine)),
      el('section', {}, copy('h4', 'character.world'), el('p', { class: 'prose' }, character.world))));
}

function questionForm() {
  const signature = el('input', { name: 'author', maxlength: 40, placeholder: t('questions.optional'), 'data-copy-placeholder': 'questions.optional', autocomplete: 'nickname' });
  const anonymous = el('input', { type: 'checkbox', name: 'anonymous' });
  const message = el('textarea', { name: 'question', required: true, maxlength: 1200, rows: 6, placeholder: t('questions.placeholder'), 'data-copy-placeholder': 'questions.placeholder', 'aria-label': t('questions.message'), 'data-copy-aria': 'questions.message' });
  const count = el('span', { class: 'mono field-count' }, '0 / 1200');
  const submit = action('', 'mail', { type: 'submit', class: 'button button-primary' });
  submit.append(copy('span', 'questions.submit'));
  const status = el('p', { class: 'inline-status', role: 'status', hidden: true });
  const form = el('form', { class: 'question-form panel' },
    el('p', { class: 'eyebrow' }, 'TO THE MOON'),
    copy('h2', 'questions.write'),
    copy('p', 'questions.hint', { class: 'muted' }),
    el('label', { class: 'field' }, copy('span', 'questions.author'), signature),
    el('label', { class: 'check-label' }, anonymous, copy('span', 'questions.anonymous')),
    el('label', { class: 'field' }, copy('span', 'questions.message'), message, count),
    el('div', { class: 'form-actions' }, submit, status));
  let key;
  const change = () => {
    key = undefined;
    signature.disabled = anonymous.checked;
    count.textContent = `${[...message.value].length} / 1200`;
    showStatus(status, '');
  };
  form.addEventListener('input', change);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const text = message.value.trim();
    if (!text) return showStatus(status, t('questions.required'), 'error');
    const payload = { author: anonymous.checked ? '' : signature.value, anonymous: anonymous.checked, question: text };
    key ??= crypto.randomUUID();
    submit.disabled = signature.disabled = anonymous.disabled = message.disabled = true;
    showStatus(status, t('questions.sending'), 'info');
    try {
      const result = await api('/api/public/questions', {
        method: 'POST', json: payload, headers: { 'Idempotency-Key': key },
      });
      form.reset();
      change();
      showStatus(status, t('questions.success'), 'success');
      track('question.submit', result.id);
    } catch (error) {
      showStatus(status, error.message, 'error');
    } finally {
      submit.disabled = anonymous.disabled = message.disabled = false;
      signature.disabled = anonymous.checked;
    }
  });
  return form;
}

function questionsPage() {
  return el('div', { class: 'frame inner' }, pageHeading(pages[path]),
    el('div', { class: 'question-layout' }, questionForm(), lettersSection(false)));
}

function thumbnail(media, glyph) {
  return media ? image(media, '', { width: media.width, height: media.height, sizes: '(min-width: 1950px) 19vw, (min-width: 1500px) 24vw, (min-width: 826px) 31vw, (min-width: 481px) 46vw, 92vw' })
    : el('span', { class: 'cover-fallback', 'aria-hidden': 'true' }, icon(glyph, 42));
}

function catalogCard(category, item) {
  if (category === 'cats') {
    return el('figure', { class: 'cat-card' },
      el('a', { href: item.url, class: 'cat-image', 'data-item': '', 'aria-label': `查看原图 · ${timeTag(item.createdAt, true).textContent}` },
        thumbnail(item.image, 'cat'), el('span', { class: 'card-open' }, icon('expand', 17))),
      el('figcaption', {}, timeTag(item.createdAt, true)));
  }
  const music = category === 'music';
  return el('article', { class: 'catalog-card' },
    el('a', { href: item.url, class: 'catalog-link', 'data-item': '' },
      el('div', { class: 'catalog-art' }, thumbnail(music ? item.cover : item.logo, music ? 'music' : 'game'),
        item.demo && copy('span', 'common.demo', { class: 'tag art-tag' }),
        el('span', { class: 'card-open' }, icon(music ? 'play' : 'upRight', 18))),
      el('div', { class: 'catalog-copy' },
        el('p', { class: 'eyebrow' }, music ? item.artist : item.genre),
        el('h2', {}, item.title), item.translation && el('p', { class: 'translation' }, item.translation),
        el('p', { class: 'catalog-note' }, item.note),
        music && (item.producer || item.lyricist) && el('small', { class: 'credits' },
          [item.producer && `${t('music.producer')} · ${item.producer}`, item.lyricist && `${t('music.lyricist')} · ${item.lyricist}`].filter(Boolean).join('　/　')))));
}

function catalogPage(category, version) {
  const heading = pageHeading(pages[path]);
  const filters = el('div', { class: 'filter-bar', hidden: true });
  const grid = el('div', { class: category === 'cats' ? 'cat-grid' : 'catalog-grid' }, empty(t('common.loading')));
  const music = category === 'music';
  const filterGroup = el('div', { class: 'filters', role: 'group', 'aria-label': music ? '按歌手筛选' : '按游戏类型筛选' });
  const count = el('span', { class: 'mono filter-count', 'aria-live': 'polite' });
  filters.append(copy('span', music ? 'music.artist' : 'games.genre', { class: 'filter-label' }), filterGroup, count);
  const status = el('p', { class: 'gallery-note muted', hidden: true });
  let selected = '';
  let request = 0;
  const load = async () => {
  const sequence = ++request;
  try {
    const { items } = await api(`/api/public/${category}`);
    if (sequence !== request) return;
    if (version !== routeVersion) return;
    const filterKey = (item) => music ? item.artistId : item.genre;
    const draw = (value) => {
      const visible = value ? items.filter((item) => filterKey(item) === value) : items;
      grid.replaceChildren(...(visible.length ? visible.map((item) => catalogCard(category, item))
        : [empty(t('common.empty'), pages[path][3])]));
      count.textContent = `${visible.length} 项收藏`;
      for (const button of filterGroup.children) button.setAttribute('aria-pressed', String(button.value === value));
    };
    if (category !== 'cats') {
      const options = new Map(items.map((item) => [filterKey(item), music ? item.artist : item.genre]));
      filterGroup.replaceChildren();
      for (const [value, label] of [['', t('common.all')], ...options]) {
        const button = action(label, null, { class: 'filter', value, 'aria-pressed': 'false' });
        button.addEventListener('click', () => { selected = value; draw(value); });
        filterGroup.append(button);
      }
      filters.hidden = false;
    } else if (items.some((item) => item.demo)) {
      status.textContent = t('cats.demo');
      status.hidden = false;
    }
    if (selected && !items.some((item) => filterKey(item) === selected)) selected = '';
    draw(selected);
  } catch (error) {
    if (version === routeVersion) grid.replaceChildren(empty(error.message));
  }
  };
  catalogRefresh = load;
  load();
  return el('div', { class: 'frame inner' }, heading, filters, status, grid);
}

function closeControl(dialog) {
  const close = iconButton('close', t('common.close'), { 'data-copy-aria': 'common.close' });
  close.addEventListener('click', () => dialog.close());
  return close;
}

function showDetail(item, category) {
  unsubscribeDetail?.();
  unsubscribeDetail = undefined;
  const music = category === 'music';
  const art = music ? item.cover : item.logo;
  const title = el('h2', { id: 'detail-title' }, item.title);
  const credits = music && [
    item.artist, item.producer && `${t('music.producer')} · ${item.producer}`, item.lyricist && `${t('music.lyricist')} · ${item.lyricist}`,
  ].filter(Boolean).join('　/　');
  const details = el('div', { class: 'detail-head' },
    art && el('button', { type: 'button', class: 'detail-art-button', 'data-media-id': art.id, 'aria-label': t('common.original') }, image(art, '', { class: 'detail-art', loading: 'eager', width: art.width, height: art.height, sizes: '120px' })),
    el('div', {}, el('p', { class: 'eyebrow' }, music ? 'THE NIGHT RADIO' : item.genre),
      title, item.translation && el('p', { class: 'translation' }, item.translation),
      music && el('p', { class: 'credits' }, credits),
      item.demo && copy('span', 'common.demo', { class: 'tag' })));
  details.querySelector('.detail-art-button')?.addEventListener('click', () => { track('image.open', art.id); showImage(art, item.title); });
  const frame = el('div', { class: 'dialog-frame' }, el('div', { class: 'dialog-bar' },
    el('span', { class: 'mono' }, music ? 'TRACK NOTES' : 'GAME NOTES'), closeControl(detailDialog)),
  details, el('p', { class: 'detail-note' }, item.note));
  if (music) {
    const lyrics = renderLyrics(item.lyrics);
    const playback = detailPlayback(item, lyrics.update);
    unsubscribeDetail = playback.unsubscribe;
    frame.append(playback.controls, el('section', { class: 'detail-text' }, copy('h3', 'music.lyrics'), lyrics.view));
  } else {
    frame.append(el('section', { class: 'detail-text' }, copy('h3', 'games.description'),
      el('p', { class: 'prose' }, item.description)),
    el('section', { class: 'detail-text' }, copy('h3', 'games.images'), el('div', { class: 'game-images' },
      item.images.map((entry, index) => {
        const label = `游戏图片 ${index + 1}`;
        const button = el('button', { type: 'button', class: 'game-image', 'aria-label': `放大${label}` },
          image(entry, '', { width: entry.width, height: entry.height, sizes: '(min-width: 660px) 300px, 44vw' }),
          el('span', { class: 'card-open' }, icon('expand', 16)));
        button.addEventListener('click', () => { track('image.open', entry.id); showImage(entry, label); });
        return button;
      }))));
  }
  detailDialog.replaceChildren(frame);
  if (!detailDialog.open) detailDialog.showModal();
}

function showImage(media, label, date) {
  const picture = image(media.url, label, { loading: 'eager', draggable: 'false', width: media.width, height: media.height });
  const scale = el('div', { class: 'viewer-scale' }, picture);
  const viewport = el('div', { class: 'viewer-viewport', tabindex: '0', 'aria-label': '可缩放图片' }, scale);
  const out = iconButton('minus', t('common.zoomOut'), { disabled: true, 'data-copy-aria': 'common.zoomOut' });
  const reset = action('100%', null, { class: 'button viewer-percent', 'aria-label': t('common.zoomReset'), 'data-copy-aria': 'common.zoomReset' });
  const inward = iconButton('plus', t('common.zoomIn'), { 'data-copy-aria': 'common.zoomIn' });
  let zoom = 1;
  let pinch;
  const setZoom = (value) => {
    const next = Math.max(1, Math.min(4, value));
    const { scrollLeft, scrollTop, clientWidth, clientHeight } = viewport;
    const factor = next / zoom;
    zoom = next;
    scale.style.setProperty('--zoom', zoom);
    viewport.scrollTo((scrollLeft + clientWidth / 2) * factor - clientWidth / 2,
      (scrollTop + clientHeight / 2) * factor - clientHeight / 2);
    reset.textContent = `${Math.round(zoom * 100)}%`;
    out.disabled = zoom <= 1;
    inward.disabled = zoom >= 4;
  };
  out.addEventListener('click', () => setZoom(zoom / 1.35));
  inward.addEventListener('click', () => setZoom(zoom * 1.35));
  reset.addEventListener('click', () => setZoom(1));
  const distance = (touches) => Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY);
  viewport.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2) pinch = { distance: distance(event.touches), zoom };
  }, { passive: true });
  viewport.addEventListener('touchmove', (event) => {
    if (event.touches.length !== 2 || !pinch?.distance) return;
    event.preventDefault();
    setZoom(pinch.zoom * distance(event.touches) / pinch.distance);
  }, { passive: false });
  viewport.addEventListener('touchend', () => { pinch = null; });
  viewport.addEventListener('touchcancel', () => { pinch = null; });
  imageDialog.replaceChildren(el('div', { class: 'dialog-frame viewer-frame' },
    el('div', { class: 'dialog-bar' }, el('h2', { id: 'image-title' }, date ? timeTag(date, true) : label), closeControl(imageDialog)),
    viewport, el('div', { class: 'viewer-controls' }, out, reset, inward,
      el('a', { class: 'button', href: media.url, target: '_blank', rel: 'noopener', 'data-copy': 'common.original' }, t('common.original')))));
  if (!imageDialog.open) imageDialog.showModal();
}

function resetDialogs() {
  overlay = null;
  unsubscribeDetail?.();
  unsubscribeDetail = undefined;
  if (imageDialog.open) imageDialog.close();
  if (detailDialog.open) detailDialog.close();
}

async function syncDialog() {
  const version = ++modalVersion;
  resetDialogs();
  const category = path.slice(1);
  const id = new URLSearchParams(location.search).get('id');
  if (!id || !['music', 'games', 'cats'].includes(category)) return;
  const href = location.pathname + location.search;
  try {
    const { item } = await api(`/api/public/${category}/${encodeURIComponent(id)}`);
    if (version !== modalVersion) return;
    const dialog = category === 'cats' ? imageDialog : detailDialog;
    overlay = { dialog, href };
    if (category === 'cats') showImage(item.image, '猫猫原图', item.createdAt);
    else showDetail(item, category);
  } catch (error) {
    if (version !== modalVersion) return;
    overlay = { dialog: detailDialog, href };
    detailDialog.replaceChildren(el('div', { class: 'dialog-frame' },
      el('div', { class: 'dialog-bar' }, copy('h2', 'common.cannotOpen', { id: 'detail-title' }), closeControl(detailDialog)),
      empty(error.message)));
    detailDialog.showModal();
  }
}

for (const dialog of [detailDialog, imageDialog]) {
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    if (dialog === detailDialog) {
      unsubscribeDetail?.();
      unsubscribeDetail = undefined;
    } else {
      imageDialog.replaceChildren();
    }
    if (overlay?.dialog !== dialog || overlay.href !== location.pathname + location.search) return;
    overlay = null;
    if (history.state?.detail) history.back();
    else history.replaceState(null, '', path);
  });
}

function renderRoute(initial = false) {
  const next = location.pathname;
  if (path !== next) {
    path = next;
    routeVersion += 1;
    catalogRefresh = undefined;
    trackRoute(path);
    questionList = questionCount = null;
    questionFetch += 1;
    homeLink.hidden = path === '/';
    for (const [url, link] of nav) {
      if (url === path) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.title = pages[path] ? `${t(path.slice(1) + '.title')} · ${site.browserTitle || site.name}` : (site.browserTitle || site.name);
    const content = path === '/' ? homePage()
      : path === '/about' ? aboutPage()
        : path === '/questions' ? questionsPage() : catalogPage(path.slice(1), routeVersion);
    main.replaceChildren(...[content].flat());
    main.classList.toggle('is-home', path === '/');
    if (!initial) {
      main.getAnimations().forEach((animation) => animation.cancel());
      if (!reducedMotion.matches) main.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 210, easing: 'ease-out' });
      window.scrollTo({ top: 0, behavior: 'instant' });
      main.querySelector('h1')?.focus({ preventScroll: true });
    }
  } else {
    refreshQuestions();
  }
  syncDialog();
}

document.addEventListener('click', (event) => {
  const portrait = event.target.closest('.portrait-open');
  if (portrait && site.about.portraitMedia) { track('image.open', site.about.portraitMedia.id); showImage(site.about.portraitMedia, site.about.portraitCredit); return; }
  const social = event.target.closest('a.social');
  if (social) track('social.open', social.getAttribute('aria-label')?.replace(/[^A-Za-z0-9]/g, '') || 'social');
  const link = event.target.closest('a[data-nav], a[data-item]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  const href = link.getAttribute('href');
  if (link.hasAttribute('data-item')) track(path === '/cats' ? 'image.open' : 'card.open', new URL(href, location.href).searchParams.get('id'));
  if (href !== location.pathname + location.search) {
    history.pushState(link.hasAttribute('data-item') ? { detail: true } : null, '', href);
    renderRoute();
  }
});
history.scrollRestoration = 'manual';
addEventListener('popstate', () => renderRoute());

async function refreshBackground() {
  const version = ++backgroundFetch;
  try {
    const { item } = await api('/api/public/background');
    if (version === backgroundFetch) setBackground(item);
  } catch {
    // The already loaded audio remains available during a transient network error.
  }
}

let refreshTimer;
async function refreshSettings() {
  const version = ++settingsFetch;
  const { item } = await api('/api/public/site');
  if (version !== settingsFetch || item.version === site.version) return;
  const top = scrollY;
  updateSite(item);
  drawChrome();
  if (path === '/about') main.replaceChildren(aboutPage());
  else if (path === '/') main.replaceChildren(...homePage());
  updateCopy();
  document.title = path === '/' ? (site.browserTitle || site.name) : t(path.slice(1) + '.title') + ' · ' + (site.browserTitle || site.name);
  window.scrollTo({ top, behavior: 'instant' });
}

async function refreshDetail() {
  if (!detailDialog.open || !['/music', '/games'].includes(path)) return;
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return;
  const href = location.href;
  try {
    const { item } = await api('/api/public' + path + '/' + encodeURIComponent(id));
    if (href !== location.href || !detailDialog.open) return;
    const top = detailDialog.scrollTop;
    showDetail(item, path.slice(1));
    detailDialog.scrollTop = top;
  } catch (error) { if (error.status === 404 && href === location.href) detailDialog.close(); }
}

async function refreshAll(topics) {
  if (!topics || topics.includes('settings')) await refreshSettings().catch(() => {});
  const work = [];
  if (path === '/') work.push(refreshReleases());
  if (!topics || topics.includes('questions') || topics.includes('settings')) work.push(refreshQuestions());
  if (!topics || topics.includes('background')) work.push(refreshBackground());
  if (!topics || topics.includes(path.slice(1)) || topics.includes('settings')) {
    if (catalogRefresh) work.push(catalogRefresh());
    work.push(refreshDetail());
  }
  await Promise.allSettled(work);
}
function refreshVisible() {
  if (document.hidden) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshAll(), 70);
}
addEventListener('focus', refreshVisible);
document.addEventListener('visibilitychange', refreshVisible);
channel?.addEventListener('message', refreshVisible);

setBackground(data.background);
renderRoute(true);
let stream;
function connectUpdates() {
  if (stream && stream.readyState !== EventSource.CLOSED) return;
  stream = new EventSource('/api/public/updates');
  stream.addEventListener('ready', () => refreshAll());
  stream.addEventListener('changes', (event) => {
    try { refreshAll(JSON.parse(event.data).topics); } catch { refreshAll(); }
  });
}
connectUpdates();
addEventListener('pagehide', () => stream?.close());
addEventListener('pageshow', connectUpdates);
