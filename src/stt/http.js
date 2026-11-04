'use strict';
const { AppError } = require('../errors');
const { sleep } = require('../util');

/** Map an upstream HTTP status to a client-safe AppError. Provider bodies go to `details` only. */
function mapStatus(provider, status, bodyText) {
  const details = { provider, status, body: String(bodyText || '').slice(0, 500) };
  if (status === 401 || status === 403) {
    return new AppError('STT_AUTH', 'The speech provider rejected the server credentials. Check the server API key.', { status: 502, details });
  }
  if (status === 402) {
    return new AppError('STT_QUOTA', 'The speech provider account is out of credit or quota.', { status: 502, details });
  }
  if (status === 429) {
    return new AppError('STT_RATE_LIMIT', 'The speech provider is rate limiting requests. Try again shortly.', { status: 503, retryable: true, details });
  }
  if (status >= 500) {
    return new AppError('STT_UNAVAILABLE', 'The speech provider is temporarily unavailable. Try again shortly.', { status: 503, retryable: true, details });
  }
  return new AppError('STT_REQUEST_REJECTED', 'The speech provider rejected the request.', { status: 502, details });
}

/**
 * fetch with timeout + bounded retries on network errors, 429 and 5xx.
 * `makeInit` is a function so streamed bodies can be re-created on each retry.
 */
async function request(provider, url, makeInit, { timeoutMs = 60000, retries = 2, retryBaseMs = 800, signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal && signal.aborted) throw new AppError('CANCELLED', 'Job was cancelled.', { status: 409 });
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const res = await fetch(url, { ...(await makeInit()), signal: sig });
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      const err = mapStatus(provider, res.status, body);
      if (!err.retryable || attempt === retries) throw err;
      lastErr = err;
    } catch (e) {
      if (e instanceof AppError) {
        if (!e.retryable || attempt === retries) throw e;
        lastErr = e;
      } else if (signal && signal.aborted) {
        throw new AppError('CANCELLED', 'Job was cancelled.', { status: 409 });
      } else {
        lastErr = new AppError('STT_NETWORK', 'Could not reach the speech provider. Try again shortly.', {
          status: 503, retryable: true, details: { provider, message: String(e && e.message), name: e && e.name },
        });
        if (attempt === retries) throw lastErr;
      }
    }
    await sleep(retryBaseMs * 2 ** attempt, signal);
  }
  throw lastErr;
}

module.exports = { request, mapStatus };
