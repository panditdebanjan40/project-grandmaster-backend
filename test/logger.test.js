'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../src/logger');

test('redacts secret field names and secret values hidden inside strings', () => {
  const lines = [];
  const sink = { log: l => lines.push(l), warn: l => lines.push(l), error: l => lines.push(l) };
  const log = createLogger('debug', sink, ['SUPER-SECRET-KEY-123']);
  log.warn('job failed', { apiKey: 'abc', authorization: 'Bearer x', details: { body: 'invalid token SUPER-SECRET-KEY-123 given' }, ok: 'visible' });
  const out = lines.join('\n');
  assert.ok(!out.includes('SUPER-SECRET-KEY-123'));
  assert.ok(!out.includes('Bearer x'));
  assert.ok(out.includes('visible'));
});

test('respects level and tolerates circular metadata', () => {
  const lines = [];
  const sink = { log: l => lines.push(l), warn: l => lines.push(l), error: l => lines.push(l) };
  const log = createLogger('warn', sink);
  log.info('hidden');
  const a = {}; a.self = a;
  log.error('circular', a);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /unserializable/);
});
