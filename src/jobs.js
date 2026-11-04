'use strict';
const { AppError, toPublic } = require('./errors');
const { randomId, safeUnlink } = require('./util');

/**
 * In-memory job manager. State is lost on restart (Render free tier restarts/spins down),
 * so clients must treat 404 as "job gone, upload again".
 */
class JobManager {
  constructor({ cfg, logger, pipeline, parseGame, now = () => Date.now() }) {
    this.cfg = cfg; this.logger = logger; this.pipeline = pipeline; this.parseGame = parseGame; this.now = now;
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  activeCount() { return this.queue.length + this.running; }
  hasCapacity() { return this.activeCount() < this.cfg.maxConcurrentJobs + this.cfg.maxQueuedJobs; }

  create({ ownerId, audioPath, size }) {
    if (!this.hasCapacity()) throw new AppError('SERVER_BUSY', 'The server is busy processing other recordings. Try again in a minute.', { status: 503, retryable: true });
    const t = this.now();
    const job = {
      id: randomId(16), ownerId, audioPath, size,
      status: 'queued', stage: 'queued', progress: 3,
      createdAt: t, updatedAt: t, expiresAt: t + this.cfg.jobTtlMs,
      result: null, error: null, controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    setImmediate(() => this.pump());
    return job;
  }

  pump() {
    while (this.running < this.cfg.maxConcurrentJobs && this.queue.length) {
      const job = this.queue.shift();
      if (job.status !== 'queued') continue;
      this.running++;
      this.execute(job).finally(() => { this.running--; this.pump(); });
    }
  }

  async execute(job) {
    const setStage = (stage, progress) => {
      if (job.status !== 'processing') return;
      job.stage = stage; job.progress = Math.max(job.progress, progress); job.updatedAt = this.now();
    };
    job.status = 'processing';
    setStage('starting', 8);
    let result = null;
    let failure = null;
    try {
      result = await this.pipeline(job, { signal: job.controller.signal, setStage });
    } catch (e) {
      failure = e;
    }
    // Remove the upload BEFORE publishing the final status, so a client that sees
    // "done"/"error" can rely on the temp file already being gone.
    if (job.audioPath) { await safeUnlink(job.audioPath); job.audioPath = null; }
    if (job.status === 'cancelled') {
      // cancel() already handled cleanup and removed the job
    } else if (failure) {
      job.status = 'error'; job.stage = 'error';
      job.error = toPublic(failure);
      this.logger.warn('job failed', { jobId: job.id, code: job.error.code, details: failure && failure.details });
    } else {
      job.result = result;
      job.status = 'done'; job.stage = 'done'; job.progress = 100;
    }
    job.updatedAt = this.now();
    job.expiresAt = this.now() + this.cfg.jobTtlMs;
  }

  get(id, ownerId) {
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) throw new AppError('JOB_NOT_FOUND', 'Job not found. It may have expired or the server restarted; upload the audio again.', { status: 404 });
    return job;
  }

  async cancel(id, ownerId) {
    const job = this.get(id, ownerId);
    if (job.status === 'queued' || job.status === 'processing') { job.status = 'cancelled'; job.controller.abort(); }
    await safeUnlink(job.audioPath); job.audioPath = null;
    this.queue = this.queue.filter(j => j !== job);
    this.jobs.delete(id);
  }

  /** Re-run ONLY the chess parser on stored words with human overrides (no STT cost). */
  reparse(id, ownerId, overrides) {
    const job = this.get(id, ownerId);
    if (job.status !== 'done') throw new AppError('JOB_NOT_READY', 'This job has no transcript to re-parse.', { status: 409 });
    const parse = this.parseGame(job.result.transcript.words, { overrides });
    job.result.parse = parse;
    job.updatedAt = this.now();
    return parse;
  }

  view(job, { includeWords = false } = {}) {
    const out = {
      id: job.id, status: job.status, stage: job.stage, progress: job.progress,
      createdAt: new Date(job.createdAt).toISOString(), expiresAt: new Date(job.expiresAt).toISOString(),
    };
    if (job.status === 'error') out.error = job.error;
    if (job.status === 'done') {
      const { transcript, ...rest } = job.result;
      out.result = { ...rest, transcript: { provider: transcript.provider, wordCount: transcript.wordCount, text: transcript.text } };
      if (includeWords) out.result.transcript.words = transcript.words;
    }
    return out;
  }

  sweep() {
    const t = this.now();
    for (const [id, job] of this.jobs) {
      if ((job.status === 'done' || job.status === 'error') && job.expiresAt <= t) this.jobs.delete(id);
    }
  }

  async shutdown() {
    clearInterval(this.sweeper);
    for (const job of this.jobs.values()) { job.controller.abort(); await safeUnlink(job.audioPath); }
  }
}

module.exports = { JobManager };
