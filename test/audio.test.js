'use strict';
/** Uses the REAL ffmpeg on this machine with generated sine tones. Skips if ffmpeg is unavailable. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../src/config');
const { normalizeAudio, resolveFfmpeg } = require('../src/audio');

const cfg = loadConfig({});
const ffmpeg = resolveFfmpeg(cfg);
const hasFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version']).status === 0;
const opts = { skip: hasFfmpeg ? false : 'ffmpeg not available' };

let dir;
const tone = (name, seconds, extra) => {
  const p = path.join(dir, name);
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...extra, p]);
  assert.equal(r.status, 0, String(r.stderr));
  return p;
};
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-audio-')); });
test.after(() => { try { fs.rmSync(dir, { recursive: true }); } catch (_) { /* ignore */ } });

test('stereo 44.1 kHz WAV -> 16 kHz mono WAV with correct duration', opts, async () => {
  const input = tone('in.wav', 3, ['-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le']);
  const before = fs.readFileSync(input);
  const out = await normalizeAudio(input, cfg);
  assert.ok(fs.existsSync(out.path));
  assert.ok(Math.abs(out.durationMs - 3000) < 80, 'duration ' + out.durationMs);
  assert.deepEqual(fs.readFileSync(input), before, 'input file untouched');
  if (hasFfprobe) {
    const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,codec_name', '-of', 'csv=p=0', out.path]);
    assert.equal(pr.stdout.toString().trim(), 'pcm_s16le,16000,1');
  }
  fs.unlinkSync(out.path);
});

test('FLAC input works; a path containing spaces works', opts, async () => {
  const input = tone('my recording.flac', 2, ['-ar', '48000', '-ac', '1']);
  const out = await normalizeAudio(input, cfg);
  assert.ok(Math.abs(out.durationMs - 2000) < 80);
  fs.unlinkSync(out.path);
});

test('audio longer than the limit is rejected and no output file is left behind', opts, async () => {
  const input = tone('long.wav', 5, ['-c:a', 'pcm_s16le']);
  const small = loadConfig({ MAX_AUDIO_SECONDS: '2' });
  await assert.rejects(normalizeAudio(input, small), e => e.code === 'AUDIO_TOO_LONG' && e.status === 413);
  assert.ok(!fs.existsSync(input + '.16k.wav'));
});

test('exactly at the limit is accepted', opts, async () => {
  const input = tone('exact.wav', 2, ['-c:a', 'pcm_s16le']);
  const out = await normalizeAudio(input, loadConfig({ MAX_AUDIO_SECONDS: '2' }));
  assert.ok(out.durationMs <= 2000);
  fs.unlinkSync(out.path);
});

test('non-audio bytes -> AUDIO_UNREADABLE (422), stderr kept out of the public message', opts, async () => {
  const p = path.join(dir, 'garbage.bin');
  fs.writeFileSync(p, Buffer.from('this is definitely not audio '.repeat(50)));
  await assert.rejects(normalizeAudio(p, cfg), e => {
    assert.equal(e.code, 'AUDIO_UNREADABLE'); assert.equal(e.status, 422);
    assert.ok(!/ffmpeg|Invalid data/i.test(e.message));
    return true;
  });
  assert.ok(!fs.existsSync(p + '.16k.wav'));
});

test('a clip shorter than 0.3 s -> AUDIO_EMPTY', opts, async () => {
  const input = tone('tiny.wav', 0.1, ['-c:a', 'pcm_s16le']);
  await assert.rejects(normalizeAudio(input, cfg), e => e.code === 'AUDIO_EMPTY');
});

test('missing ffmpeg binary -> AUDIO_TOOLING (500)', async () => {
  const p = path.join(dir, 'x.wav'); fs.writeFileSync(p, 'x');
  await assert.rejects(normalizeAudio(p, loadConfig({ FFMPEG_PATH: '/nonexistent/ffmpeg' })), e => e.code === 'AUDIO_TOOLING' && e.status === 500);
});

test('already-aborted signal -> CANCELLED', opts, async () => {
  const input = tone('abort.wav', 1, ['-c:a', 'pcm_s16le']);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(normalizeAudio(input, cfg, { signal: ac.signal }), e => e.code === 'CANCELLED');
});
