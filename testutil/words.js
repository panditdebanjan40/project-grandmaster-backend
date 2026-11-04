'use strict';
/**
 * Build a SYNTHETIC word list (what an STT provider would return) from plain text.
 * Timestamps are invented, evenly spaced. Use only to test parsing / timestamp pass-through.
 * These fixtures say NOTHING about real speech-recognition accuracy.
 */
function speak(text, { startMs = 1000, stepMs = 600, durMs = 400, confidence = 0.95, confidences = {} } = {}) {
  return text.split(/\s+/).filter(Boolean).map((t, i) => ({
    text: t,
    startMs: startMs + i * stepMs,
    endMs: startMs + i * stepMs + durMs,
    confidence: confidences[i] != null ? confidences[i] : confidence,
  }));
}
module.exports = { speak };
