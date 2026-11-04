'use strict';
/**
 * Tiny logger. Redacts (a) fields whose NAME looks secret and (b) any occurrence of the
 * actual secret VALUES passed in `secrets` (API keys, access tokens), even inside strings.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = 'info', sink = console, secrets = []) {
  const min = LEVELS[level] || LEVELS.info;
  const secretList = secrets.filter(s => typeof s === 'string' && s.length >= 6);
  const scrub = text => secretList.reduce((t, s) => t.split(s).join('[redacted]'), text);
  const emit = (lvl, msg, meta) => {
    if (LEVELS[lvl] < min) return;
    const line = scrub(`${new Date().toISOString()} ${lvl.toUpperCase()} ${msg}` + (meta ? ' ' + safeJson(meta) : ''));
    (lvl === 'error' ? sink.error : lvl === 'warn' ? sink.warn : sink.log)(line);
  };
  return { debug: (m, x) => emit('debug', m, x), info: (m, x) => emit('info', m, x), warn: (m, x) => emit('warn', m, x), error: (m, x) => emit('error', m, x) };
}

function safeJson(o) {
  try {
    return JSON.stringify(o, (k, v) => (/key|token|secret|authorization/i.test(k) ? '[redacted]' : v));
  } catch (_) { return '[unserializable]'; }
}

module.exports = { createLogger };
