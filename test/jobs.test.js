'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JobManager } = require('../src/jobs');
const { AppError } = require('../src/errors');
const { loadConfig } = require('../src/config');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-jobs-'));
test.after(() => { try { fs.rmSync(tmp, { recursive: true }); } catch (_) { /* ignore */ } });

const audioFile = () => { const p = path.join(tmp, Math.random().toString(16).slice(2)); fs.writeFileSync(p, 'x'); return p; };
const waitFor = async (cond, ms = 2000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await new Promise(r => setTimeout(r, 5)); } };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

const WORDS = [{ text: 'e4', startMs: 1000, endMs: 1300, confidence: 0.9 }];
const okResult = () => ({ audio: { durationMs: 5000 }, transcript: { provider: 'fake', wordCount: 1, text: 'e4', words: WORDS }, parse: { status: 'complete', moves: [] } });

function make(pipeline, cfgEnv = {}, extra = {}) {
  const cfg = loadConfig({ MAX_CONCURRENT_JOBS: '1', MAX_QUEUED_JOBS: '1', JOB_TTL_MIN: '1', ...cfgEnv });
  const mgr = new JobManager({ cfg, logger: silent, pipeline, parseGame: extra.parseGame || (() => ({ status: 'complete', moves: [] })), now: extra.now });
  test.after(() => mgr.shutdown());
  return mgr;
}

test('lifecycle: queued -> processing -> done, stages reported, words hidden by default, audio deleted', async () => {
  const gate = deferred();
  const stages = [];
  const mgr = make(async (job, { setStage }) => {
    setStage('normalizing', 12); stages.push('normalizing');
    await gate.promise;
    setStage('parsing', 90);
    return okResult();
  });
  const file = audioFile();
  const job = mgr.create({ ownerId: 'o1', audioPath: file, size: 1 });
  assert.equal(mgr.view(job).status, 'queued');
  await waitFor(() => job.status === 'processing');
  await waitFor(() => job.stage === 'normalizing');
  assert.equal(job.progress, 12);
  gate.resolve();
  await waitFor(() => job.status === 'done');
  const v = mgr.view(job);
  assert.equal(v.progress, 100);
  assert.equal(v.result.transcript.words, undefined);
  assert.equal(v.result.transcript.wordCount, 1);
  assert.equal(mgr.view(job, { includeWords: true }).result.transcript.words.length, 1);
  assert.ok(!fs.existsSync(file), 'temp audio removed');
  assert.match(v.createdAt, /^\d{4}-\d\d-\d\dT/);
});

test('progress never goes backwards', async () => {
  const mgr = make(async (job, { setStage }) => { setStage('a', 50); setStage('b', 20); return okResult(); });
  const job = mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 });
  await waitFor(() => job.status === 'done');
  assert.equal(job.progress, 100);
});

test('concurrency limit: second job waits for the first', async () => {
  const gate = deferred(); const order = [];
  const mgr = make(async job => { order.push('start:' + job.tag); if (job.tag === 'A') await gate.promise; order.push('end:' + job.tag); return okResult(); });
  const a = mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 }); a.tag = 'A';
  const b = mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 }); b.tag = 'B';
  await waitFor(() => a.status === 'processing');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(b.status, 'queued');
  assert.deepEqual(order, ['start:A']);
  gate.resolve();
  await waitFor(() => b.status === 'done');
  assert.deepEqual(order, ['start:A', 'end:A', 'start:B', 'end:B']);
});

test('capacity: rejects with retryable SERVER_BUSY when running + queued is full', async () => {
  const gate = deferred();
  const mgr = make(async () => { await gate.promise; return okResult(); });
  mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 });
  mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 });
  assert.equal(mgr.hasCapacity(), false);
  assert.throws(() => mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 }), e => e.code === 'SERVER_BUSY' && e.status === 503 && e.retryable === true);
  gate.resolve();
});

test('ownership: another token cannot see, cancel or re-parse a job', async () => {
  const mgr = make(async () => okResult());
  const job = mgr.create({ ownerId: 'alice', audioPath: audioFile(), size: 1 });
  await waitFor(() => job.status === 'done');
  for (const fn of [() => mgr.get(job.id, 'mallory'), () => mgr.reparse(job.id, 'mallory', {}), () => mgr.get('f'.repeat(32), 'alice')]) {
    assert.throws(fn, e => e.code === 'JOB_NOT_FOUND' && e.status === 404);
  }
  await assert.rejects(mgr.cancel(job.id, 'mallory'), e => e.code === 'JOB_NOT_FOUND');
  assert.ok(mgr.get(job.id, 'alice'));
});

test('cancel while processing aborts the pipeline and removes the job', async () => {
  let aborted = false;
  const mgr = make((job, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new AppError('CANCELLED', 'Job was cancelled.', { status: 409 })); });
  }));
  const file = audioFile();
  const job = mgr.create({ ownerId: 'o', audioPath: file, size: 1 });
  await waitFor(() => job.status === 'processing');
  await mgr.cancel(job.id, 'o');
  await waitFor(() => aborted);
  assert.throws(() => mgr.get(job.id, 'o'), e => e.code === 'JOB_NOT_FOUND');
  assert.ok(!fs.existsSync(file));
});

test('cancel of a queued job means it never runs', async () => {
  const gate = deferred(); const ran = [];
  const mgr = make(async job => { ran.push(job.tag); await gate.promise; return okResult(); });
  const a = mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 }); a.tag = 'A';
  const b = mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 }); b.tag = 'B';
  await waitFor(() => a.status === 'processing');
  await mgr.cancel(b.id, 'o');
  gate.resolve();
  await waitFor(() => a.status === 'done');
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(ran, ['A']);
});

test('pipeline failures become safe public errors; internals never leak', async () => {
  const mgr = make(async job => { if (job.n === 1) throw new AppError('AUDIO_UNREADABLE', 'This audio file could not be read.', { status: 422 }); throw new Error('ENOENT /srv/secret/path.wav key=ABC'); });
  const file1 = audioFile();
  const a = mgr.create({ ownerId: 'o', audioPath: file1, size: 1 }); a.n = 1;
  await waitFor(() => a.status === 'error');
  assert.deepEqual(mgr.view(a).error, { code: 'AUDIO_UNREADABLE', message: 'This audio file could not be read.', retryable: false });
  const b = mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 }); b.n = 2;
  await waitFor(() => b.status === 'error');
  const err = mgr.view(b).error;
  assert.equal(err.code, 'INTERNAL');
  assert.ok(!JSON.stringify(err).includes('secret') && !JSON.stringify(err).includes('ABC'));
  assert.ok(!fs.existsSync(file1));
});

test('expiry: finished jobs are swept after the TTL, running jobs are not', async () => {
  let clock = 1_000_000;
  const gate = deferred();
  const mgr = make(async job => { if (job.slow) await gate.promise; return okResult(); }, {}, { now: () => clock });
  const done = mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 });
  await waitFor(() => done.status === 'done');
  const slow = mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 }); slow.slow = true;
  await waitFor(() => slow.status === 'processing');
  clock += 59 * 1000; mgr.sweep();
  assert.ok(mgr.get(done.id, 'o'));
  clock += 2 * 1000; mgr.sweep();
  assert.throws(() => mgr.get(done.id, 'o'), e => e.code === 'JOB_NOT_FOUND');
  assert.ok(mgr.get(slow.id, 'o'), 'running job survives sweep');
  gate.resolve();
});

test('reparse: uses stored words + overrides, no pipeline call; refuses unfinished jobs', async () => {
  const calls = []; let pipelineRuns = 0;
  const gate = deferred();
  const mgr = make(async job => { pipelineRuns++; if (job.hold) await gate.promise; return okResult(); }, {}, {
    parseGame: (words, opts) => { calls.push({ words, opts }); return { status: 'complete', moves: [{ san: 'e4' }] }; },
  });
  const job = mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 });
  await waitFor(() => job.status === 'done');
  const parse = mgr.reparse(job.id, 'o', { 3: { san: 'Nf3' } });
  assert.equal(pipelineRuns, 1);
  assert.deepEqual(calls[0].words, WORDS);
  assert.deepEqual(calls[0].opts, { overrides: { 3: { san: 'Nf3' } } });
  assert.equal(parse.moves[0].san, 'e4');
  assert.equal(mgr.get(job.id, 'o').result.parse, parse);

  const held = mgr.create({ ownerId: 'o', audioPath: audioFile(), size: 1 }); held.hold = true;
  await waitFor(() => held.status === 'processing');
  assert.throws(() => mgr.reparse(held.id, 'o', {}), e => e.code === 'JOB_NOT_READY' && e.status === 409);
  gate.resolve();
});

test('regression: the temp upload is already deleted by the time status becomes done or error', async () => {
  for (const fail of [false, true]) {
    const mgr = make(async () => { await new Promise(r => setTimeout(r, 20)); if (fail) throw new Error('boom'); return okResult(); });
    const file = audioFile();
    const job = mgr.create({ ownerId: 'o', audioPath: file, size: 1 });
    let sawFinal = false;
    const t0 = Date.now();
    while (!sawFinal && Date.now() - t0 < 2000) {
      if (job.status === 'done' || job.status === 'error') {
        sawFinal = true;
        assert.ok(!fs.existsSync(file), `file must be gone when status is ${job.status}`);
        assert.equal(job.audioPath, null);
      }
      await new Promise(r => setImmediate(r));
    }
    assert.ok(sawFinal);
  }
});
