'use strict';
const crypto = require('crypto');
const { AppError } = require('./errors');

/** Constant-time comparison independent of token length. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function extractBearer(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

/**
 * Bearer-token auth. Tokens are only accepted in the Authorization header
 * (never in URLs/query strings, which end up in logs and browser history).
 */
function requireAuth(tokens) {
  return (req, _res, next) => {
    const presented = extractBearer(req);
    if (!presented) return next(new AppError('UNAUTHORIZED', 'Missing access token.', { status: 401 }));
    let ok = false;
    for (const t of tokens) if (safeEqual(presented, t)) ok = true; // no early exit
    if (!ok) return next(new AppError('UNAUTHORIZED', 'Invalid access token.', { status: 401 }));
    // Stable, non-reversible id so jobs can be scoped to a token holder.
    req.clientId = crypto.createHash('sha256').update(presented).digest('hex').slice(0, 16);
    next();
  };
}

module.exports = { requireAuth, safeEqual, extractBearer };
