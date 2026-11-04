'use strict';
/**
 * Spoken-chess vocabulary. Everything the parser understands lives here so it
 * can be extended without touching parsing logic.
 * All keys are lowercase words with punctuation already stripped.
 */

const PIECE_WORDS = {
  knight: 'n', night: 'n', nite: 'n',
  bishop: 'b',
  rook: 'r',
  queen: 'q',
  king: 'k',
  pawn: 'p',
};

// Single spoken/typed letters that are unambiguous enough to mean a piece.
// "b" is deliberately NOT here (it is also the b-file) - see tokenize.js.
const PIECE_LETTERS = { n: 'n', k: 'k', q: 'q', r: 'r' };

const FILE_HARD = { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f', g: 'g', h: 'h' };

// Homophones that count as a file ONLY when immediately followed by a rank.
const FILE_SOFT = {
  ay: 'a',
  be: 'b', bee: 'b',
  see: 'c', sea: 'c', cee: 'c',
  dee: 'd',
  eff: 'f',
  gee: 'g', jee: 'g',
  aitch: 'h',
};

const RANK_HARD = {
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
};

// Homophones that count as a rank ONLY directly after a file word.
const RANK_SOFT = { won: 1, to: 2, too: 2, for: 4, fore: 4, ate: 8 };
// "to" / "too" are also filler words ("knight to e4"), so tokenize.js applies
// a look-ahead before treating them as the rank 2.
const RANK_SOFT_AMBIGUOUS = new Set(['to', 'too']);

const CAPTURE_WORDS = new Set(['takes', 'take', 'taking', 'captures', 'capture', 'capturing', 'captured', 'x']);
const TO_WORDS = new Set(['to']);
const CASTLE_WORDS = new Set(['castle', 'castles', 'castled', 'castling']);
const O_WORDS = new Set(['o', 'oh', 'zero', '0']);
const SIDE_WORDS = { kingside: 'k', queenside: 'q', short: 'k', long: 'q' };
const PROMO_WORDS = new Set(['equals', 'equal', 'promotes', 'promoting', 'promoted', 'promotion', 'becomes']);
const CHECK_WORDS = new Set(['check', 'checks', 'plus']);
const MATE_WORDS = new Set(['mate', 'mates', 'checkmate', 'checkmates']);

/**
 * Terms sent to the STT provider as keyterms/context hints.
 * Kept short and chess specific. Provider limits are far above this size.
 */
const KEYTERMS = [
  'knight', 'bishop', 'rook', 'queen', 'king', 'pawn',
  'takes', 'captures', 'castles', 'kingside', 'queenside', 'check', 'checkmate',
  'promotes', 'equals',
  'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8',
  'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8',
  'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8',
  'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8',
  'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8',
  'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8',
];

module.exports = {
  PIECE_WORDS, PIECE_LETTERS, FILE_HARD, FILE_SOFT, RANK_HARD, RANK_SOFT, RANK_SOFT_AMBIGUOUS,
  CAPTURE_WORDS, TO_WORDS, CASTLE_WORDS, O_WORDS, SIDE_WORDS, PROMO_WORDS, CHECK_WORDS, MATE_WORDS,
  KEYTERMS,
};
