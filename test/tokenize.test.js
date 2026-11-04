'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../src/parser/tokenize');
const { speak } = require('../testutil/words');

const kinds = text => tokenize(speak(text)).map(i => i.k + (i.sq ? ':' + i.sq : i.v !== undefined ? ':' + i.v : i.side ? ':' + i.side : ''));

test('squares: compact, spaced, spoken, hyphenated, capitalised', () => {
  assert.deepEqual(kinds('e4 E5. e six e-4 Knight'), ['SQ:e4', 'SQ:e5', 'SQ:e6', 'SQ:e4', 'PIECE:n']);
});

test('piece words and homophones', () => {
  assert.deepEqual(kinds('knight night bishop rook queen king pawn'), ['PIECE:n', 'PIECE:n', 'PIECE:b', 'PIECE:r', 'PIECE:q', 'PIECE:k', 'PIECE:p']);
});

test('homophone files/ranks only count when they form a square', () => {
  assert.deepEqual(kinds('be four see for'), ['SQ:b4', 'SQ:c4']);
  assert.deepEqual(kinds('see you for ate'), []); // plain English is ignored
});

test('"to" is a filler word, or rank 2 only when directly after a file and not before a new square', () => {
  assert.deepEqual(kinds('knight to e four'), ['PIECE:n', 'TO', 'SQ:e4']);
  assert.deepEqual(kinds('e to'), ['SQ:e2']);
  assert.deepEqual(kinds('e to e4'), ['FILE:e', 'TO', 'SQ:e4']);
});

test('compact SAN tokens', () => {
  const t = tokenize(speak('Nf3 exd5 Qxd5+ e8=Q Bb5 bb5 bxc3'));
  assert.equal(t[0].k, 'COMPACT'); assert.equal(t[0].piece, 'n'); assert.equal(t[0].to, 'f3');
  assert.equal(t[1].fromFile, 'e'); assert.equal(t[1].capture, true); assert.equal(t[1].to, 'd5'); assert.equal(t[1].piece, null);
  assert.equal(t[2].piece, 'q'); assert.equal(t[2].capture, true);
  assert.equal(t[3].k, 'CHECK');
  assert.equal(t[4].promo, 'q'); assert.equal(t[4].to, 'e8');
  assert.equal(t[5].piece, 'b'); assert.equal(t[5].to, 'b5');
  assert.equal(t[6].piece, 'b'); assert.equal(t[6].to, 'b5'); // lowercase "bb5" = bishop b5
  assert.equal(t[7].piece, null); assert.equal(t[7].fromFile, 'b'); assert.equal(t[7].capture, true); // "bxc3" = pawn
});

test('check / mate marks split off squares', () => {
  assert.deepEqual(kinds('e4+ f7#'), ['SQ:e4', 'CHECK', 'SQ:f7', 'MATE']);
  assert.deepEqual(kinds('check mate checkmate plus'), ['CHECK', 'MATE', 'MATE', 'CHECK']);
});

test('castling in all spoken forms', () => {
  assert.deepEqual(kinds('O-O'), ['CASTLE:k']);
  assert.deepEqual(kinds('0-0-0'), ['CASTLE:q']);
  assert.deepEqual(kinds('o-o-o'), ['CASTLE:q']);
  assert.deepEqual(kinds('oh oh'), ['CASTLE:k']);
  assert.deepEqual(kinds('zero zero zero'), ['CASTLE:q']);
  assert.deepEqual(kinds('castles'), ['CASTLE']);
  assert.deepEqual(kinds('castles kingside'), ['CASTLE:k']);
  assert.deepEqual(kinds('castles king side'), ['CASTLE:k']);
  assert.deepEqual(kinds('castle queen side'), ['CASTLE:q']);
  assert.deepEqual(kinds('short castle'), ['CASTLE:k']);
  assert.deepEqual(kinds('long castles'), ['CASTLE:q']);
  assert.deepEqual(kinds('oh no'), []);            // a single "oh" is not castling
  assert.deepEqual(kinds('long road short story'), []); // stray side words are dropped
});

test('capture words and bare "b"', () => {
  assert.deepEqual(kinds('e takes d5'), ['FILE:e', 'CAP', 'SQ:d5']);
  assert.deepEqual(kinds('b f3'), ['PIECE:b', 'SQ:f3']);   // bishop f3
  assert.deepEqual(kinds('b four'), ['SQ:b4']);            // file b
  assert.deepEqual(kinds('b takes c5'), ['FILE:b', 'CAP', 'SQ:c5']);
});

test('items keep word index, timestamps and minimum confidence of the words they span', () => {
  const words = speak('knight e four', { startMs: 5000, stepMs: 500, durMs: 300, confidences: { 1: 0.4, 2: 0.9 } });
  const [piece, sq] = tokenize(words);
  assert.equal(piece.w0, 0); assert.equal(piece.t0, 5000);
  assert.equal(sq.w0, 1); assert.equal(sq.w1, 2);
  assert.equal(sq.t0, 5500); assert.equal(sq.t1, 6300);
  assert.equal(sq.c, 0.4);
});

test('missing timestamps/confidence do not crash', () => {
  const items = tokenize([{ text: 'e4' }, { text: 'knight', startMs: null, endMs: null, confidence: null }]);
  assert.equal(items.length, 2);
  assert.equal(items[0].t0, null); assert.equal(items[0].c, null);
});

test('empty, punctuation-only and non-string words are ignored', () => {
  assert.deepEqual(tokenize([{ text: '' }, { text: '...' }, { text: null }, { text: undefined }]), []);
});
