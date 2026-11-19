// Loaded by the page and by the sandboxed desktop preload bundle.
globalThis.TsukiakariDialogs = (() => {
  const motions = new WeakMap();
  const reduceMotion = () => document.documentElement.classList.contains('reduce-motion')
    || matchMedia('(prefers-reduced-motion: reduce)').matches;

  function animate(element, frames, duration = 210) {
    motions.get(element)?.cancel();
    if (reduceMotion() || !element.animate) return null;
    const motion = element.animate(frames, { duration, easing: 'cubic-bezier(.22,.72,.25,1)' });
    motions.set(element, motion);
    return motion;
  }

  function slide(element, direction) {
    if (!direction) return;
    animate(element, [
      { transform: 'translateX(' + (direction > 0 ? 14 : -14) + 'px)', opacity: .8 },
      { transform: 'translateX(0)', opacity: 1 },
    ]);
  }

  function bind(dialog, onCancel, fallbackFocus) {
    let opener, revision = 0, closing;
    dialog.classList.add('tsuki-dialog');
    const surface = {
      open(focusTarget) {
        revision++;
        const reopening = Boolean(closing);
        closing = null;
        dialog.removeAttribute('data-closing');
        if (!dialog.open) {
          opener = dialog.getRootNode().activeElement || document.activeElement;
          dialog.showModal();
        } else if (!reopening) {
          focusTarget?.focus({ preventScroll: true });
          return;
        }
        animate(dialog, [{ opacity: .5, transform: 'translateY(9px) scale(.985)' }, { opacity: 1, transform: 'none' }]);
        focusTarget?.focus({ preventScroll: true });
      },
      close({ immediate = false } = {}) {
        if (!dialog.open) return Promise.resolve(true);
        if (closing && !immediate) return closing;
        const stamp = ++revision;
        const finish = () => {
          if (stamp !== revision || !dialog.open) return false;
          dialog.close();
          return true;
        };
        if (immediate || reduceMotion()) {
          motions.get(dialog)?.cancel();
          return Promise.resolve(finish());
        }
        dialog.setAttribute('data-closing', '');
        const motion = animate(dialog, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(7px) scale(.985)' }], 180);
        if (!motion) return Promise.resolve(finish());
        closing = new Promise(resolve => {
          const deadline = setTimeout(resolve, 240);
          motion.finished.then(resolve, resolve).finally(() => clearTimeout(deadline));
        }).then(finish);
        return closing;
      },
    };
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (onCancel) onCancel();
      else void surface.close();
    });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      revision++;
      closing = null;
      dialog.removeAttribute('data-closing');
      motions.get(dialog)?.cancel();
      const target = opener?.isConnected && !opener.disabled && !opener.closest('[inert]') && opener.getClientRects().length
        ? opener : fallbackFocus?.();
      target?.focus({ preventScroll: true });
      opener = null;
    });
    return surface;
  }

  return Object.freeze({ bind, slide });
})();
