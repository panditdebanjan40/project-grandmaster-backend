'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { AppError, toPublic } = require('./errors');
const { requireAuth } = require('./auth');
const { validateJobId, validateOverrides } = require('./validate');
const { randomId, safeUnlink } = require('./util');

const ACCEPTED_TYPES = /^(audio\/|video\/(mp4|webm|3gpp|quicktime)|application\/(octet-stream|ogg))/i;

function createApp({ cfg, logger, jobs, version = '0.1.0' }) {
  fs.mkdirSync(cfg.tmpDir, { recursive: true, mode: 0o700 });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);
  app.use(helmet());

  const corsOptions = {
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl / server-to-server (still needs a token)
      if (cfg.allowedOrigins.includes(origin)) return cb(null, true);
      if (cfg.allowedOrigins.length === 0 && cfg.env !== 'production') return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: ['Retry-After'],
    maxAge: 600,
  };
  app.use(cors(corsOptions));

  // Health: no auth, no secrets. Also lets the frontend wake a sleeping Render instance.
  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, version, sttProvider: cfg.sttProvider, maxAudioSeconds: cfg.maxAudioSeconds, maxUploadBytes: cfg.maxUploadBytes });
  });

  const rlHandler = (_req, res) => {
    const e = new AppError('RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.', { status: 429, retryable: true });
    res.status(429).json({ error: toPublic(e) });
  };
  app.use('/api', rateLimit({
    windowMs: cfg.rateLimitWindowMs, limit: cfg.rateLimitMax,
    standardHeaders: 'draft-7', legacyHeaders: false, handler: rlHandler,
  }));

  app.use('/api', requireAuth(cfg.accessTokens));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const createLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, limit: cfg.jobCreateLimitMax,
    standardHeaders: 'draft-7', legacyHeaders: false, handler: rlHandler,
    keyGenerator: req => 'tok:' + req.clientId,
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, cfg.tmpDir),
      filename: (_req, _file, cb) => cb(null, randomId(16)), // never use the client's filename
    }),
    limits: { fileSize: cfg.maxUploadBytes, files: 1, fields: 5, parts: 8 },
    fileFilter: (_req, file, cb) => {
      if (ACCEPTED_TYPES.test(file.mimetype || '')) return cb(null, true);
      cb(new AppError('UNSUPPORTED_TYPE', 'Please upload an audio file (MP3, M4A, WAV, OGG, WebM, FLAC).', { status: 415 }));
    },
  }).single('audio');

  app.post('/api/jobs', createLimiter,
    (_req, _res, next) => (jobs.hasCapacity() ? next()
      : next(new AppError('SERVER_BUSY', 'The server is busy processing other recordings. Try again in a minute.', { status: 503, retryable: true }))),
    (req, res, next) => upload(req, res, err => (err ? next(err) : next())),
    (req, res, next) => {
      const file = req.file;
      if (!file) return next(new AppError('NO_FILE', 'No audio file received. Send it as multipart field "audio".', { status: 400 }));
      if (!file.size) { safeUnlink(file.path); return next(new AppError('EMPTY_FILE', 'The uploaded file is empty.', { status: 400 })); }
      try {
        const job = jobs.create({ ownerId: req.clientId, audioPath: file.path, size: file.size });
        res.status(202).json({ id: job.id, status: job.status, pollUrl: `/api/jobs/${job.id}` });
      } catch (e) { safeUnlink(file.path); next(e); }
    });

  app.get('/api/jobs/:id', (req, res, next) => {
    try {
      const job = jobs.get(validateJobId(req.params.id), req.clientId);
      res.json(jobs.view(job, { includeWords: req.query.include === 'words' }));
    } catch (e) { next(e); }
  });

  app.post('/api/jobs/:id/reparse', express.json({ limit: '100kb' }), (req, res, next) => {
    try {
      const id = validateJobId(req.params.id);
      const overrides = validateOverrides(req.body);
      const parse = jobs.reparse(id, req.clientId, overrides);
      res.json({ id, parse });
    } catch (e) { next(e); }
  });

  app.delete('/api/jobs/:id', async (req, res, next) => {
    try {
      await jobs.cancel(validateJobId(req.params.id), req.clientId);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'No such endpoint.', { status: 404 })));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let e = err;
    if (err instanceof multer.MulterError) {
      e = err.code === 'LIMIT_FILE_SIZE'
        ? new AppError('UPLOAD_TOO_LARGE', `File is larger than the ${Math.round(cfg.maxUploadBytes / 1048576)} MB upload limit.`, { status: 413 })
        : new AppError('UPLOAD_INVALID', 'The upload was not valid. Send one file in the "audio" field.', { status: 400 });
    } else if (!(err instanceof AppError) && err && /multipart|boundary|unexpected end of form|malformed part|missing content-type/i.test(String(err.message))) {
      e = new AppError('UPLOAD_INVALID', 'The upload was not valid. Send one file in the "audio" field.', { status: 400 });
    } else if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      e = new AppError('VALIDATION', 'Request body is not valid JSON or is too large.', { status: 400 });
    }
    if (!(e instanceof AppError)) logger.error('unhandled error', { message: err && err.message, stack: err && err.stack });
    if (req.file) safeUnlink(req.file.path);
    const pub = toPublic(e);
    const status = e instanceof AppError ? e.status : 500;
    if (status === 503 && pub.retryable) res.set('Retry-After', '30');
    res.status(status).json({ error: pub });
  });

  return app;
}

module.exports = { createApp };
