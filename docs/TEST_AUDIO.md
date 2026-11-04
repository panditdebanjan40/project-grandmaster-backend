# Test audio: what to record, what to expect, what to check

This is the only way to learn how accurate AssemblyAI is on **your** voice and **spoken chess**.
Nothing in this repository has measured that yet.

## 1. Record

Use your phone's voice recorder (any format: m4a, mp3, wav, ogg, 3gp/amr usually work; the server converts them).

Speaking tips (these affect accuracy more than any setting):
- Quiet room, phone ~20 cm from your mouth.
- Say each move as piece name + square: "knight f three", "bishop b five". Say "takes", "castles kingside", "checkmate".
- Pause about a second between moves. Do not rush.
- Say squares clearly: "e four", not "eee four". Digits or words both work.
- Move numbers ("move one") and a little commentary are OK; they are ignored.
- If you slip, stop and re-record. Do not "fix it live" by repeating a move: the parser would see two moves.

## 2. Scripts and the PGN each should produce

I derived these by hand from the rules of chess. They are expectations, not measured results.

### A. Scholar's mate (about 25 s)
> "e4. e5. bishop c4. knight c6. queen h5. knight f6. queen takes f7. checkmate."

Expected: `1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0`

### B. Ruy Lopez with castling (about 40 s)
> "e4. e5. knight f3. knight c6. bishop b5. a6. bishop a4. knight f6. castles kingside. bishop e7."

Expected: `1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7`

### C. Disambiguation (about 20 s)
> "d3. d6. knight f3. knight f6. knight b d two."

Expected: `1. d3 d6 2. Nf3 Nf6 3. Nbd2`

Then re-record it **without** the "b" (just "knight d two"). Expected: the job finishes with
`parse.status = "needs_review"`, `unresolved.type = "ambiguous"`, candidates `Nbd2` and `Nfd2`.
That is correct behaviour, not a bug. Fix it with `/reparse` (`{"overrides":{"<wordIndex>":{"san":"Nbd2"}}}`).

### D. Capture, pawn promotion (about 45 s)
> "g4. h5. g takes h five. knight f6. h6. knight g4. h takes g seven. knight f6. g takes h eight, equals queen."

Expected: `1. g4 h5 2. gxh5 Nf6 3. h6 Ng4 4. hxg7 Nf6 5. gxh8=Q`
(If you leave out "equals queen", expect `needs_review` / `needs_promotion` with four candidates.)

### E. Commentary and move numbers (about 40 s)
> "Move one. White plays e4. Black replies e5. Move two. White develops the knight, knight f3. Black defends, knight c6."

Expected: `1. e4 e5 2. Nf3 Nc6` with no `unresolved`.

### F. Long recording (limit check)
Read a longer game (any real game, 8-10 minutes). Expect it to work up to 10 minutes; over 10 minutes should fail
with `AUDIO_TOO_LONG`. A single misheard move stopping the parse is **expected** here, which is exactly what the
`needs_review` flow and `/reparse` are for.

## 3. Run it

Start the server (`npm start`), then:

```bash
API_URL=http://localhost:3000 ACCESS_TOKEN=your-token node scripts/smoke.js recording.m4a --words
```

On Replit, use the public URL of your Repl as `API_URL` and the same token as in your Secrets. The script prints
progress, every move with its timestamp and confidence, the PGN, anything needing review, and (with `--words`)
every recognised word with start/end time and confidence.

## 4. Check timestamp accuracy (the important part)

1. Open the recording in any player that shows a running time (a seek bar with a clock is enough).
2. Pick 3 moves (early, middle, late). Note when you hear the **first word** of each move.
3. Compare with the `startMs` the script printed (divide by 1000).

| Result | Meaning |
|---|---|
| Within about 0.3 s | good enough for animation sync |
| Constant offset (always e.g. 0.4 s early or late) | fixable with a calibration offset in Phase 3 |
| Drifting or random error | report it; may need a different provider/setting |

Also record, for each script: did `parse.status` come back `complete`? Is `parse.pgn` equal to the expected line?
Which words were wrong (`--words` output)? Were `confidence` values low where it went wrong?

**Please send me**: the script output (or the `--json` output) for A-E, plus your timing comparison. That is the
evidence I need before Phase 3.

## 5. Quick plumbing test without a voice (optional, not an accuracy test)

If you only want to confirm the server runs end to end, any short speech recording works. A synthetic
text-to-speech clip is fine for plumbing, but its accuracy says **nothing** about a human voice, so never use it to
judge recognition quality.

Without any audio or API key, you can still exercise the parser on typed text:

```bash
npm run parse -- "e4 e5 bishop c4 knight c6 queen h5 knight f6 queen takes f7 checkmate"
```
