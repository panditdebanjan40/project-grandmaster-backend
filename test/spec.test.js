'use strict';
/**
 * Pure-logic tests. The "legal move" lists below are HAND-BUILT fixtures shaped like
 * chess.js verbose moves; they do not come from the chess engine. Engine-backed tests
 * live in parser.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../src/parser/tokenize');
const { parseSpecAt, peekPromo, consumeSuffix, matchSpec } = require('../src/parser/spec');
const { speak } = require('../testutil/words');

const specOf = (text, at = 0) => parseSpecAt(tokenize(speak(text)), at);

test('piece + square', () => {
  const r = specOf('knight f3');
  assert.equal(r.spec.piece, 'n'); assert.equal(r.spec.to, 'f3'); assert.equal(r.next, 2);
});

test('filler "to" is accepted', () => {
  const r = specOf('pawn to e four');
  assert.equal(r.spec.piece, 'p'); assert.equal(r.spec.to, 'e4');
});

test('consecutive moves are not merged (white e4, black e5)', () => {
  const items = tokenize(speak('e4 e5'));
  const a = parseSpecAt(items, 0);
  assert.equal(a.spec.to, 'e4'); assert.equal(a.next, 1);
  assert.equal(parseSpecAt(items, a.next).spec.to, 'e5');
});

test('a piece move followed by a pawn move is not read as long algebraic', () => {
  const items = tokenize(speak('bishop b5 a6'));
  const a = parseSpecAt(items, 0);
  assert.equal(a.spec.piece, 'b'); assert.equal(a.spec.to, 'b5'); assert.equal(a.spec.fromSq, null); assert.equal(a.next, 2);
  assert.equal(parseSpecAt(items, 2).spec.to, 'a6');
});

test('pawn capture: "e takes d five"', () => {
  const r = specOf('e takes d five');
  assert.equal(r.spec.fromFile, 'e'); assert.equal(r.spec.capture, true); assert.equal(r.spec.to, 'd5'); assert.equal(r.spec.piece, null);
});

test('a bare file followed by a square is NOT a move without a capture word', () => {
  assert.equal(specOf('d e4'), null);
  const r = parseSpecAt(tokenize(speak('d e4')), 1);
  assert.equal(r.spec.to, 'e4');
});

test('a move number is never read as a rank disambiguation', () => {
  const items = tokenize(speak('1 e4'));
  assert.equal(parseSpecAt(items, 0), null);
  assert.equal(parseSpecAt(items, 1).spec.to, 'e4');
});

test('disambiguation by file and by rank (piece required)', () => {
  const f = specOf('knight b d two');
  assert.equal(f.spec.fromFile, 'b'); assert.equal(f.spec.to, 'd2');
  const r = specOf('rook one d one');
  assert.equal(r.spec.fromRank, 1); assert.equal(r.spec.to, 'd1');
});

test('long algebraic needs a joining word', () => {
  const r = specOf('e two to e four');
  assert.equal(r.spec.fromSq, 'e2'); assert.equal(r.spec.to, 'e4');
  const n = specOf('knight g one to f three');
  assert.equal(n.spec.piece, 'n'); assert.equal(n.spec.fromSq, 'g1'); assert.equal(n.spec.to, 'f3');
});

test('capture without piece = pawn capture, any file', () => {
  const r = specOf('takes e5');
  assert.equal(r.spec.capture, true); assert.equal(r.spec.piece, null); assert.equal(r.spec.to, 'e5');
});

test('castling specs', () => {
  assert.equal(specOf('castles').spec.castle, 'any');
  assert.equal(specOf('castles queenside').spec.castle, 'q');
  assert.equal(specOf('O-O').spec.castle, 'k');
});

test('words that are not moves yield null', () => {
  assert.equal(specOf('the position is equal'), null);
  assert.equal(specOf('knight'), null);
  assert.equal(specOf('knight takes'), null);
});

test('phrase extent covers the right words, timestamps and confidence', () => {
  const words = speak('well knight f three here', { startMs: 0, stepMs: 1000, durMs: 500, confidences: { 1: 0.9, 2: 0.5, 3: 0.8 } });
  const items = tokenize(words);
  const idx = items.findIndex(i => i.k === 'PIECE');
  const r = parseSpecAt(items, idx);
  assert.equal(r.w0, 1); assert.equal(r.w1, 3);
  assert.equal(r.t0, 1000); assert.equal(r.t1, 3500);
  assert.equal(r.c, 0.5);
});

test('peekPromo', () => {
  const p = s => peekPromo(tokenize(speak(s)), 0);
  assert.equal(p('equals queen').promo, 'q');
  assert.equal(p('queen').promo, 'q');
  assert.equal(p('promotes to knight').promo, 'n');
  assert.equal(p('pawn'), null);
  assert.equal(p('king'), null);
  assert.equal(p('e4'), null);
});

test('consumeSuffix', () => {
  const s = text => consumeSuffix(tokenize(speak(text)), 0);
  assert.deepEqual(s('check'), { next: 1, spoken: 'check' });
  assert.deepEqual(s('checkmate'), { next: 1, spoken: 'mate' });
  assert.deepEqual(s('e4'), { next: 0, spoken: null });
});

// ---- matchSpec over hand-built legal-move fixtures ----
const L = (from, to, piece, flags, san, promotion) => ({ from, to, piece, flags, san, ...(promotion ? { promotion } : {}) });
const fixture = [
  L('b1', 'd2', 'n', 'n', 'Nbd2'),
  L('f3', 'd2', 'n', 'n', 'Nfd2'),
  L('f3', 'e5', 'n', 'c', 'Nxe5'),
  L('e2', 'e4', 'p', 'b', 'e4'),
  L('d4', 'e5', 'p', 'c', 'dxe5'),
  L('f4', 'e5', 'p', 'c', 'fxe5'),
  L('e1', 'g1', 'k', 'k', 'O-O'),
  L('e1', 'c1', 'k', 'q', 'O-O-O'),
  L('g7', 'h8', 'p', 'cp', 'gxh8=Q', 'q'),
  L('g7', 'h8', 'p', 'cp', 'gxh8=R', 'r'),
  L('g7', 'h8', 'p', 'cp', 'gxh8=B', 'b'),
  L('g7', 'h8', 'p', 'cp', 'gxh8=N', 'n'),
];
const sans = (text, legal = fixture) => matchSpec(specOf(text).spec, legal).map(m => m.san);

test('matchSpec: unique, ambiguous and impossible', () => {
  assert.deepEqual(sans('pawn e4'), ['e4']);
  assert.deepEqual(sans('knight d2').sort(), ['Nbd2', 'Nfd2']);          // ambiguous
  assert.deepEqual(sans('knight b d2'), ['Nbd2']);                        // file disambiguation
  assert.deepEqual(sans('knight f d2'), ['Nfd2']);
  assert.deepEqual(sans('knight takes e5'), ['Nxe5']);
  assert.deepEqual(sans('knight c3'), []);                                // no such move
});

test('matchSpec: pawn capture needs the right file; piece must match', () => {
  assert.deepEqual(sans('d takes e5'), ['dxe5']);
  assert.deepEqual(sans('f takes e5'), ['fxe5']);
  assert.deepEqual(sans('takes e5').sort(), ['dxe5', 'fxe5']);           // ambiguous pawn capture
  assert.deepEqual(sans('e5'), []);                                       // pawn push to e5: none
});

test('matchSpec: spoken "takes" on a non-capture is rejected, not forgiven', () => {
  assert.deepEqual(sans('knight takes d2'), []);
});

test('matchSpec: unspoken capture is allowed', () => {
  assert.deepEqual(sans('knight e5'), ['Nxe5']);
});

test('matchSpec: castling is only matched by castle phrases', () => {
  assert.deepEqual(sans('castles').sort(), ['O-O', 'O-O-O']);            // both legal -> caller must flag ambiguity
  assert.deepEqual(sans('castles kingside'), ['O-O']);
  assert.deepEqual(sans('castles queenside'), ['O-O-O']);
  assert.deepEqual(sans('king g1'), []);                                  // king move must not silently become castling
});

test('matchSpec: promotion filtering', () => {
  assert.equal(sans('g takes h8').length, 4);
  const withPromo = matchSpec({ ...specOf('g takes h8').spec, promo: 'q' }, fixture).map(m => m.san);
  assert.deepEqual(withPromo, ['gxh8=Q']);
  assert.deepEqual(matchSpec({ ...specOf('pawn e4').spec, promo: 'q' }, fixture), []);
});
