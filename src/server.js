'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadConfig, validateForStartup } = require('./config');
const { createLogger } = require('./logger');
const { createProvider } = require('./stt');
const { normalizeAudio } = require('./audio');
const { parseGame } = require('./parser');
const { createPipeline } = require('./pipeline');
const { JobManager } = require('./jobs');
const { createApp } = require('./app');

function main() {
  const cfg = loadConfig(process.env);
  const logger = createLogger(cfg.logLevel, console, [cfg.assemblyai.apiKey, cfg.deepgram.apiKey, ...cfg.accessTokens]);
  const problems = validateForStartup(cfg);
  if (problems.length) {
    console.error('Configuration problems:\n - ' + problems.join('\n - '));
    console.error('See .env.example and README.md.');
    process.exit(1);
  }

  fs.mkdirSync(cfg.tmpDir, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(cfg.tmpDir)) { try { fs.unlinkSync(path.join(cfg.tmpDir, f)); } catch (_) { /* ignore */ } } // orphans from a crash

  const provider = createProvider(cfg);
  const pipeline = createPipeline({ cfg, provider, normalizeAudio, parseGame, logger });
  const jobs = new JobManager({ cfg, logger, pipeline, parseGame });
  const app = createApp({ cfg, logger, jobs });

  const server = app.listen(cfg.port, '0.0.0.0', () => {
    logger.info(`grandmaster-backend listening on :${cfg.port}`, { provider: cfg.sttProvider, maxAudioSeconds: cfg.maxAudioSeconds });
  });
  server.requestTimeout = 15 * 60 * 1000; // slow mobile uploads
  server.headersTimeout = 60 * 1000;

  const shutdown = async sig => {
    logger.info(`${sig} received, shutting down`);
    server.close();
    await jobs.shutdown();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main();
module.exports = { main };
