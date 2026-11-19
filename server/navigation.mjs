const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const socialIcons = {
  bilibili: 'm7 3 4 4m6-4-4 4M4 7h16v13H4zM7 13l2-1m6 0 2 1m-7 2 2 2 2-2',
  steam: 'M5 16 2 15m6 0 4 1 3-4m-6 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM22 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',
  x: 'M4 4h4l12 16h-4L4 4Zm16 0-6 7M4 20l6-7',
  discord: 'M8 6 6 4C3 6 2 11 2 16l5 2 1-2m8-10 2-2c3 2 4 7 4 12l-5 2-1-2M7 14q5 3 10 0M8 6q4-2 8 0m-7 5h.1m5.9 0h.1',
};
const svg = (path) => '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';

// Keep navigation visible in the initial HTML, before the SPA module has loaded.
export function renderNavigation(site, path) {
  const text = (key, fallback) => escape(site.texts[key] || fallback);
  const sections = [['about', '关于我'], ['music', '音乐分享'], ['games', '游戏分享'], ['cats', '猫猫图'], ['questions', '提问箱']];
  const links = sections.map(([slug, fallback]) => '<a href="/' + slug + '" data-nav' + (path === '/' + slug ? ' aria-current="page"' : '') + '>' + text('nav.' + slug, fallback) + '</a>').join('');
  const socials = Object.entries({ bilibili: 'Bilibili', steam: 'Steam', x: 'X', discord: 'Discord (DC)' }).map(([key, label]) => {
    const icon = svg(socialIcons[key]);
    return site.socials[key]
      ? '<a class="icon-button social" href="' + escape(site.socials[key]) + '" target="_blank" rel="noopener noreferrer" aria-label="' + label + '">' + icon + '</a>'
      : '<button type="button" class="icon-button social unconfigured" aria-label="' + label + '（' + text('social.unconfigured', '未配置') + '）">' + icon + '</button>';
  }).join('');
  const back = '<a href="/" data-nav class="button home-link" aria-label="' + text('nav.home', '返回主页面') + '"' + (path === '/' ? ' hidden' : '') + '>' + svg('M20 12H5m6-6-6 6 6 6') + '<span>' + text('nav.home', '返回主页面') + '</span></a>';
  return '<div class="frame nav-frame"><a class="brand" href="/" data-nav aria-label="' + escape(site.name) + ' · 主页面"><img class="brand-mark" src="' + escape(site.logo) + '" width="38" height="38" alt=""><span class="brand-copy"><strong>' + escape(site.name) + '</strong><small>' + escape(site.englishName) + '</small></span></a><nav class="site-links" aria-label="' + text('nav.label', '站内栏目') + '">' + links + '</nav><div class="nav-end">' + back + '<div class="socials" role="group" aria-label="社交链接">' + socials + '</div></div></div>';
}
