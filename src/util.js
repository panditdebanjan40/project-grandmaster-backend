'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { AppError } = require('./errors');

const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

/** Sleep that rejects with CANCELLED when `signal` aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new AppError('CANCELLED', 'Job was cancelled.', { status: 409 }));
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); cleanup(); reject(new AppError('CANCELLED', 'Job was cancelled.', { status: 409 })); };
    const cleanup = () => signal && signal.removeEventListener('abort', onAbort);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function safeUnlink(p) {
  if (!p) return;
  try { await fs.promises.unlink(p); } catch (e) { if (e.code !== 'ENOENT') { /* ignore */ } }
}

module.exports = { randomId, sleep, safeUnlink };
