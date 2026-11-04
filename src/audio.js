'use strict';
/**
 * Audio normalization with ffmpeg: any decodable audio/video upload -> 16 kHz mono 16-bit WAV.
 * Duration is derived from the WAV size, so ffprobe is not required.
 * Arguments are passed as an array (no shell) and paths are server-generated.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AppError } = require('./errors');
const { safeUnlink } = require('./util');

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // mono, 16-bit
const WAV_HEADER_BYTES = 44;
const DURATION_TOLERANCE_MS = 250;

function formatLimit(seconds) {
  if (seconds >= 120 && seconds % 60 === 0) return `${seconds / 60} minute`;
  return `${seconds} second`;
}

function resolveFfmpeg(cfg) {
  if (cfg && cfg.ffmpegPath) return cfg.ffmpegPath;
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* optional dependency not installed */ }
  return 'ffmpeg';
}

function runFfmpeg(bin, args, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(reject, new AppError('AUDIO_TIMEOUT', 'Processing the audio took too long.', { status: 422 })); }, timeoutMs);
    const onAbort = () => { child.kill('SIGKILL'); done(reject, new AppError('CANCELLED', 'Job was cancelled.', { status: 409 })); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', e => {
      if (e.code === 'ENOENT') done(reject, new AppError('AUDIO_TOOLING', 'Server audio tooling (ffmpeg) is not installed.', { status: 500, details: { bin } }));
      else done(reject, new AppError('AUDIO_TOOLING', 'Could not start audio processing.', { status: 500, details: { message: e.message } }));
    });
    child.on('close', code => {
      if (code === 0) done(resolve);
      else done(reject, new AppError('AUDIO_UNREADABLE', 'This audio file could not be read. Try MP3, M4A, WAV, OGG, WebM or FLAC.', { status: 422, details: { code, stderr } }));
    });
  });
}

/** Exact PCM byte count from the WAV 'data' chunk header; falls back to size - 44 if not found. */
async function wavDataBytes(file, fileSize) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(Math.min(1024, fileSize));
    await fh.read(buf, 0, buf.length, 0);
    let off = 12; // after "RIFF<size>WAVE"
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'data') {
        const avail = fileSize - (off + 8);
        return size === 0 || size > avail ? avail : size; // streaming writers may leave 0/0xFFFFFFFF
      }
      off += 8 + size + (size % 2);
    }
  } catch (_) { /* fall through */ } finally { if (fh) await fh.close(); }
  return Math.max(0, fileSize - WAV_HEADER_BYTES);
}

/**
 * @returns {{ path: string, durationMs: number }}  caller owns (must delete) `path`
 */
async function normalizeAudio(inputPath, cfg, { signal } = {}) {
  const bin = resolveFfmpeg(cfg);
  const outPath = path.join(path.dirname(inputPath), path.basename(inputPath) + '.16k.wav');
  const cap = cfg.maxAudioSeconds + 1; // convert at most 1 s beyond the limit, then reject
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-vn', '-map', '0:a:0',
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-t', String(cap),
    '-c:a', 'pcm_s16le',
    outPath,
  ];
  try {
    await runFfmpeg(bin, args, { timeoutMs: 5 * 60 * 1000, signal });
    const st = await fs.promises.stat(outPath);
    const durationMs = Math.round((await wavDataBytes(outPath, st.size)) / BYTES_PER_SECOND * 1000);
    if (durationMs < 300) throw new AppError('AUDIO_EMPTY', 'No audio was found in this file.', { status: 422 });
    // Small tolerance so a recording at exactly the limit is never rejected by rounding.
    if (durationMs > cfg.maxAudioSeconds * 1000 + DURATION_TOLERANCE_MS) {
      throw new AppError('AUDIO_TOO_LONG', `Audio is longer than the ${formatLimit(cfg.maxAudioSeconds)} limit.`, { status: 413 });
    }
    return { path: outPath, durationMs };
  } catch (e) {
    await safeUnlink(outPath);
    throw e;
  }
}

module.exports = { normalizeAudio, resolveFfmpeg, SAMPLE_RATE };
