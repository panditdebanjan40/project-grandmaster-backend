'use strict';
/**
 * Adapter tests against LOCAL MOCK HTTP SERVERS that imitate the documented provider
 * request/response shapes. They prove our adapter code (headers, bodies, polling,
 * retries, unit conversion, error mapping). They do NOT prove the real providers
 * accept these requests or how accurate their timestamps are.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { createAssemblyAI } = require('../src/stt/assemblyai');
const { createDeepgram } = require('../src/stt/deepgram');
const { KEYTERMS } = require('../src/parser/vocab');
const { startMock, json } = require('../testutil/mockServer');

const AUDIO = Buffer.from('FAKE-AUDIO-BYTES-0123456789');
let audioPath;
test.before(() => { audioPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gm-stt-')), 'a.wav'); fs.writeFileSync(audioPath, AUDIO); });
test.after(() => { try { fs.rmSync(path.dirname(audioPath), { recursive: true }); } catch (_) { /* ignore */ } });

const aaiCfg = url => {
  const c = loadConfig({ ASSEMBLYAI_API_KEY: 'AAI-SECRET-KEY', ASSEMBLYAI_BASE_URL: url, STT_POLL_INTERVAL_MS: '50' });
  return c;
};

function aaiHandler({ statuses = ['queued', 'processing', 'completed'], failUploadTimes = 0, completed } = {}) {
  let polls = 0, uploadFails = 0;
  return (req, res, body) => {
    if (req.method === 'POST' && req.url === '/v2/upload') {
      if (uploadFails < failUploadTimes) { uploadFails++; return json(res, 500, { error: 'boom' }); }
      return json(res, 200, { upload_url: 'https://cdn.test/abc' });
    }
    if (req.method === 'POST' && req.url === '/v2/transcript') return json(res, 200, { id: 'tr_1', status: 'queued' });
    if (req.method === 'GET' && req.url === '/v2/transcript/tr_1') {
      const s = statuses[Math.min(polls++, statuses.length - 1)];
      if (s === 'completed') return json(res, 200, completed || {
        id: 'tr_1', status: 'completed', text: 'e4 e5', audio_duration: 7.5,
        words: [
          { text: 'e4', start: 1200, end: 1500, confidence: 0.98 },
          { text: 'e5', start: 2100.4, end: 2400, confidence: 0.91 },
        ],
      });
      if (s === 'error') return json(res, 200, { id: 'tr_1', status: 'error', error: 'internal detail xyz' });
      return json(res, 200, { id: 'tr_1', status: s });
    }
    if (req.method === 'DELETE') return json(res, 200, { id: 'tr_1' });
    return json(res, 404, {});
  };
}

test('AssemblyAI: full flow, headers, body, keyterms, ms timestamps, progress', async () => {
  const mock = await startMock(aaiHandler());
  try {
    const p = createAssemblyAI(aaiCfg(mock.url), { retryBaseMs: 1 });
    const stages = [];
    const out = await p.transcribe(audioPath, { keyterms: KEYTERMS, onProgress: s => stages.push(s) });

    assert.equal(out.provider, 'assemblyai');
    assert.equal(out.providerJobId, 'tr_1');
    assert.equal(out.durationMs, 7500);
    assert.deepEqual(out.words, [
      { text: 'e4', startMs: 1200, endMs: 1500, confidence: 0.98 },
      { text: 'e5', startMs: 2100, endMs: 2400, confidence: 0.91 },
    ]);

    const up = mock.requests.find(r => r.url === '/v2/upload');
    assert.equal(up.headers.authorization, 'AAI-SECRET-KEY');           // raw key, no "Bearer"
    assert.deepEqual(up.body, AUDIO);                                     // exact bytes uploaded

    const sub = mock.requests.find(r => r.method === 'POST' && r.url === '/v2/transcript');
    const sent = JSON.parse(sub.body.toString());
    assert.equal(sent.audio_url, 'https://cdn.test/abc');
    assert.equal(sent.language_code, 'en');
    assert.deepEqual(sent.speech_models, ['universal-3-5-pro', 'universal-2']);
    assert.ok(sent.keyterms_prompt.includes('knight') && sent.keyterms_prompt.includes('e4'));
    assert.equal(sent.keyterms_prompt.length, KEYTERMS.length);

    assert.deepEqual(stages.slice(0, 2), ['stt_uploading', 'stt_queued']);
    assert.ok(stages.includes('stt_processing'));
    await new Promise(r => setTimeout(r, 50));
    assert.ok(mock.requests.some(r => r.method === 'DELETE' && r.url === '/v2/transcript/tr_1'), 'transcript deleted at provider');
  } finally { await mock.close(); }
});

test('AssemblyAI: a completed transcript with no words returns an empty list', async () => {
  const mock = await startMock(aaiHandler({ completed: { id: 'tr_1', status: 'completed', text: '', words: null, audio_duration: 3 } }));
  try {
    const out = await createAssemblyAI(aaiCfg(mock.url), { retryBaseMs: 1 }).transcribe(audioPath, {});
    assert.deepEqual(out.words, []);
  } finally { await mock.close(); }
});

test('AssemblyAI: transient 500 on upload is retried', async () => {
  const mock = await startMock(aaiHandler({ failUploadTimes: 1 }));
  try {
    const out = await createAssemblyAI(aaiCfg(mock.url), { retryBaseMs: 1 }).transcribe(audioPath, {});
    assert.equal(out.words.length, 2);
    assert.equal(mock.requests.filter(r => r.url === '/v2/upload').length, 2);
  } finally { await mock.close(); }
});

test('AssemblyAI: 401 -> STT_AUTH, message never contains the API key', async () => {
  const mock = await startMock((req, res) => json(res, 401, { error: 'Authentication error, API token missing/invalid AAI-SECRET-KEY' }));
  try {
    await assert.rejects(createAssemblyAI(aaiCfg(mock.url), { retryBaseMs: 1 }).transcribe(audioPath, {}), e => {
      assert.equal(e.code, 'STT_AUTH');
      assert.ok(!e.message.includes('AAI-SECRET-KEY'));
      assert.equal(e.retryable, false);
      return true;
    });
    assert.equal(mock.requests.length, 1, '401 is not retried');
  } finally { await mock.close(); }
});

test('AssemblyAI: persistent 429 -> STT_RATE_LIMIT (retryable); 402 -> STT_QUOTA', async () => {
  let mock = await startMock((req, res) => json(res, 429, {}));
  try {
    await assert.rejects(createAssemblyAI(aaiCfg(mock.url), { retryBaseMs: 1 }).transcribe(audioPath, {}), e => e.code === 'STT_RATE_LIMIT' && e.retryable === true);
  } finally { await mock.close(); }
  mock = await startMock((req, res) => json(res, 402, {}));
  try {
    await assert.rejects(createAssemblyAI(aaiCfg(mock.url), { retryBaseMs: 1 }).transcribe(audioPath, {}), e => e.code === 'STT_QUOTA');
  } finally { await mock.close(); }
});

test('AssemblyAI: transcript status "error" -> STT_FAILED without leaking provider text', async () => {
  const mock = await startMock(aaiHandler({ statuses: ['processing', 'error'] }));
  try {
    await assert.rejects(createAssemblyAI(aaiCfg(mock.url), { retryBaseMs: 1 }).transcribe(audioPath, {}), e => {
      assert.equal(e.code, 'STT_FAILED');
      assert.ok(!e.message.includes('xyz'));
      assert.equal(e.details.error, 'internal detail xyz'); // kept for server logs only
      return true;
    });
  } finally { await mock.close(); }
});

test('AssemblyAI: polling timeout -> STT_TIMEOUT', async () => {
  const mock = await startMock(aaiHandler({ statuses: ['processing'] }));
  try {
    const cfg = aaiCfg(mock.url); cfg.sttTimeoutMs = 300;
    await assert.rejects(createAssemblyAI(cfg, { retryBaseMs: 1 }).transcribe(audioPath, {}), e => e.code === 'STT_TIMEOUT' && e.retryable === true);
  } finally { await mock.close(); }
});

test('AssemblyAI: abort signal -> CANCELLED', async () => {
  const mock = await startMock(aaiHandler({ statuses: ['processing'] }));
  try {
    const ac = new AbortController();
    const cfg = aaiCfg(mock.url);
    const pr = createAssemblyAI(cfg, { retryBaseMs: 1 }).transcribe(audioPath, { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(pr, e => e.code === 'CANCELLED');
  } finally { await mock.close(); }
});

test('AssemblyAI: unreachable host -> STT_NETWORK (retryable)', async () => {
  const cfg = aaiCfg('http://127.0.0.1:1');
  await assert.rejects(createAssemblyAI(cfg, { retryBaseMs: 1 }).transcribe(audioPath, {}), e => e.code === 'STT_NETWORK' && e.retryable === true);
});

test('AssemblyAI: malformed upload response -> STT_BAD_RESPONSE', async () => {
  const mock = await startMock((req, res) => json(res, 200, { nope: true }));
  try {
    await assert.rejects(createAssemblyAI(aaiCfg(mock.url), { retryBaseMs: 1 }).transcribe(audioPath, {}), e => e.code === 'STT_BAD_RESPONSE');
  } finally { await mock.close(); }
});

// ---------------- Deepgram ----------------
test('Deepgram: request shape and seconds -> ms conversion', async () => {
  const mock = await startMock((req, res) => json(res, 200, {
    metadata: { request_id: 'dg_1', duration: 7.5 },
    results: { channels: [{ alternatives: [{
      transcript: 'e4 e5',
      words: [
        { word: 'e4', punctuated_word: 'E4.', start: 1.2560788, end: 1.5, confidence: 0.99 },
        { word: 'e5', start: 2.1, end: 2.4004, confidence: 0.9 },
      ],
    }] }] },
  }));
  try {
    const cfg = loadConfig({ STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'DG-SECRET', DEEPGRAM_BASE_URL: mock.url });
    const out = await createDeepgram(cfg, { retryBaseMs: 1 }).transcribe(audioPath, { keyterms: KEYTERMS });
    assert.deepEqual(out.words, [
      { text: 'E4.', startMs: 1256, endMs: 1500, confidence: 0.99 },
      { text: 'e5', startMs: 2100, endMs: 2400, confidence: 0.9 },
    ]);
    assert.equal(out.durationMs, 7500);
    const r = mock.requests[0];
    assert.equal(r.headers.authorization, 'Token DG-SECRET');
    assert.equal(r.headers['content-type'], 'audio/wav');
    assert.deepEqual(r.body, AUDIO);
    const q = new URL('http://x' + r.url).searchParams;
    assert.equal(q.get('model'), 'nova-3');
    assert.equal(q.get('language'), 'en');
    assert.ok(q.getAll('keyterm').includes('knight'));
    assert.ok(q.getAll('keyterm').length <= 100);
  } finally { await mock.close(); }
});

test('Deepgram: 401 -> STT_AUTH; odd response -> STT_BAD_RESPONSE', async () => {
  let mock = await startMock((req, res) => json(res, 401, { err_code: 'INVALID_AUTH' }));
  try {
    const cfg = loadConfig({ STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'k', DEEPGRAM_BASE_URL: mock.url });
    await assert.rejects(createDeepgram(cfg, { retryBaseMs: 1 }).transcribe(audioPath, {}), e => e.code === 'STT_AUTH');
  } finally { await mock.close(); }
  mock = await startMock((req, res) => json(res, 200, { hello: 'world' }));
  try {
    const cfg = loadConfig({ STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'k', DEEPGRAM_BASE_URL: mock.url });
    await assert.rejects(createDeepgram(cfg, { retryBaseMs: 1 }).transcribe(audioPath, {}), e => e.code === 'STT_BAD_RESPONSE');
  } finally { await mock.close(); }
});

test('KEYTERMS stays within Deepgram\'s ~100 term limit and has no duplicates', () => {
  assert.ok(KEYTERMS.length <= 100, String(KEYTERMS.length));
  assert.equal(new Set(KEYTERMS).size, KEYTERMS.length);
});
