import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { test } from 'node:test';
import { signalWithTimeout } from '../public/request-signal.js';

test('older WebView request signals honor both timeout and cancellation', async (t) => {
  const descriptors = {
    timeout: Object.getOwnPropertyDescriptor(AbortSignal, 'timeout'),
    any: Object.getOwnPropertyDescriptor(AbortSignal, 'any'),
  };
  t.after(() => Object.defineProperties(AbortSignal, descriptors));
  Object.defineProperties(AbortSignal, { timeout: { value: undefined }, any: { value: undefined } });

  const source = new AbortController();
  const timed = signalWithTimeout(5, source.signal);
  await once(timed, 'abort');
  assert.equal(timed.reason.name, 'TimeoutError');
  assert.equal(source.signal.aborted, false);
  assert.equal(getEventListeners(source.signal, 'abort').length, 0);

  const canceled = signalWithTimeout(5000, source.signal);
  const reason = new DOMException('Canceled', 'AbortError');
  source.abort(reason);
  assert.equal(canceled.reason, reason);
  assert.equal(signalWithTimeout(5000, source.signal).reason, reason);
});
