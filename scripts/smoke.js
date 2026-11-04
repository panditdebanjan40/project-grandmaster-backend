#!/usr/bin/env node
'use strict';
/**
 * Upload a REAL recording to a running backend and print the timestamped moves.
 *   API_URL=http://localhost:3000 ACCESS_TOKEN=your-token node scripts/smoke.js recording.m4a
 *   ... --words      also print every recognised word with its timestamp and confidence
 *   ... --json       print the raw final job JSON
 * This is the only script that spends STT credit.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const file = args.find(a => !a.startsWith('--'));
const API = (process.env.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = process.env.ACCESS_TOKEN;
if (!file || !TOKEN) { console.error('Usage: API_URL=... ACCESS_TOKEN=... node scripts/smoke.js <audio file> [--words] [--json]'); process.exit(2); }

const TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm', '.flac': 'audio/flac', '.aac': 'audio/aac', '.3gp': 'audio/3gpp', '.amr': 'audio/amr' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = ms => (ms == null ? '   -   ' : (ms / 1000).toFixed(2).padStart(7) + 's');

async function api(p, init = {}) {
  const res = await fetch(API + p, { ...init, headers: { authorization: 'Bearer ' + TOKEN, ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = body.error || {}; throw new Error(`${res.status} ${e.code || ''} ${e.message || res.statusText}`.trim()); }
  return body;
}

(async () => {
  const buf = fs.readFileSync(file);
  const form = new FormData();
  form.append('audio', new Blob([buf], { type: TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' }), path.basename(file));

  console.log(`Uploading ${path.basename(file)} (${(buf.length / 1048576).toFixed(1)} MB) to ${API} ...`);
  const t0 = Date.now();
  const { id } = await api('/api/jobs', { method: 'POST', body: form });
  console.log('job ' + id);

  let last = '';
  let job;
  for (;;) {
    job = await api(`/api/jobs/${id}` + (flags.has('--words') ? '?include=words' : ''));
    const line = `${job.status} / ${job.stage} ${job.progress}%`;
    if (line !== last) { console.log('  ' + line); last = line; }
    if (job.status === 'done' || job.status === 'error') break;
    await sleep(2000);
  }
  console.log(`finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  if (flags.has('--json')) { console.log(JSON.stringify(job, null, 2)); return; }
  if (job.status === 'error') { console.error('ERROR: ' + job.error.code + ' - ' + job.error.message + (job.error.retryable ? ' (retryable)' : '')); process.exit(1); }

  const { parse, transcript, audio } = job.result;
  console.log(`\naudio ${(audio.durationMs / 1000).toFixed(1)} s, provider ${transcript.provider}, ${transcript.wordCount} words`);
  console.log(`parse status: ${parse.status}   result: ${parse.result}   moves: ${parse.moves.length}\n`);
  for (const m of parse.moves) {
    console.log(`${String(m.index + 1).padStart(3)}  ${m.san.padEnd(8)} ${t(m.startMs)}  conf=${m.confidence == null ? ' - ' : m.confidence.toFixed(2)}  "${m.heard}"${m.warnings.length ? '  ! ' + m.warnings.join(',') : ''}`);
  }
  if (parse.pgn) console.log('\nPGN: ' + parse.pgn);
  if (parse.unresolved) {
    const u = parse.unresolved;
    console.log(`\nNEEDS REVIEW at move ${u.index + 1}: ${u.type}; heard "${u.heard}" (word ${u.wordIndex}, ${t(u.startMs).trim()})`);
    console.log('  candidates: ' + (u.candidates.map(c => c.san).join(', ') || '(none)'));
  }
  if (parse.leftover.length) console.log('\nchess-like words not used: ' + parse.leftover.map(l => `"${l.text}"@${t(l.startMs).trim()}`).join(', '));
  if (flags.has('--words') && transcript.words) {
    console.log('\nWORDS (index  start  end  conf  text)');
    transcript.words.forEach((w, i) => console.log(`${String(i).padStart(4)} ${t(w.startMs)} ${t(w.endMs)}  ${w.confidence == null ? ' - ' : w.confidence.toFixed(2)}  ${w.text}`));
  }
  await api(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
