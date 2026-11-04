#!/usr/bin/env node
'use strict';
/**
 * Try the spoken-move parser on typed text (no audio, no API key, no network).
 *   npm run parse -- "e4 e5 knight f3 knight c6 bishop b5"
 *   npm run parse -- --json "e4 e5"
 *   npm run parse -- --override 6=Nbd2 "d3 d6 knight f3 knight f6 knight d2"
 * Needs chess.js (npm install). Timestamps are synthetic (600 ms apart).
 */
const { parseGame } = require('../src/parser');
const { speak } = require('../testutil/words');

const args = process.argv.slice(2);
let asJson = false;
const overrides = {};
const text = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') asJson = true;
  else if (args[i] === '--override') {
    const [k, v] = String(args[++i] || '').split('=');
    if (!/^\d+$/.test(k || '') || !v) { console.error('Use --override <wordIndex>=<SAN>, e.g. --override 6=Nbd2'); process.exit(2); }
    overrides[k] = { san: v };
  } else text.push(args[i]);
}
if (!text.length) { console.error('Usage: npm run parse -- [--json] [--override idx=SAN] "e4 e5 knight f3"'); process.exit(2); }

const words = speak(text.join(' '));
const r = parseGame(words, { overrides });
if (asJson) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }

console.log(`status: ${r.status}   result: ${r.result}   moves: ${r.moves.length}`);
for (const m of r.moves) {
  console.log(`${String(m.index + 1).padStart(3)}  ${m.san.padEnd(8)} t=${m.startMs == null ? '  -  ' : (m.startMs / 1000).toFixed(2) + 's'}  heard="${m.heard}"  [${m.source}]${m.warnings.length ? '  ! ' + m.warnings.join(',') : ''}`);
}
if (r.pgn) console.log('\nPGN: ' + r.pgn);
if (r.unresolved) {
  const u = r.unresolved;
  console.log(`\nNEEDS REVIEW at move ${u.index + 1} (${u.turn === 'w' ? 'white' : 'black'}): ${u.type}`);
  console.log(`  heard "${u.heard}" at word index ${u.wordIndex}`);
  console.log('  candidates: ' + (u.candidates.map(c => c.san).join(', ') || '(none)'));
  console.log('  fix with:   npm run parse -- --override ' + u.wordIndex + '=<SAN> "..."');
}
if (r.leftover.length) console.log('\nchess-like words not used in any move: ' + r.leftover.map(l => `"${l.text}"`).join(', '));
for (const w of r.warnings) console.log('warning: ' + JSON.stringify(w));
