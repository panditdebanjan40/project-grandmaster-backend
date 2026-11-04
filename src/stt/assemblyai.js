'use strict';
/**
 * AssemblyAI pre-recorded transcription (REST):
 *   POST /v2/upload            (raw bytes)            -> { upload_url }
 *   POST /v2/transcript        { audio_url, ... }     -> { id }
 *   GET  /v2/transcript/:id    poll until completed|error
 *   DELETE /v2/transcript/:id  remove stored transcript
 * Auth header is the raw API key in `authorization` (no "Bearer").
 * Word timestamps are milliseconds.
 *
 * NOTE: request/response shapes were taken from AssemblyAI's public docs but
 * have NOT been exercised against the live API from this build environment.
 */
const fs = require('fs');
const { Readable } = require('stream');
const { AppError } = require('../errors');
const { sleep } = require('../util');
const { request } = require('./http');

function createAssemblyAI(cfg, opts = {}) {
  const { apiKey, baseUrl, speechModels } = cfg.assemblyai;
  const retryBaseMs = opts.retryBaseMs == null ? 800 : opts.retryBaseMs;
  const headers = { authorization: apiKey };

  async function upload(filePath, signal) {
    const res = await request('assemblyai', `${baseUrl}/v2/upload`, () => ({
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: Readable.toWeb(fs.createReadStream(filePath)),
      duplex: 'half',
    }), { timeoutMs: 10 * 60 * 1000, retries: 1, retryBaseMs, signal });
    const json = await res.json().catch(() => ({}));
    if (!json.upload_url) throw new AppError('STT_BAD_RESPONSE', 'The speech provider returned an unexpected upload response.', { status: 502, details: json });
    return json.upload_url;
  }

  async function submit(audioUrl, keyterms, signal) {
    const body = {
      audio_url: audioUrl,
      speech_models: speechModels,
      language_code: 'en',
    };
    if (keyterms && keyterms.length) body.keyterms_prompt = keyterms;
    const res = await request('assemblyai', `${baseUrl}/v2/transcript`, () => ({
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), { timeoutMs: 60000, retries: 2, retryBaseMs, signal });
    const json = await res.json().catch(() => ({}));
    if (!json.id) throw new AppError('STT_BAD_RESPONSE', 'The speech provider returned an unexpected response.', { status: 502, details: json });
    return json.id;
  }

  async function poll(id, { signal, pollMs, timeoutMs, onProgress }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await request('assemblyai', `${baseUrl}/v2/transcript/${encodeURIComponent(id)}`, () => ({
        method: 'GET', headers,
      }), { timeoutMs: 30000, retries: 2, retryBaseMs, signal });
      const json = await res.json().catch(() => ({}));
      if (json.status === 'completed') return json;
      if (json.status === 'error') {
        throw new AppError('STT_FAILED', 'The speech provider could not transcribe this audio.', { status: 502, details: { error: json.error } });
      }
      if (onProgress) onProgress(json.status === 'queued' ? 'stt_queued' : 'stt_processing');
      if (Date.now() > deadline) throw new AppError('STT_TIMEOUT', 'Transcription took too long. Try again or use a shorter recording.', { status: 504, retryable: true });
      await sleep(pollMs, signal);
    }
  }

  function normalize(json) {
    const words = (json.words || [])
      .filter(w => w && typeof w.text === 'string')
      .map(w => ({
        text: w.text,
        startMs: Number.isFinite(w.start) ? Math.round(w.start) : null,
        endMs: Number.isFinite(w.end) ? Math.round(w.end) : null,
        confidence: typeof w.confidence === 'number' ? w.confidence : null,
      }));
    return {
      provider: 'assemblyai',
      providerJobId: json.id,
      durationMs: Number.isFinite(json.audio_duration) ? Math.round(json.audio_duration * 1000) : null,
      text: json.text || '',
      words,
    };
  }

  async function remove(id) {
    try {
      await request('assemblyai', `${baseUrl}/v2/transcript/${encodeURIComponent(id)}`, () => ({ method: 'DELETE', headers }), { timeoutMs: 20000, retries: 1, retryBaseMs });
    } catch (_) { /* best effort */ }
  }

  return {
    name: 'assemblyai',
    async transcribe(filePath, { keyterms = [], signal, onProgress = () => {} } = {}) {
      onProgress('stt_uploading');
      const audioUrl = await upload(filePath, signal);
      const id = await submit(audioUrl, keyterms, signal);
      onProgress('stt_queued');
      const json = await poll(id, { signal, pollMs: cfg.sttPollIntervalMs, timeoutMs: cfg.sttTimeoutMs, onProgress });
      const out = normalize(json);
      remove(id); // fire and forget: do not keep audio-derived data at the provider
      return out;
    },
  };
}

module.exports = { createAssemblyAI };
