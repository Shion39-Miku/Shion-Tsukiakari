export function signalWithTimeout(milliseconds, source) {
  if (source?.aborted) return source;
  if (typeof AbortSignal.timeout === 'function' && (!source || typeof AbortSignal.any === 'function')) {
    const timeout = AbortSignal.timeout(milliseconds);
    return source ? AbortSignal.any([source, timeout]) : timeout;
  }

  const controller = new AbortController();
  const abort = (reason) => {
    clearTimeout(timer);
    source?.removeEventListener('abort', fromSource);
    controller.abort(reason);
  };
  const fromSource = () => abort(source.reason);
  const timer = setTimeout(() => abort(new DOMException('Request timed out', 'TimeoutError')), milliseconds);
  source?.addEventListener('abort', fromSource, { once: true });
  return controller.signal;
}
