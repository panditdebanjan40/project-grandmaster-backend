'use strict';

/**
 * AppError: `message` is ALWAYS safe to show to a client.
 * Raw provider/ffmpeg output goes in `details` (logged server-side only).
 */
class AppError extends Error {
  constructor(code, message, { status = 500, retryable = false, cause, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
    if (details !== undefined) this.details = details;
  }
}

function toPublic(err) {
  if (err instanceof AppError) return { code: err.code, message: err.message, retryable: !!err.retryable };
  return { code: 'INTERNAL', message: 'Something went wrong on the server.', retryable: false };
}

module.exports = { AppError, toPublic };
