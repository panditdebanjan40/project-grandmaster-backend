'use strict';
/** Pipeline wiring with FAKE normalize/STT (no network, no ffmpeg, no chess.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPipeline } = require('../src/pipeline');
const { KEYTERMS } = require('../src/parser/vocab');
const { loadConfig } = require('../src/config');

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-pipe-'));
test.after(() => { try { fs.rmSync(dir, { recursive: true }); } catch (_) { /* ignore */ } });
const mk = name => { const p = path.join(dir, name); fs.writeFileSync(p, 'x'); return p; };

function setup({ sttError, normalizeError } = {}) {
  const calls = { stages: [], stt: null, parse: null };
  const normPath = mk('norm.wav');
  const pipeline = createPipeline({
    cfg: loadConfig({}),
    logger: silent,
    normalizeAudio: async () => { if (normalizeError) throw normalizeError; return { path: normPath, durationMs: 4200 }; },
    provider: {
      transcribe: async (p, o) => {
        calls.stt = { path: p, keyterms: o.keyterms };
        o.onProgress('stt_uploading'); o.onProgress('stt_processing');
        if (sttError) throw sttError;
        return { provider: 'fake', text: 'e4', words: [{ text: 'e4', startMs: 1, endMs: 2, confidence: 1 }] };
      },
    },
    parseGame: words => { calls.parse = words; return { status: 'complete', moves: [{ san: 'e4' }] }; },
  });
  return { pipeline, calls, normPath };
}

test('runs normalize -> stt -> parse, reports stages, passes keyterms, cleans temp files', async () => {
  const { pipeline, calls, normPath } = setup();
  const input = mk('in.bin');
  const job = { id: 'j', audioPath: input };
  const res = await pipeline(job, { signal: new AbortController().signal, setStage: (s, p) => calls.stages.push([s, p]) });
  assert.deepEqual(calls.stages.map(s => s[0]), ['normalizing', 'stt_uploading', 'stt_processing', 'parsing']);
  assert.ok(calls.stages.every((s, i, a) => i === 0 || s[1] >= a[i - 1][1]), 'progress non-decreasing');
  assert.equal(calls.stt.path, normPath);
  assert.deepEqual(calls.stt.keyterms, KEYTERMS);
  assert.equal(calls.parse.length, 1);
  assert.equal(res.audio.durationMs, 4200);
  assert.equal(res.transcript.provider, 'fake');
  assert.equal(res.transcript.words.length, 1);
  assert.equal(res.parse.moves[0].san, 'e4');
  assert.ok(!fs.existsSync(input) && !fs.existsSync(normPath), 'temp files removed');
  assert.equal(job.audioPath, null);
});

test('STT failure still removes temp files and propagates the error', async () => {
  const err = new Error('stt down');
  const { pipeline, normPath } = setup({ sttError: err });
  const input = mk('in2.bin');
  await assert.rejects(pipeline({ id: 'j', audioPath: input }, { signal: undefined, setStage() {} }), e => e === err);
  assert.ok(!fs.existsSync(input) && !fs.existsSync(normPath));
});

test('normalize failure removes the upload', async () => {
  const err = new Error('bad audio');
  const { pipeline } = setup({ normalizeError: err });
  const input = mk('in3.bin');
  await assert.rejects(pipeline({ id: 'j', audioPath: input }, { signal: undefined, setStage() {} }), e => e === err);
  assert.ok(!fs.existsSync(input));
});
