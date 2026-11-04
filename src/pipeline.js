'use strict';
const { KEYTERMS } = require('./parser/vocab');
const { safeUnlink } = require('./util');

/**
 * Pipeline: normalize audio -> speech-to-text (word timestamps) -> chess parse.
 * Dependencies are injected so tests can substitute fakes.
 */
function createPipeline({ cfg, provider, normalizeAudio, parseGame, logger }) {
  return async function run(job, { signal, setStage }) {
    let normalized = null;
    try {
      setStage('normalizing', 12);
      normalized = await normalizeAudio(job.audioPath, cfg, { signal });

      const stt = await provider.transcribe(normalized.path, {
        keyterms: KEYTERMS,
        signal,
        onProgress: stage => {
          const map = { stt_uploading: 30, stt_queued: 40, stt_processing: 55 };
          setStage(stage, map[stage] || 50);
        },
      });

      setStage('parsing', 90);
      const parse = parseGame(stt.words);
      logger.info('job parsed', { jobId: job.id, words: stt.words.length, moves: parse.moves.length, status: parse.status });

      return {
        audio: { durationMs: normalized.durationMs },
        transcript: {
          provider: stt.provider,
          wordCount: stt.words.length,
          text: stt.text,
          words: stt.words,
        },
        parse,
      };
    } finally {
      await safeUnlink(job.audioPath);
      if (normalized) await safeUnlink(normalized.path);
      job.audioPath = null;
    }
  };
}

module.exports = { createPipeline };
