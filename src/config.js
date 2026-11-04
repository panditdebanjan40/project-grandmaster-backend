'use strict';
/**
 * Central configuration. All values come from environment variables.
 * loadConfig(env) is pure so tests can pass their own env object.
 */
const path = require('path');
const os = require('os');

function int(env, name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}="${raw}": expected integer in [${min}, ${max}]`);
  }
  return n;
}

function list(env, name) {
  return (env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
}

function loadConfig(env = process.env) {
  const sttProvider = (env.STT_PROVIDER || 'assemblyai').toLowerCase();
  if (!['assemblyai', 'deepgram'].includes(sttProvider)) {
    throw new Error(`Invalid STT_PROVIDER="${env.STT_PROVIDER}": use "assemblyai" or "deepgram"`);
  }
  const cfg = {
    env: env.NODE_ENV || 'development',
    port: int(env, 'PORT', 3000, { min: 0, max: 65535 }),
    logLevel: env.LOG_LEVEL || 'info',

    // Security
    accessTokens: list(env, 'ACCESS_TOKENS'),
    allowedOrigins: list(env, 'ALLOWED_ORIGINS'),
    trustProxy: int(env, 'TRUST_PROXY_HOPS', 1, { min: 0, max: 10 }),
    rateLimitWindowMs: int(env, 'RATE_LIMIT_WINDOW_SEC', 60, { min: 1 }) * 1000,
    rateLimitMax: int(env, 'RATE_LIMIT_MAX', 60, { min: 1 }),
    jobCreateLimitMax: int(env, 'JOB_CREATE_LIMIT_PER_HOUR', 20, { min: 1 }),

    // Audio limits
    maxAudioSeconds: int(env, 'MAX_AUDIO_SECONDS', 600, { min: 1, max: 7200 }),
    maxUploadBytes: int(env, 'MAX_UPLOAD_MB', 100, { min: 1, max: 1024 }) * 1024 * 1024,
    tmpDir: env.TMP_DIR || path.join(os.tmpdir(), 'grandmaster'),
    ffmpegPath: env.FFMPEG_PATH || '',
    ffprobePath: env.FFPROBE_PATH || '',

    // Jobs
    jobTtlMs: int(env, 'JOB_TTL_MIN', 60, { min: 1 }) * 60 * 1000,
    maxConcurrentJobs: int(env, 'MAX_CONCURRENT_JOBS', 1, { min: 1, max: 8 }),
    maxQueuedJobs: int(env, 'MAX_QUEUED_JOBS', 5, { min: 0, max: 100 }),

    // STT
    sttProvider,
    sttPollIntervalMs: int(env, 'STT_POLL_INTERVAL_MS', 3000, { min: 50 }),
    sttTimeoutMs: int(env, 'STT_TIMEOUT_SEC', 600, { min: 5 }) * 1000,
    assemblyai: {
      apiKey: env.ASSEMBLYAI_API_KEY || '',
      baseUrl: (env.ASSEMBLYAI_BASE_URL || 'https://api.assemblyai.com').replace(/\/+$/, ''),
      speechModels: list(env, 'ASSEMBLYAI_SPEECH_MODELS').length
        ? list(env, 'ASSEMBLYAI_SPEECH_MODELS')
        : ['universal-3-5-pro', 'universal-2'],
    },
    deepgram: {
      apiKey: env.DEEPGRAM_API_KEY || '',
      baseUrl: (env.DEEPGRAM_BASE_URL || 'https://api.deepgram.com').replace(/\/+$/, ''),
      model: env.DEEPGRAM_MODEL || 'nova-3',
    },
  };
  return cfg;
}

/** Fail-fast checks for production start-up. Returns an array of problems. */
function validateForStartup(cfg) {
  const problems = [];
  if (cfg.accessTokens.length === 0) problems.push('ACCESS_TOKENS is empty: set at least one token (16+ chars).');
  for (const t of cfg.accessTokens) if (t.length < 16) problems.push('Every ACCESS_TOKENS entry must be at least 16 characters.');
  const p = cfg[cfg.sttProvider];
  if (!p.apiKey) problems.push(`${cfg.sttProvider.toUpperCase()}_API_KEY is missing.`);
  if (cfg.env === 'production' && cfg.allowedOrigins.length === 0) problems.push('ALLOWED_ORIGINS must be set in production (your Netlify URL).');
  return problems;
}

module.exports = { loadConfig, validateForStartup };
