'use strict';
const { createAssemblyAI } = require('./assemblyai');
const { createDeepgram } = require('./deepgram');

/** Provider factory. To add a provider, implement { name, transcribe(path, {keyterms, signal, onProgress}) }. */
function createProvider(cfg, opts) {
  switch (cfg.sttProvider) {
    case 'assemblyai': return createAssemblyAI(cfg, opts);
    case 'deepgram': return createDeepgram(cfg, opts);
    default: throw new Error('Unknown STT provider: ' + cfg.sttProvider);
  }
}

module.exports = { createProvider };
