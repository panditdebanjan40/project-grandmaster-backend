'use strict';
/**
 * Deepgram pre-recorded transcription (fallback provider).
 *   POST /v1/listen?model=nova-3&keyterm=...   body: raw audio bytes
 * Auth: `Authorization: Token <key>`. Word timestamps are SECONDS (converted to ms here).
 * Deepgram limits keyterms (~100), so the list is truncated.
 *
 * NOTE: built from public docs; NOT exercised against the live API from this build environment.
 */
const fs = require('fs');
const { Readable } = require('stream');
const { AppError } = require('../errors');
const { request } = require('./http');

function createDeepgram(cfg, opts = {}) {
  const { apiKey, baseUrl, model } = cfg.deepgram;
  const retryBaseMs = opts.retryBaseMs == null ? 800 : opts.retryBaseMs;

  return {
    name: 'deepgram',
    async transcribe(filePath, { keyterms = [], signal, onProgress = () => {} } = {}) {
      const params = new URLSearchParams({ model, language: 'en', punctuate: 'true', smart_format: 'false' });
      for (const t of keyterms.slice(0, 100)) params.append('keyterm', t);
      onProgress('stt_uploading');
      const res = await request('deepgram', `${baseUrl}/v1/listen?${params}`, () => ({
        method: 'POST',
        headers: { authorization: `Token ${apiKey}`, 'content-type': 'audio/wav' },
        body: Readable.toWeb(fs.createReadStream(filePath)),
        duplex: 'half',
      }), { timeoutMs: cfg.sttTimeoutMs, retries: 1, retryBaseMs, signal });
      onProgress('stt_processing');
      const json = await res.json().catch(() => ({}));
      const alt = json && json.results && json.results.channels && json.results.channels[0]
        && json.results.channels[0].alternatives && json.results.channels[0].alternatives[0];
      if (!alt) throw new AppError('STT_BAD_RESPONSE', 'The speech provider returned an unexpected response.', { status: 502, details: { keys: Object.keys(json || {}) } });
      const words = (alt.words || []).map(w => ({
        text: w.punctuated_word || w.word,
        startMs: Number.isFinite(w.start) ? Math.round(w.start * 1000) : null,
        endMs: Number.isFinite(w.end) ? Math.round(w.end * 1000) : null,
        confidence: typeof w.confidence === 'number' ? w.confidence : null,
      }));
      return {
        provider: 'deepgram',
        providerJobId: (json.metadata && json.metadata.request_id) || null,
        durationMs: json.metadata && Number.isFinite(json.metadata.duration) ? Math.round(json.metadata.duration * 1000) : null,
        text: alt.transcript || '',
        words,
      };
    },
  };
}

module.exports = { createDeepgram };
