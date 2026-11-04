'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, validateForStartup } = require('../src/config');

test('defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.maxAudioSeconds, 600);
  assert.equal(c.sttProvider, 'assemblyai');
  assert.deepEqual(c.assemblyai.speechModels, ['universal-3-5-pro', 'universal-2']);
  assert.equal(c.assemblyai.baseUrl, 'https://api.assemblyai.com');
  assert.equal(c.maxConcurrentJobs, 1);
});

test('parses lists, trims, strips trailing slashes', () => {
  const c = loadConfig({ ACCESS_TOKENS: ' a , b ,', ALLOWED_ORIGINS: 'https://x.netlify.app', ASSEMBLYAI_BASE_URL: 'https://h.test///' });
  assert.deepEqual(c.accessTokens, ['a', 'b']);
  assert.deepEqual(c.allowedOrigins, ['https://x.netlify.app']);
  assert.equal(c.assemblyai.baseUrl, 'https://h.test');
});

test('rejects invalid numbers and providers', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ MAX_AUDIO_SECONDS: '0' }), /MAX_AUDIO_SECONDS/);
  assert.throws(() => loadConfig({ MAX_UPLOAD_MB: '1.5' }), /MAX_UPLOAD_MB/);
  assert.throws(() => loadConfig({ STT_PROVIDER: 'whisper' }), /STT_PROVIDER/);
});

test('startup validation: tokens, key, origins in production', () => {
  const bad = validateForStartup(loadConfig({}));
  assert.ok(bad.some(p => /ACCESS_TOKENS/.test(p)));
  assert.ok(bad.some(p => /ASSEMBLYAI_API_KEY/.test(p)));

  const short = validateForStartup(loadConfig({ ACCESS_TOKENS: 'short', ASSEMBLYAI_API_KEY: 'k' }));
  assert.ok(short.some(p => /16 characters/.test(p)));

  const prod = validateForStartup(loadConfig({ NODE_ENV: 'production', ACCESS_TOKENS: 'x'.repeat(20), ASSEMBLYAI_API_KEY: 'k' }));
  assert.ok(prod.some(p => /ALLOWED_ORIGINS/.test(p)));

  const ok = validateForStartup(loadConfig({ NODE_ENV: 'production', ACCESS_TOKENS: 'x'.repeat(20), ASSEMBLYAI_API_KEY: 'k', ALLOWED_ORIGINS: 'https://a.b' }));
  assert.deepEqual(ok, []);
});

test('startup validation follows the selected provider', () => {
  const p = validateForStartup(loadConfig({ STT_PROVIDER: 'deepgram', ACCESS_TOKENS: 'x'.repeat(20), ASSEMBLYAI_API_KEY: 'k' }));
  assert.ok(p.some(m => /DEEPGRAM_API_KEY/.test(m)));
});
