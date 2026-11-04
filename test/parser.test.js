'use strict';
/**
 * Engine-backed parser tests. REQUIRES chess.js 0.10.3 (npm install first).
 * Input words are SYNTHETIC (evenly spaced fake timestamps from testutil/words.js):
 * these tests verify move parsing, legality checking and timestamp pass-through,
 * NOT speech-recognition accuracy.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Chess } = require('chess.js');
const { parseGame } = require('../src/parser');
const { speak } = require('../testutil/words');

const run = (text, opts, speakOpts) => parseGame(speak(text, speakOpts), opts);
const sans = r => r.moves.map(m => m.san);

const SCHOLAR = 'e4 e5 bishop c4 knight c6 queen h5 knight f6 queen takes f7 checkmate';
const RUY = 'e4 e5 knight f3 knight c6 bishop b5 a6 bishop a4 knight f6 castles kingside bishop e7';
const PROMO = 'g4 h5 g takes h5 knight f6 h6 knight g4 h takes g7 knight f6';
const AMBIG = 'd3 d6 knight f3 knight f6';

test('Scholar\'s mate: SAN, PGN, result, final position', () => {
  const r = run(SCHOLAR);
  assert.equal(r.status, 'complete');
  assert.deepEqual(sans(r), ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']);
  assert.equal(r.pgn, '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0');
  assert.equal(r.result, '1-0');
  assert.equal(r.unresolved, null);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.moves[6].captured, 'p');
  assert.equal(r.moves[6].color, 'w');
});

test('timestamps, word index and heard text come from the right words', () => {
  const r = run(SCHOLAR, {}, { startMs: 1000, stepMs: 600, durMs: 400 });
  // words: e4(0) e5(1) bishop(2) c4(3) knight(4) c6(5) queen(6) h5(7) knight(8) f6(9) queen(10) takes(11) f7(12) checkmate(13)
  assert.equal(r.moves[0].startMs, 1000); assert.equal(r.moves[0].endMs, 1400);
  assert.equal(r.moves[1].startMs, 1600);
  assert.equal(r.moves[2].startMs, 2200); assert.equal(r.moves[2].endMs, 3200);
  assert.equal(r.moves[2].heard, 'bishop c4'); assert.equal(r.moves[2].wordIndex, 2);
  assert.equal(r.moves[6].startMs, 7000); assert.equal(r.moves[6].endMs, 8600);
  assert.equal(r.moves[6].heard, 'queen takes f7'); assert.equal(r.moves[6].wordIndex, 10);
  for (let i = 1; i < r.moves.length; i++) assert.ok(r.moves[i].startMs > r.moves[i - 1].startMs);
  assert.ok(r.moves.every(m => m.source === 'speech'));
});

test('every returned fen/pgn replays in a fresh engine and loads as PGN', () => {
  for (const text of [SCHOLAR, RUY, PROMO + ' g takes h8 equals queen']) {
    const r = run(text);
    assert.equal(r.status, 'complete', text);
    const g = new Chess();
    r.moves.forEach(m => { const x = g.move(m.san); assert.ok(x, m.san); assert.equal(g.fen(), m.fen); });
    assert.equal(g.fen(), r.finalFen);
    assert.equal(new Chess().load_pgn(r.pgn), true, r.pgn);
    assert.equal(new Chess().load_pgn(r.pgn, { sloppy: true }), true);
  }
});

test('Ruy Lopez with castling and disambiguation-free piece moves', () => {
  const r = run(RUY);
  assert.deepEqual(sans(r), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7']);
  assert.equal(r.result, '*');
});

test('castling in every spoken form gives the same move', () => {
  const pre = 'e4 e5 knight f3 knight c6 bishop c4 bishop c5';
  for (const form of ['castles', 'castles kingside', 'castles king side', 'short castle', 'O-O', '0-0', 'oh oh', 'zero zero']) {
    const r = run(pre + ' ' + form);
    assert.equal(r.status, 'complete', form);
    assert.equal(sans(r)[6], 'O-O', form); // 6 moves precede it: e4 e5 Nf3 Nc6 Bc4 Bc5
  }
});

test('pawn captures: "e takes d5", "exd5", "e x d5"', () => {
  for (const form of ['e takes d five', 'exd5', 'e x d5', 'Exd5.']) {
    const r = run('e4 d5 ' + form);
    assert.equal(r.status, 'complete', form);
    assert.equal(sans(r)[2], 'exd5', form);
  }
});

test('capitalised, punctuated STT-style output', () => {
  const r = run('E4. E5. Knight F3. Knight C6. Bishop B5.');
  assert.deepEqual(sans(r), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
});

test('spoken square homophones', () => {
  const r = run('e for e five knight eff three night see six');
  assert.deepEqual(sans(r), ['e4', 'e5', 'Nf3', 'Nc6']);
});

test('move numbers and commentary are ignored', () => {
  const r = run('move one white plays e4 black replies e5 and then white knight f3');
  assert.deepEqual(sans(r), ['e4', 'e5', 'Nf3']);
  assert.deepEqual(r.leftover, []);
  assert.deepEqual(r.warnings, []);
});

// ---------- ambiguity / illegal / review flow ----------
test('ambiguous move stops the parse with candidates and context', () => {
  const r = run(AMBIG + ' knight d2');
  assert.equal(r.status, 'needs_review');
  assert.equal(r.moves.length, 4);
  const u = r.unresolved;
  assert.equal(u.type, 'ambiguous');
  assert.equal(u.index, 4);
  assert.equal(u.heard, 'knight d2');
  assert.equal(u.wordIndex, 6);
  assert.equal(u.turn, 'w');
  assert.deepEqual(u.candidates.map(c => c.san).sort(), ['Nbd2', 'Nfd2']);
  assert.ok(u.legalMoves.includes('Nbd2') && u.legalMoves.length > 2);
  assert.ok(u.fen.includes(' w '));
  assert.ok(!sans(r).includes('Nbd2') && !sans(r).includes('Nfd2'), 'nothing guessed');
});

test('spoken disambiguation resolves it: "knight b d2", "Nbd2"', () => {
  for (const form of ['knight b d2', 'knight b d two', 'Nbd2']) {
    const r = run(AMBIG + ' ' + form);
    assert.equal(r.status, 'complete', form);
    assert.equal(sans(r)[4], 'Nbd2', form);
  }
  assert.equal(sans(run(AMBIG + ' knight f d2'))[4], 'Nfd2');
});

test('override resolves an ambiguity without any new speech input', () => {
  const r = run(AMBIG + ' knight d2', { overrides: { 6: { san: 'Nbd2' } } });
  assert.equal(r.status, 'complete');
  assert.equal(r.moves[4].san, 'Nbd2');
  assert.equal(r.moves[4].source, 'override');
  assert.equal(r.moves[4].startMs, speak(AMBIG + ' knight d2')[6].startMs, 'keeps the spoken timestamp');
});

test('override with an illegal move is reported, not applied', () => {
  const r = run(AMBIG + ' knight d2', { overrides: { 6: { san: 'Ke3' } } });
  assert.equal(r.status, 'needs_review');
  assert.equal(r.unresolved.type, 'override_illegal');
  assert.equal(r.unresolved.override, 'Ke3');
  assert.equal(r.moves.length, 4);
});

test('illegal move: pawn cannot move there', () => {
  const r = run('e4 e4');
  assert.equal(r.status, 'needs_review');
  assert.equal(r.unresolved.type, 'illegal');
  assert.equal(r.unresolved.index, 1);
  assert.equal(r.moves.length, 1);
  assert.ok(r.unresolved.legalMoves.includes('e5'));
});

test('illegal move: no knight can reach the square; candidates list same-piece moves', () => {
  const r = run('e4 e5 knight f6');
  assert.equal(r.unresolved.type, 'illegal');
  assert.ok(r.unresolved.candidates.map(c => c.san).includes('Nf3'));
});

test('spoken "takes" on an empty square is illegal (not silently forgiven)', () => {
  const r = run('e4 e5 knight takes f3');
  assert.equal(r.unresolved.type, 'illegal');
});

test('a dropped move is detected, and insertBefore repairs it (inserted move has no timestamp)', () => {
  const text = 'e4 e5 knight f3 bishop b5'; // black\'s Nc6 was not recognised
  const bad = run(text);
  assert.equal(bad.status, 'needs_review');
  assert.equal(bad.unresolved.type, 'illegal');
  assert.equal(bad.unresolved.wordIndex, 4);
  const fixed = run(text, { overrides: { 4: { insertBefore: ['Nc6'] } } });
  assert.equal(fixed.status, 'complete');
  assert.deepEqual(sans(fixed), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
  assert.equal(fixed.moves[3].source, 'inserted');
  assert.equal(fixed.moves[3].startMs, null);
  assert.equal(fixed.moves[4].source, 'speech');
});

test('skip override ignores a phrase that was not a move', () => {
  const text = 'e4 e5 e6 knight f3';
  assert.equal(run(text).unresolved.type, 'illegal');
  const r = run(text, { overrides: { 2: { skip: true } } });
  assert.equal(r.status, 'complete');
  assert.deepEqual(sans(r), ['e4', 'e5', 'Nf3']);
});

test('chess-looking words that are not part of a move are reported as leftover', () => {
  const r = run('e4 e5 rook knight f3');
  assert.equal(r.status, 'complete');
  assert.deepEqual(sans(r), ['e4', 'e5', 'Nf3']);
  assert.equal(r.leftover.length, 1);
  assert.equal(r.leftover[0].text, 'rook');
  assert.equal(r.leftover[0].afterMove, 2);
  assert.ok(r.warnings.some(w => w.code === 'unparsed_chess_words'));
});

// ---------- promotion ----------
test('promotion with capture: "g takes h8 equals queen" and compact forms', () => {
  for (const form of ['g takes h8 equals queen', 'g takes h8 promotes to queen', 'g takes h8 queen', 'gxh8=Q', 'g x h8 equals queen']) {
    const r = run(PROMO + ' ' + form);
    assert.equal(r.status, 'complete', form);
    const last = r.moves[r.moves.length - 1];
    assert.equal(last.san, 'gxh8=Q', form);
    assert.equal(last.promotion, 'q'); assert.equal(last.captured, 'r');
  }
  assert.equal(run(PROMO + ' g takes h8 equals knight').moves.pop().san, 'gxh8=N');
});

test('promotion piece missing -> needs_promotion with all four candidates, nothing guessed', () => {
  const r = run(PROMO + ' g takes h8');
  assert.equal(r.status, 'needs_review');
  assert.equal(r.unresolved.type, 'needs_promotion');
  assert.deepEqual(r.unresolved.candidates.map(c => c.san).sort(), ['gxh8=B', 'gxh8=N', 'gxh8=Q', 'gxh8=R']);
  assert.equal(r.moves.length, 8);
  const fixed = run(PROMO + ' g takes h8', { overrides: { [r.unresolved.wordIndex]: { san: 'gxh8=Q' } } });
  assert.equal(fixed.status, 'complete');
});

// ---------- warnings ----------
test('low-confidence words flag the move (threshold 0.7) and are counted', () => {
  const r = run(SCHOLAR, {}, { confidences: { 2: 0.3 } });
  assert.deepEqual(r.moves[2].warnings, ['low_confidence']);
  assert.equal(r.moves[2].confidence, 0.3);
  assert.equal(r.stats.lowConfidence, 1);
  assert.deepEqual(r.moves[0].warnings, []);
});

test('spoken check/mate that the position contradicts is flagged', () => {
  const chk = run('e4 e5 queen h5 check');
  assert.deepEqual(chk.moves[2].warnings, ['spoken_check_but_not_check']);
  const mate = run('e4 e5 queen h5 checkmate');
  assert.deepEqual(mate.moves[2].warnings, ['spoken_mate_but_not_checkmate']);
});

test('moves spoken after the game has ended are ignored with a warning', () => {
  const r = run(SCHOLAR + ' e4');
  assert.equal(r.status, 'complete');
  assert.equal(r.moves.length, 7);
  assert.ok(r.warnings.some(w => w.code === 'moves_after_game_end' && w.count === 1));
});

test('missing timestamps are flagged but do not break parsing', () => {
  const words = [{ text: 'e4' }, { text: 'e5', startMs: 500, endMs: 800, confidence: null }];
  const r = parseGame(words);
  assert.equal(r.status, 'complete');
  assert.deepEqual(r.moves[0].warnings, ['no_timestamp']);
  assert.equal(r.moves[0].startMs, null);
  assert.equal(r.moves[1].startMs, 500);
  assert.equal(r.moves[1].confidence, null);
});

test('empty input and non-chess speech', () => {
  for (const words of [[], speak('hello world this is just a normal sentence about the weather')]) {
    const r = parseGame(words);
    assert.equal(r.status, 'no_moves');
    assert.equal(r.pgn, '');
    assert.ok(r.warnings.some(w => w.code === 'no_moves_found'));
  }
});

test('fool\'s mate: black mates, result 0-1', () => {
  const r = run('f3 e5 g4 queen h4 checkmate');
  assert.equal(r.status, 'complete');
  assert.equal(r.moves.pop().san, 'Qh4#');
  assert.equal(r.result, '0-1');
});

test('a long game (60 plies) parses; threefold repetition does NOT end the parse', () => {
  // Knights shuffling out and back: legal for both sides, no captures. The start position
  // recurs several times, which chess.js game_over() would treat as over; we must not.
  const cycle = 'knight f3 knight f6 knight g1 knight g8';
  const text = Array(15).fill(cycle).join(' ');
  const r = run(text);
  assert.equal(r.status, 'complete');
  assert.equal(r.moves.length, 60);
  for (let i = 1; i < r.moves.length; i++) assert.ok(r.moves[i].startMs > r.moves[i - 1].startMs);
});
