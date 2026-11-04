'use strict';
/**
 * words[] ({text,startMs,endMs,confidence}) -> items[]
 *
 * Item kinds:
 *   PIECE {v:'n'|'b'|'r'|'q'|'k'|'p'}   SQ {sq:'e4'}          FILE {v:'e'}   RANK {v:4}
 *   CAP   TO   PROMO   CHECK   MATE
 *   CASTLE {side:'k'|'q'|undefined}      SIDE {v:'k'|'q'}
 *   COMPACT {piece, fromFile, fromRank, capture, to, promo}   (e.g. "Nf3", "exd5", "Qxd5", "e8=Q")
 * Every item carries w0/w1 (first/last source word index), t0/t1 (ms), c (min confidence or null).
 */
const V = require('./vocab');

const COMPACT_RE = /^([KQRBN]|[nkqr])?([a-h])?([1-8])?([xX:])?([a-h][1-8])(?:=?([QRBNqrbn]))?([+#])?$/;
const BISHOP_LOWER_RE = /^b([a-h][1-8])([+#])?$/;
const CASTLE_COMPACT_RE = /^[o0](?:-[o0]){1,2}[+#]?$/i;

function cleanWord(text) {
  return String(text == null ? '' : text)
    .trim()
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9+#]+$/, '');
}

function minConf(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  return Math.min(a, b);
}

function itemFrom(kind, props, w) {
  return Object.assign({ k: kind, w0: w.wi, w1: w.wi, t0: w.t0, t1: w.t1, c: w.c }, props);
}

function span(kind, props, a, b) {
  return { k: kind, w0: a.wi, w1: b.wi, t0: a.t0, t1: b.t1, c: minConf(a.c, b.c), ...props };
}

/** Try to read one written token as compact SAN-like. Returns item props or null. */
function tryCompact(part) {
  if (!part) return null;
  if (part[0] === 'b' && BISHOP_LOWER_RE.test(part)) {
    const m = BISHOP_LOWER_RE.exec(part);
    return { kind: 'COMPACT', props: { piece: 'b', fromFile: null, fromRank: null, capture: false, to: m[1], promo: null }, mark: m[2] || null };
  }
  const c1 = (/[KQRBN]/.test(part[0]) ? part[0] : part[0].toLowerCase()) + part.slice(1).toLowerCase();
  const c2 = part.toLowerCase();
  for (const cand of [c1, c2]) {
    const m = COMPACT_RE.exec(cand);
    if (!m) continue;
    const squareOnly = !m[1] && !m[2] && !m[3] && !m[4] && !m[6];
    if (squareOnly) return { kind: 'SQ', props: { sq: m[5] }, mark: m[7] || null };
    return {
      kind: 'COMPACT',
      props: {
        piece: m[1] ? m[1].toLowerCase() : null,
        fromFile: m[2] || null,
        fromRank: m[3] ? Number(m[3]) : null,
        capture: !!m[4],
        to: m[5],
        promo: m[6] ? m[6].toLowerCase() : null,
      },
      mark: m[7] || null,
    };
  }
  return null;
}

function fileOf(p) {
  if (!p || p.item) return null;
  return V.FILE_HARD[p.w] || V.FILE_SOFT[p.w] || null;
}

function softRankNoAmbig(w) { return V.RANK_SOFT[w] !== undefined && !V.RANK_SOFT_AMBIGUOUS.has(w); }

/** Does a square start at prims[j]? (compact square, or file word + rank word) */
function startsSquare(prims, j) {
  const q = prims[j];
  if (!q) return false;
  if (q.item) return q.item.k === 'SQ';
  if (!fileOf(q)) return false;
  const r = prims[j + 1];
  if (!r || r.item) return false;
  return V.RANK_HARD[r.w] !== undefined || softRankNoAmbig(r.w);
}

/** Rank value for prims[j] when it directly follows a file word, else null. */
function rankAfterFile(prims, j) {
  const q = prims[j];
  if (!q || q.item) return null;
  if (V.RANK_HARD[q.w] !== undefined) return V.RANK_HARD[q.w];
  if (V.RANK_SOFT[q.w] !== undefined) {
    if (V.RANK_SOFT_AMBIGUOUS.has(q.w) && startsSquare(prims, j + 1)) return null;
    return V.RANK_SOFT[q.w];
  }
  return null;
}

function buildPrims(words) {
  const prims = [];
  words.forEach((word, wi) => {
    const t0 = Number.isFinite(word.startMs) ? word.startMs : null;
    const t1 = Number.isFinite(word.endMs) ? word.endMs : t0;
    const c = typeof word.confidence === 'number' ? word.confidence : null;
    const base = { wi, t0, t1, c };
    const cleaned = cleanWord(word.text);
    if (!cleaned) return;

    if (CASTLE_COMPACT_RE.test(cleaned)) {
      const side = (cleaned.match(/[o0]/gi) || []).length >= 3 ? 'q' : 'k';
      prims.push({ ...base, item: itemFrom('CASTLE', { side }, base) });
      return;
    }
    for (const part of cleaned.split(/[-–—_/]+/)) {
      if (!part) continue;
      const cmp = tryCompact(part);
      if (cmp) {
        prims.push({ ...base, item: itemFrom(cmp.kind, cmp.props, base) });
        if (cmp.mark) prims.push({ ...base, item: itemFrom(cmp.mark === '#' ? 'MATE' : 'CHECK', {}, base) });
        continue;
      }
      const w = part.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (w) prims.push({ ...base, w });
    }
  });
  return prims;
}

function tokenize(words) {
  const prims = buildPrims(words);
  const items = [];
  let i = 0;
  while (i < prims.length) {
    const p = prims[i];
    if (p.item) { items.push(p.item); i++; continue; }
    const w = p.w;

    // "oh oh" / "zero zero" / "o o o"
    if (V.O_WORDS.has(w)) {
      let n = 0;
      while (i + n < prims.length && !prims[i + n].item && V.O_WORDS.has(prims[i + n].w) && n < 3) n++;
      if (n >= 2) { items.push(span('CASTLE', { side: n >= 3 ? 'q' : 'k' }, p, prims[i + n - 1])); i += n; continue; }
      i++; continue;
    }

    // "king side" / "queen side" (two words)
    if ((w === 'king' || w === 'queen') && prims[i + 1] && !prims[i + 1].item && prims[i + 1].w === 'side') {
      items.push(span('SIDE', { v: w === 'king' ? 'k' : 'q' }, p, prims[i + 1]));
      i += 2; continue;
    }

    if (V.PIECE_WORDS[w]) { items.push(itemFrom('PIECE', { v: V.PIECE_WORDS[w] }, p)); i++; continue; }
    if (V.CASTLE_WORDS.has(w)) { items.push(itemFrom('CASTLE', { side: undefined }, p)); i++; continue; }
    if (V.SIDE_WORDS[w]) { items.push(itemFrom('SIDE', { v: V.SIDE_WORDS[w] }, p)); i++; continue; }
    if (V.CAPTURE_WORDS.has(w)) { items.push(itemFrom('CAP', {}, p)); i++; continue; }
    if (V.PROMO_WORDS.has(w)) { items.push(itemFrom('PROMO', {}, p)); i++; continue; }
    if (V.CHECK_WORDS.has(w)) { items.push(itemFrom('CHECK', {}, p)); i++; continue; }
    if (V.MATE_WORDS.has(w)) { items.push(itemFrom('MATE', {}, p)); i++; continue; }

    // bare "b" followed by a square = bishop ("b f3"); otherwise it is the b-file
    // (not right after another piece word: "knight b d two" = knight from the b-file to d2)
    const prev = items[items.length - 1];
    if (w === 'b' && startsSquare(prims, i + 1) && !(prev && prev.k === 'PIECE')) {
      items.push(itemFrom('PIECE', { v: 'b' }, p)); i++; continue;
    }

    const f = fileOf(p);
    if (f) {
      const r = rankAfterFile(prims, i + 1);
      if (r != null) { items.push(span('SQ', { sq: f + r }, p, prims[i + 1])); i += 2; continue; }
      if (V.FILE_HARD[w]) { items.push(itemFrom('FILE', { v: f }, p)); }
      i++; continue; // soft file homophone without a rank = ordinary English word
    }

    if (V.PIECE_LETTERS[w]) { items.push(itemFrom('PIECE', { v: V.PIECE_LETTERS[w] }, p)); i++; continue; }
    if (V.RANK_HARD[w] !== undefined) { items.push(itemFrom('RANK', { v: V.RANK_HARD[w] }, p)); i++; continue; }
    if (V.TO_WORDS.has(w)) { items.push(itemFrom('TO', {}, p)); i++; continue; }
    i++; // ordinary word: ignored
  }
  return mergeCastleSides(items);
}

/** Attach SIDE items to an adjacent CASTLE ("castles kingside", "short castle"); drop stray SIDE items. */
function mergeCastleSides(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.k === 'CASTLE' && it.side === undefined && items[i + 1] && items[i + 1].k === 'SIDE') {
      const s = items[i + 1];
      out.push({ ...it, side: s.v, w1: s.w1, t1: s.t1, c: minConf(it.c, s.c) });
      i++; continue;
    }
    if (it.k === 'SIDE' && items[i + 1] && items[i + 1].k === 'CASTLE' && items[i + 1].side === undefined) {
      const cz = items[i + 1];
      out.push({ ...cz, side: it.v, w0: it.w0, t0: it.t0, c: minConf(it.c, cz.c) });
      i++; continue;
    }
    if (it.k === 'SIDE') continue;
    out.push(it);
  }
  return out;
}

module.exports = { tokenize, cleanWord, tryCompact };
