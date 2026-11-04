'use strict';
/**
 * Items -> "move spec" (what was SPOKEN), and spec -> legal moves (what is POSSIBLE).
 * matchSpec() is a pure function over chess.js-style verbose moves
 * ({from,to,piece,flags,promotion,san}); it never invents information.
 */

function minConf(items) {
  let c = null;
  for (const it of items) if (it.c != null) c = c == null ? it.c : Math.min(c, it.c);
  return c;
}

function extent(items, a, b) {
  const slice = items.slice(a, b);
  return {
    w0: slice[0].w0, w1: slice[slice.length - 1].w1,
    t0: slice[0].t0, t1: slice[slice.length - 1].t1,
    c: minConf(slice),
  };
}

const kind = (items, j) => (items[j] ? items[j].k : null);

/**
 * Patterns after an optional piece word (j = first item after the piece):
 *   P3  SQ (CAP|TO)+ SQ           long algebraic "e2 to e4", "knight g1 to f3"
 *   P2  (FILE|RANK) [CAP] [TO] SQ  disambiguation / pawn capture "e takes d5"
 *   P1  [CAP] [TO] SQ              plain destination
 * No piece stated => pawn move only: P1 (push) or P2 with FILE+CAP (pawn capture).
 */
function matchPattern(items, j, piece) {
  // P3
  if (kind(items, j) === 'SQ' && (kind(items, j + 1) === 'CAP' || kind(items, j + 1) === 'TO')) {
    let k = j + 1, capture = false;
    if (kind(items, k) === 'CAP') { capture = true; k++; }
    if (kind(items, k) === 'TO') k++;
    if (kind(items, k) === 'SQ') {
      return { fromSq: items[j].sq, capture, to: items[k].sq, end: k + 1 };
    }
  }
  // P2
  const f = kind(items, j);
  if (f === 'FILE' || (f === 'RANK' && piece)) {
    let k = j + 1, capture = false;
    if (kind(items, k) === 'CAP') { capture = true; k++; }
    if (kind(items, k) === 'TO') k++;
    if (kind(items, k) === 'SQ' && (piece || capture)) {
      return {
        fromFile: f === 'FILE' ? items[j].v : null,
        fromRank: f === 'RANK' ? items[j].v : null,
        capture, to: items[k].sq, end: k + 1,
      };
    }
  }
  // P1
  {
    let k = j, capture = false;
    if (kind(items, k) === 'CAP') { capture = true; k++; }
    if (kind(items, k) === 'TO') k++;
    if (kind(items, k) === 'SQ') return { capture, to: items[k].sq, end: k + 1 };
  }
  return null;
}

/** Parse one move phrase starting at items[i]. Returns null if no move phrase starts here. */
function parseSpecAt(items, i) {
  const it = items[i];
  if (!it) return null;

  if (it.k === 'CASTLE') {
    return { spec: { castle: it.side || 'any' }, start: i, next: i + 1, ...extent(items, i, i + 1) };
  }
  if (it.k === 'COMPACT') {
    const spec = {
      piece: it.piece, fromFile: it.fromFile, fromRank: it.fromRank,
      capture: it.capture, to: it.to, promo: it.promo,
    };
    return { spec, start: i, next: i + 1, ...extent(items, i, i + 1) };
  }

  let j = i, piece = null;
  if (it.k === 'PIECE') { piece = it.v; j++; }
  else if (it.k !== 'FILE' && it.k !== 'CAP' && it.k !== 'TO' && it.k !== 'SQ') return null;

  const m = matchPattern(items, j, piece);
  if (!m) return null;
  const spec = {
    piece, fromFile: m.fromFile || null, fromRank: m.fromRank || null, fromSq: m.fromSq || null,
    capture: !!m.capture, to: m.to, promo: null,
  };
  return { spec, start: i, next: m.end, ...extent(items, i, m.end) };
}

/** After a pawn reaches the last rank: [PROMO] [TO] PIECE(q|r|b|n). */
function peekPromo(items, j) {
  let k = j;
  if (kind(items, k) === 'PROMO') k++;
  if (kind(items, k) === 'TO' && k > j) k++;
  const p = items[k];
  if (p && p.k === 'PIECE' && ['q', 'r', 'b', 'n'].includes(p.v)) return { promo: p.v, next: k + 1 };
  return null;
}

/** Consume spoken "check"/"mate" right after a move. */
function consumeSuffix(items, j) {
  let k = j, spoken = null;
  while (items[k] && (items[k].k === 'CHECK' || items[k].k === 'MATE')) {
    spoken = items[k].k === 'MATE' ? 'mate' : (spoken === 'mate' ? 'mate' : 'check');
    k++;
  }
  return { next: k, spoken };
}

const has = (m, f) => typeof m.flags === 'string' && m.flags.includes(f);

function matchSpec(spec, legal) {
  if (spec.castle) {
    const castles = legal.filter(m => has(m, 'k') || has(m, 'q'));
    return spec.castle === 'any' ? castles : castles.filter(m => has(m, spec.castle));
  }
  return legal.filter(m => {
    if (has(m, 'k') || has(m, 'q')) return false; // castling must be spoken as castling
    if (m.to !== spec.to) return false;
    if ((spec.piece || 'p') !== m.piece) return false;
    // A pawn move with no file and no "takes" is a push. Pawn captures always name a file,
    // so "e5" must not silently match dxe5 / fxe5.
    if (m.piece === 'p' && !spec.fromFile && !spec.fromSq && !spec.capture && (has(m, 'c') || has(m, 'e'))) return false;
    if (spec.fromFile && m.from[0] !== spec.fromFile) return false;
    if (spec.fromRank && Number(m.from[1]) !== spec.fromRank) return false;
    if (spec.fromSq && m.from !== spec.fromSq) return false;
    if (spec.capture && !(has(m, 'c') || has(m, 'e'))) return false;
    if (spec.promo && m.promotion !== spec.promo) return false;
    return true;
  });
}

module.exports = { parseSpecAt, peekPromo, consumeSuffix, matchSpec };
