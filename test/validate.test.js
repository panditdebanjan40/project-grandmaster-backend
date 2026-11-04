'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOverrides, validateJobId } = require('../src/validate');

const code = fn => { try { fn(); } catch (e) { return e.code + ':' + e.status; } return 'no-error'; };

test('job id format', () => {
  assert.equal(validateJobId('a'.repeat(32)), 'a'.repeat(32));
  for (const bad of ['', 'abc', '../etc/passwd', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(33)]) {
    assert.equal(code(() => validateJobId(bad)), 'VALIDATION:400', bad);
  }
});

test('valid overrides pass through cleaned', () => {
  const out = validateOverrides({ overrides: { 12: { san: 'Nbd2' }, 40: { skip: true }, 55: { insertBefore: ['Nc6', 'O-O'] } } });
  assert.deepEqual(out, { 12: { san: 'Nbd2' }, 40: { skip: true }, 55: { insertBefore: ['Nc6', 'O-O'] } });
  assert.deepEqual(validateOverrides({}), {});
  assert.deepEqual(validateOverrides({ overrides: {} }), {});
});

test('rejects malformed bodies', () => {
  assert.equal(code(() => validateOverrides(null)), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides([])), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides({ overrides: [] })), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides({ overrides: 'x' })), 'VALIDATION:400');
});

test('rejects bad keys, unknown fields, bad SAN, conflicting and empty overrides', () => {
  assert.equal(code(() => validateOverrides({ overrides: { abc: { san: 'e4' } } })), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides({ overrides: { '-1': { san: 'e4' } } })), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides({ overrides: { 1: { san: 'e4', evil: 1 } } })), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides({ overrides: { 1: { san: 'e4; rm -rf /' } } })), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides({ overrides: { 1: { san: 5 } } })), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides({ overrides: { 1: { skip: false } } })), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides({ overrides: { 1: { san: 'e4', skip: true } } })), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides({ overrides: { 1: {} } })), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides({ overrides: { 1: { insertBefore: [] } } })), 'VALIDATION:400');
  assert.equal(code(() => validateOverrides({ overrides: { 1: { insertBefore: new Array(11).fill('e4') } } })), 'VALIDATION:400');
});

test('prototype-pollution style keys are rejected', () => {
  const body = JSON.parse('{"overrides":{"__proto__":{"san":"e4"}}}');
  assert.equal(code(() => validateOverrides(body)), 'VALIDATION:400');
  assert.equal(({}).san, undefined);
});

test('too many overrides', () => {
  const o = {}; for (let i = 0; i < 201; i++) o[i] = { skip: true };
  assert.equal(code(() => validateOverrides({ overrides: o })), 'VALIDATION:400');
});
