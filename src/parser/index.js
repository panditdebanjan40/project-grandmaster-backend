'use strict';
/**
 * parseGame(words, options) -> { status, moves[], pgn, unresolved, leftover[], warnings[], ... }
 *
 * words: [{ text, startMs, endMs, confidence }]  (timestamps in milliseconds)
 *
 * Rules (non-negotiable):
 *  - Every spoken phrase is resolved against the LEGAL moves of the current position.
 *  - Ambiguous / illegal / missing-promotion phrases STOP the parse and are reported with candidates.
 *    Nothing is guessed, because every later move depends on the earlier ones.
 *  - overrides let a human resolve a stop and re-run WITHOUT calling the STT provider again:
 *      { "<wordIndex>": { san: "Nbd2" } }              replace the phrase heard at that word index
 *      { "<wordIndex>": { skip: true } }               ignore the phrase (it was not a move)
 *      { "<wordIndex>": { insertBefore: ["Nc6"] } }    add move(s) the STT dropped (no timestamp)
 */
const { tokenize, cleanWord } = require('./tokenize');
const { parseSpecAt, peekPromo, consumeSuffix, matchSpec } = require('./spec');

const strip = san => String(san || '').replace(/[+#!?]+$/g, '');

function loadChess(opt) {
  if (opt) return opt;
  const mod = require('chess.js');
  return mod.Chess || mod;
}

function parseGame(words, options = {}) {
  const Chess = loadChess(options.Chess);
  const overrides = options.overrides || {};
  const lowConfidence = options.lowConfidence == null ? 0.7 : options.lowConfidence;

  const items = tokenize(words);
  const game = new Chess();
  // Only checkmate and stalemate end a game automatically. chess.js game_over() also reports
  // threefold repetition, the 50-move rule and insufficient material, which are merely claimable
  // (or edge cases), so a recording must be allowed to continue past them.
  const over = () => game.in_checkmate() || game.in_stalemate();
  const moves = [];
  const leftover = [];
  const warnings = [];
  let unresolved = null;

  const heard = (w0, w1) => words.slice(w0, w1 + 1).map(w => cleanWord(w.text)).filter(Boolean).join(' ');
  const sanList = list => list.map(m => m.san);
  const brief = list => list.map(m => ({ san: m.san, from: m.from, to: m.to }));

  function apply(m, meta) {
    const res = game.move({ from: m.from, to: m.to, promotion: m.promotion });
    if (!res) throw new Error('internal: legal move rejected by engine: ' + m.san);
    const rec = {
      index: moves.length,
      moveNumber: Math.floor(moves.length / 2) + 1,
      color: res.color,
      san: res.san,
      from: res.from,
      to: res.to,
      piece: res.piece,
      captured: res.captured || null,
      promotion: res.promotion || null,
      flags: res.flags,
      fen: game.fen(),
      startMs: meta.startMs == null ? null : meta.startMs,
      endMs: meta.endMs == null ? null : meta.endMs,
      confidence: meta.confidence == null ? null : meta.confidence,
      heard: meta.heard || '',
      wordIndex: meta.wordIndex == null ? null : meta.wordIndex,
      source: meta.source,
      warnings: [],
    };
    if (rec.source !== 'inserted' && rec.startMs == null) rec.warnings.push('no_timestamp');
    if (rec.confidence != null && rec.confidence < lowConfidence) rec.warnings.push('low_confidence');
    const prev = moves[moves.length - 1];
    if (prev && prev.startMs != null && rec.startMs != null && rec.startMs < prev.startMs) rec.warnings.push('timestamp_out_of_order');
    moves.push(rec);
    return rec;
  }

  function stop(type, ps, legal, extra = {}) {
    const spec = ps.spec;
    let candidates = [];
    if (extra.candidates) candidates = brief(extra.candidates);
    else if (!spec.castle) {
      candidates = brief(legal.filter(m => m.to === spec.to));
      if (!candidates.length) candidates = brief(legal.filter(m => m.piece === (spec.piece || 'p')));
    }
    unresolved = {
      type,
      index: moves.length,
      wordIndex: ps.w0,
      wordIndexEnd: ps.w1,
      heard: heard(ps.w0, ps.w1),
      startMs: ps.t0, endMs: ps.t1, confidence: ps.c,
      turn: game.turn(),
      fen: game.fen(),
      candidates,
      legalMoves: sanList(legal),
    };
  }

  let i = 0;
  while (i < items.length) {
    if (over()) break;

    const ps = parseSpecAt(items, i);
    if (!ps) {
      const it = items[i];
      if (['PIECE', 'SQ', 'COMPACT', 'CASTLE', 'CAP'].includes(it.k)) {
        leftover.push({ kind: it.k, text: heard(it.w0, it.w1), startMs: it.t0, afterMove: moves.length });
      }
      i++;
      continue;
    }

    const ov = overrides[String(ps.w0)];

    if (ov && Array.isArray(ov.insertBefore)) {
      let failed = false;
      for (const san of ov.insertBefore) {
        const legal = game.moves({ verbose: true });
        const hit = legal.find(m => strip(m.san) === strip(san));
        if (!hit) {
          stop('override_illegal', ps, legal, { candidates: legal });
          unresolved.override = san;
          failed = true;
          break;
        }
        apply(hit, { source: 'inserted', heard: '', wordIndex: ps.w0 });
        if (over()) break;
      }
      if (failed) break;
    }
    if (ov && ov.skip) { i = ps.next; continue; }
    if (over()) break;

    const legal = game.moves({ verbose: true });
    let next = ps.next;
    let chosen = null;
    let source = 'speech';

    if (ov && ov.san) {
      chosen = legal.find(m => strip(m.san) === strip(ov.san)) || null;
      source = 'override';
      if (!chosen) { stop('override_illegal', ps, legal, { candidates: legal }); unresolved.override = ov.san; break; }
    } else {
      let matches = matchSpec(ps.spec, legal);
      if (matches.length && !ps.spec.castle && matches.every(m => m.promotion) && !ps.spec.promo) {
        const pp = peekPromo(items, next);
        if (pp) { matches = matchSpec({ ...ps.spec, promo: pp.promo }, legal); next = pp.next; }
        else { stop('needs_promotion', ps, legal, { candidates: matches }); break; }
      }
      if (matches.length === 0) { stop('illegal', ps, legal); break; }
      if (matches.length > 1) { stop('ambiguous', ps, legal, { candidates: matches }); break; }
      chosen = matches[0];
    }

    const suffix = consumeSuffix(items, next);
    next = suffix.next;
    const rec = apply(chosen, {
      startMs: ps.t0, endMs: ps.t1, confidence: ps.c,
      heard: heard(ps.w0, ps.w1), wordIndex: ps.w0, source,
    });
    if (suffix.spoken === 'mate' && !game.in_checkmate()) rec.warnings.push('spoken_mate_but_not_checkmate');
    if (suffix.spoken === 'check' && !game.in_check()) rec.warnings.push('spoken_check_but_not_check');
    i = next;
  }

  // Anything move-like spoken after the game already ended?
  if (!unresolved && over() && i < items.length) {
    let count = 0, j = i;
    while (j < items.length) { const p = parseSpecAt(items, j); if (p) { count++; j = p.next; } else j++; }
    if (count) warnings.push({ code: 'moves_after_game_end', count });
  }
  if (leftover.length) warnings.push({ code: 'unparsed_chess_words', count: leftover.length });
  if (!moves.length && !unresolved) warnings.push({ code: 'no_moves_found' });

  let result = '*';
  if (game.in_checkmate()) result = game.turn() === 'w' ? '0-1' : '1-0';
  else if (over()) result = '1/2-1/2';
  const movetext = game.pgn();
  const pgn = (movetext + (result !== '*' && movetext ? ' ' + result : '')).trim();

  return {
    status: unresolved ? 'needs_review' : (moves.length ? 'complete' : 'no_moves'),
    moves,
    pgn,
    result,
    finalFen: game.fen(),
    unresolved,
    leftover,
    warnings,
    stats: {
      wordsIn: words.length,
      moves: moves.length,
      lowConfidence: moves.filter(m => m.warnings.includes('low_confidence')).length,
    },
  };
}

module.exports = { parseGame };
