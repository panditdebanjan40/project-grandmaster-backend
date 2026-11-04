'use strict';
/**
 * HTTP API tests. REQUIRES the npm dependencies (express, multer, helmet, cors, express-rate-limit, chess.js).
 * The STT step is replaced by a FAKE pipeline that returns synthetic words, so these verify routing,
 * auth, validation, limits, error shapes, CORS and cleanup. They do not call AssemblyAI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { JobManager } = require('../src/jobs');
const { parseGame } = require('../src/parser');
const { speak } = require('../testutil/words');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const TOKEN_A = 'token-aaaaaaaaaaaaaaaa';
const TOKEN_B = 'token-bbbbbbbbbbbbbbbb';
const ORIGIN = 'https://app.example.netlify.app';
const SCHOLAR = 'e4 e5 bishop c4 knight c6 queen h5 knight f6 queen takes f7 checkmate';
const AMBIG = 'd3 d6 knight f3 knight f6 knight d2';

async function boot(env = {}, pipelineImpl) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-api-'));
  const cfg = loadConfig({
    NODE_ENV: 'test', ACCESS_TOKENS: `${TOKEN_A},${TOKEN_B}`, ALLOWED_ORIGINS: ORIGIN, TMP_DIR: tmp,
    MAX_UPLOAD_MB: '1', RATE_LIMIT_MAX: '1000', MAX_CONCURRENT_JOBS: '1', MAX_QUEUED_JOBS: '2', ...env,
  });
  const pipeline = pipelineImpl || (async (job, { setStage }) => {
    setStage('parsing', 90);
    const words = speak(job.words || SCHOLAR);
    return { audio: { durationMs: 9000 }, transcript: { provider: 'fake', wordCount: words.length, text: '', words }, parse: parseGame(words) };
  });
  const jobs = new JobManager({ cfg, logger: silent, pipeline, parseGame });
  const app = createApp({ cfg, logger: silent, jobs });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => { await jobs.shutdown(); await new Promise(r => { server.closeAllConnections(); server.close(r); }); fs.rmSync(tmp, { recursive: true, force: true }); };
  return { base, cfg, jobs, tmp, close };
}

const auth = (t = TOKEN_A) => ({ authorization: 'Bearer ' + t });
function form(bytes = 2048, { type = 'audio/wav', field = 'audio' } = {}) {
  const f = new FormData();
  f.append(field, new Blob([Buffer.alloc(bytes, 1)], { type }), 'my private name.wav');
  return f;
}
const post = (b, f, t = TOKEN_A) => fetch(b.base + '/api/jobs', { method: 'POST', headers: t ? auth(t) : {}, body: f });
async function poll(b, id, token = TOKEN_A, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`${b.base}/api/jobs/${id}`, { headers: auth(token) });
    const j = await r.json();
    if (j.status === 'done' || j.status === 'error') return j;
    if (Date.now() - t0 > ms) throw new Error('poll timeout, last: ' + JSON.stringify(j));
    await new Promise(r => setTimeout(r, 20));
  }
}

test('health: no auth needed, no secrets exposed', async () => {
  const b = await boot();
  try {
    const r = await fetch(b.base + '/api/health');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true); assert.equal(j.maxAudioSeconds, 600);
    const text = JSON.stringify(j);
    assert.ok(!text.includes(TOKEN_A) && !/api.?key/i.test(text));
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally { await b.close(); }
});

test('auth: every job endpoint rejects missing/wrong tokens with a JSON 401', async () => {
  const b = await boot();
  try {
    const id = 'a'.repeat(32);
    const reqs = [
      () => post(b, form(), null),
      () => post(b, form(), 'wrong-token-0000000000'),
      () => fetch(`${b.base}/api/jobs/${id}`),
      () => fetch(`${b.base}/api/jobs/${id}`, { method: 'DELETE' }),
      () => fetch(`${b.base}/api/jobs/${id}/reparse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      () => fetch(`${b.base}/api/jobs?token=${TOKEN_A}`, { method: 'POST', body: form() }),
    ];
    for (const rq of reqs) {
      const r = await rq();
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error.code, 'UNAUTHORIZED');
    }
  } finally { await b.close(); }
});

test('happy path: upload -> poll -> result with timestamps; temp audio removed; words only on request', async () => {
  const b = await boot();
  try {
    const r = await post(b, form());
    assert.equal(r.status, 202);
    const { id, pollUrl } = await r.json();
    assert.match(id, /^[a-f0-9]{32}$/);
    assert.equal(pollUrl, `/api/jobs/${id}`);

    const done = await poll(b, id);
    assert.equal(done.status, 'done'); assert.equal(done.progress, 100);
    assert.equal(done.result.parse.status, 'complete');
    assert.equal(done.result.parse.pgn, '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0');
    assert.equal(done.result.parse.moves[0].startMs, 1000);
    assert.equal(done.result.transcript.words, undefined);
    assert.equal(done.result.audio.durationMs, 9000);

    const withWords = await (await fetch(`${b.base}/api/jobs/${id}?include=words`, { headers: auth() })).json();
    assert.equal(withWords.result.transcript.words.length, 14);

    assert.deepEqual(fs.readdirSync(b.tmp), [], 'upload deleted after processing');
    assert.ok(!JSON.stringify(done).includes(TOKEN_A));
  } finally { await b.close(); }
});

test('upload validation: no file, wrong field, wrong type, empty file, too large', async () => {
  const b = await boot();
  try {
    let r = await post(b, new FormData());
    assert.equal(r.status, 400); assert.ok(['NO_FILE', 'UPLOAD_INVALID'].includes((await r.json()).error.code));

    r = await post(b, form(100, { field: 'file' }));
    assert.equal(r.status, 400);

    r = await post(b, form(100, { type: 'text/plain' }));
    assert.equal(r.status, 415); assert.equal((await r.json()).error.code, 'UNSUPPORTED_TYPE');

    r = await post(b, form(0));
    assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'EMPTY_FILE');

    r = await post(b, form(1.5 * 1024 * 1024));
    assert.equal(r.status, 413); assert.equal((await r.json()).error.code, 'UPLOAD_TOO_LARGE');

    assert.deepEqual(fs.readdirSync(b.tmp), [], 'rejected uploads leave no temp files');
  } finally { await b.close(); }
});

test('job ids are validated and jobs are private to their token', async () => {
  const b = await boot();
  try {
    let r = await fetch(`${b.base}/api/jobs/not-an-id`, { headers: auth() });
    assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'VALIDATION');
    r = await fetch(`${b.base}/api/jobs/..%2F..%2Fetc%2Fpasswd`, { headers: auth() });
    assert.ok([400, 404].includes(r.status));

    const { id } = await (await post(b, form())).json();
    await poll(b, id);
    r = await fetch(`${b.base}/api/jobs/${id}`, { headers: auth(TOKEN_B) });
    assert.equal(r.status, 404); assert.equal((await r.json()).error.code, 'JOB_NOT_FOUND');
    r = await fetch(`${b.base}/api/jobs/${id}`, { method: 'DELETE', headers: auth(TOKEN_B) });
    assert.equal(r.status, 404);
    r = await fetch(`${b.base}/api/jobs/${id}`, { headers: auth(TOKEN_A) });
    assert.equal(r.status, 200);
  } finally { await b.close(); }
});

test('DELETE removes the job', async () => {
  const b = await boot();
  try {
    const { id } = await (await post(b, form())).json();
    await poll(b, id);
    let r = await fetch(`${b.base}/api/jobs/${id}`, { method: 'DELETE', headers: auth() });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    r = await fetch(`${b.base}/api/jobs/${id}`, { headers: auth() });
    assert.equal(r.status, 404);
  } finally { await b.close(); }
});

test('reparse: an ambiguous result is fixed with overrides over HTTP, with no new pipeline run', async () => {
  let runs = 0;
  const b = await boot({}, async job => {
    runs++;
    const words = speak(AMBIG);
    return { audio: { durationMs: 5000 }, transcript: { provider: 'fake', wordCount: words.length, text: '', words }, parse: parseGame(words) };
  });
  try {
    const { id } = await (await post(b, form())).json();
    const done = await poll(b, id);
    assert.equal(done.result.parse.status, 'needs_review');
    assert.equal(done.result.parse.unresolved.type, 'ambiguous');
    const wi = done.result.parse.unresolved.wordIndex;

    const r = await fetch(`${b.base}/api/jobs/${id}/reparse`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: { [wi]: { san: 'Nbd2' } } }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.parse.status, 'complete');
    assert.equal(j.parse.moves[4].san, 'Nbd2');
    assert.equal(runs, 1);

    const again = await (await fetch(`${b.base}/api/jobs/${id}`, { headers: auth() })).json();
    assert.equal(again.result.parse.status, 'complete');
  } finally { await b.close(); }
});

test('reparse input validation', async () => {
  const b = await boot();
  try {
    const { id } = await (await post(b, form())).json();
    await poll(b, id);
    const send = body => fetch(`${b.base}/api/jobs/${id}/reparse`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body });
    for (const body of ['{not json', '[]', '{"overrides":[]}', '{"overrides":{"abc":{"san":"e4"}}}', '{"overrides":{"1":{"san":"e4; drop"}}}', '{"overrides":{"1":{"evil":true}}}']) {
      const r = await send(body);
      assert.equal(r.status, 400, body);
      assert.equal((await r.json()).error.code, 'VALIDATION', body);
    }
    const huge = JSON.stringify({ overrides: {}, pad: 'x'.repeat(200 * 1024) });
    assert.equal((await send(huge)).status, 400);
  } finally { await b.close(); }
});

test('pipeline errors reach the client as safe, structured errors', async () => {
  const { AppError } = require('../src/errors');
  const b = await boot({}, async () => { throw new AppError('AUDIO_UNREADABLE', 'This audio file could not be read.', { status: 422, details: { stderr: 'SECRET INTERNALS' } }); });
  try {
    const { id } = await (await post(b, form())).json();
    const j = await poll(b, id);
    assert.equal(j.status, 'error');
    assert.deepEqual(j.error, { code: 'AUDIO_UNREADABLE', message: 'This audio file could not be read.', retryable: false });
    assert.ok(!JSON.stringify(j).includes('SECRET INTERNALS'));
  } finally { await b.close(); }
});

test('server busy: 503 + Retry-After, and the rejected upload leaves no temp file', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const b = await boot({ MAX_CONCURRENT_JOBS: '1', MAX_QUEUED_JOBS: '0' }, async () => { await gate; return { audio: {}, transcript: { words: [], wordCount: 0, text: '' }, parse: { status: 'no_moves', moves: [] } }; });
  try {
    const first = await post(b, form());
    assert.equal(first.status, 202);
    const second = await post(b, form());
    assert.equal(second.status, 503);
    assert.equal(second.headers.get('retry-after'), '30');
    const j = await second.json();
    assert.equal(j.error.code, 'SERVER_BUSY'); assert.equal(j.error.retryable, true);
    release();
    const { id } = await first.json();
    await poll(b, id);
    assert.deepEqual(fs.readdirSync(b.tmp), []);
  } finally { release(); await b.close(); }
});

test('rate limits: general per-IP limit and per-token job-creation limit', async () => {
  let b = await boot({ RATE_LIMIT_MAX: '3' });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(b.base + '/api/jobs/' + 'a'.repeat(32), { headers: auth() })).status);
    assert.deepEqual(codes.slice(0, 3), [404, 404, 404]);
    assert.equal(codes[3], 429);
    const r = await fetch(b.base + '/api/jobs/' + 'a'.repeat(32), { headers: auth() });
    assert.equal((await r.json()).error.code, 'RATE_LIMITED');
  } finally { await b.close(); }

  b = await boot({ JOB_CREATE_LIMIT_PER_HOUR: '2' });
  try {
    assert.equal((await post(b, form())).status, 202);
    assert.equal((await post(b, form())).status, 202);
    assert.equal((await post(b, form())).status, 429);
    assert.equal((await post(b, form(), TOKEN_B)).status, 202, 'limit is per token');
  } finally { await b.close(); }
});

test('CORS: allowed origin echoed, other origins get no CORS headers, preflight works', async () => {
  const b = await boot();
  try {
    let r = await fetch(b.base + '/api/health', { headers: { origin: ORIGIN } });
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
    r = await fetch(b.base + '/api/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    r = await fetch(b.base + '/api/jobs', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    assert.ok(r.status === 204 || r.status === 200);
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(r.headers.get('access-control-allow-headers').toLowerCase(), /authorization/);
  } finally { await b.close(); }
});

test('unknown routes return the JSON error shape', async () => {
  const b = await boot();
  try {
    const r = await fetch(b.base + '/api/nope', { headers: auth() });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.code, 'NOT_FOUND');
  } finally { await b.close(); }
});
