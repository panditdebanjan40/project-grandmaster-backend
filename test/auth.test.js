'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireAuth, extractBearer } = require('../src/auth');
const { AppError } = require('../src/errors');

const TOKENS = ['token-one-1234567890', 'token-two-1234567890'];
const run = (headers, query) => {
  const req = { get: n => headers[n.toLowerCase()], query: query || {} };
  let err; let called = false;
  requireAuth(TOKENS)(req, {}, e => { called = true; err = e; });
  return { req, err, called };
};

test('accepts any configured token and sets a stable client id', () => {
  const a = run({ authorization: 'Bearer ' + TOKENS[0] });
  const b = run({ authorization: 'Bearer ' + TOKENS[1] });
  const a2 = run({ authorization: 'bearer ' + TOKENS[0] });
  assert.equal(a.err, undefined); assert.equal(b.err, undefined);
  assert.match(a.req.clientId, /^[a-f0-9]{16}$/);
  assert.equal(a.req.clientId, a2.req.clientId);
  assert.notEqual(a.req.clientId, b.req.clientId);
  assert.ok(!a.req.clientId.includes('token'));
});

test('rejects missing, malformed and wrong tokens with 401', () => {
  for (const h of [{}, { authorization: '' }, { authorization: 'Basic abc' }, { authorization: 'Bearer' }, { authorization: 'Bearer wrong-token-000000' }, { authorization: 'Bearer ' + TOKENS[0] + 'x' }]) {
    const { err } = run(h);
    assert.ok(err instanceof AppError, JSON.stringify(h));
    assert.equal(err.status, 401);
    assert.equal(err.code, 'UNAUTHORIZED');
  }
});

test('a token in the query string is never accepted', () => {
  const { err } = run({}, { token: TOKENS[0], access_token: TOKENS[0] });
  assert.equal(err.status, 401);
});

test('error messages never echo the presented token', () => {
  const { err } = run({ authorization: 'Bearer secret-presented-value' });
  assert.ok(!err.message.includes('secret-presented-value'));
});

test('extractBearer', () => {
  assert.equal(extractBearer({ get: () => 'Bearer abc' }), 'abc');
  assert.equal(extractBearer({ get: () => 'Bearer a b' }), null);
});
