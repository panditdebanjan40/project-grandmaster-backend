# Grandmaster Backend (Phase 2)

Node.js backend for **Project Grandmaster**'s audio-to-chess workflow:

```
audio upload -> ffmpeg normalise -> speech-to-text (word timestamps) -> chess-aware move parser
             -> legal-move validation -> PGN + per-move timestamps (JSON)
```

The existing frontend HTML is **not** touched in this phase. This backend is a standalone API.
Frontend integration is Phase 3.

---

## 1. What has and has not been tested

Be sceptical of anything not in the "tested" column.

| Area | Status | How |
|---|---|---|
| Spoken-text tokenizer (homophones, compact SAN, castling forms) | **Tested** (11 tests, pass) | `npm run test:offline` |
| Move-spec parsing + legal-move matching *logic* | **Tested** (21 tests, pass) | hand-built move lists, not engine output |
| Config, auth, input validation, logger secret redaction | **Tested** (5 + 5 + 6 + 2 pass) | `npm run test:offline` |
| AssemblyAI + Deepgram **adapter code** | **Tested against local mock servers** (13 pass) | proves our request/response handling, retries, unit conversion, error mapping |
| Audio normalisation (ffmpeg -> 16 kHz mono WAV, duration limit, bad input) | **Tested with real ffmpeg** (8 pass) | generated sine tones only |
| Job queue, cancel, expiry, ownership, error safety | **Tested** (11 pass) | fake pipeline |
| Pipeline wiring + temp-file cleanup | **Tested** (3 pass) | fake STT |
| **Full parser against the real chess.js engine** (SAN, PGN, ambiguity, promotion, castling) | **Tested** (28 tests, pass) | `test/parser.test.js`, run against the installed npm package chess.js 0.10.3 |
| **HTTP API** (express, multer, helmet, CORS, rate limits) | **Tested** | `test/api.test.js`, included in the complete `npm test` run |
| **Real AssemblyAI calls** (request format accepted, keyterms effect, timestamp accuracy) | **NOT TESTED** | needs your API key + a real recording |
| **Real speech accuracy / timestamp accuracy on spoken chess** | **NOT TESTED** | see `docs/TEST_AUDIO.md` |
| Deepgram against the live API | **NOT TESTED** | |
| Replit / Render deployment | **NOT TESTED** | instructions written from docs |
| Exact npm versions in `package.json`, and `package-lock.json` | **Verified / generated** | `npm install` completed successfully in the Codespace |

In this Codespace, `npm test` passed **126/126 tests** and `npm run test:offline` passed **85/85 tests**.

The synthetic "sample narration" used in `parser.test.js` and `api.test.js` is **typed text with invented
evenly-spaced timestamps**. It checks parsing and timestamp pass-through. It says nothing about how well
AssemblyAI will recognise a real voice.

---

## 2. Folder structure

```
grandmaster-backend/
├── package.json            exact dependency versions, npm scripts
├── .env.example            every environment variable, documented
├── .gitignore
├── .replit  replit.nix     Replit config (unverified, see section 4)
├── render.yaml             Render blueprint
├── README.md               this file
├── docs/
│   └── TEST_AUDIO.md       how to record test narration + what to check
├── scripts/
│   ├── parse-text.js       try the parser on typed text (no audio/API key)
│   └── smoke.js            upload a real recording to a running server
├── src/
│   ├── server.js           entry point, wiring, graceful shutdown
│   ├── app.js              Express app: security, CORS, auth, limits, routes, error handler
│   ├── config.js           env parsing + startup validation
│   ├── auth.js             bearer-token auth (constant-time compare)
│   ├── validate.js         strict request validation (job id, overrides)
│   ├── jobs.js             in-memory job queue/manager
│   ├── pipeline.js         normalise -> STT -> parse
│   ├── audio.js            ffmpeg normalisation + duration limit
│   ├── errors.js  util.js  logger.js
│   ├── stt/
│   │   ├── index.js        provider factory
│   │   ├── assemblyai.js   AssemblyAI adapter (primary)
│   │   ├── deepgram.js     Deepgram adapter (fallback)
│   │   └── http.js         fetch + retry + status->error mapping
│   └── parser/
│       ├── vocab.js        spoken-chess vocabulary + STT keyterms
│       ├── tokenize.js     words -> typed items (piece/square/capture/castle...)
│       ├── spec.js         items -> move phrase; phrase -> legal moves (pure logic)
│       └── index.js        parseGame(): sequential, legality-checked, never guesses
├── test/                   *.test.js (node:test)
└── testutil/               words.js (synthetic speech), mockServer.js
```

---

## 3. Install, configure, run, test (any machine with Node >= 20.3)

```bash
npm install                 # installs pinned dependencies; ffmpeg-static is optional (see below)
cp .env.example .env        # then edit .env
```

Create an access token and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Minimum `.env` for local testing:

```
ASSEMBLYAI_API_KEY=your-assemblyai-key
ACCESS_TOKENS=the-token-you-just-generated
```

Run:

```bash
npm start                   # http://localhost:3000   (health: /api/health)
```

Tests:

```bash
npm run test:offline        # 85 tests, no network, no API key, no npm packages needed
npm test                    # everything, INCLUDING parser.test.js and api.test.js (needs npm install)
npm run test:parser         # engine-backed parser tests only
npm run test:api            # HTTP API tests only
```

Try the parser without audio or API key:

```bash
npm run parse -- "e4 e5 knight f3 knight c6 bishop b5"
npm run parse -- "d3 d6 knight f3 knight f6 knight d2"          # shows an AMBIGUOUS stop
npm run parse -- --override 6=Nbd2 "d3 d6 knight f3 knight f6 knight d2"
```

### 3b. Run the full suite without Replit (GitHub Actions)

This folder includes `.github/workflows/test.yml`. Push the folder as the root of a GitHub repository (or open
the repo on github.com -> **Actions** -> **test** -> **Run workflow**). The workflow installs dependencies,
runs `npm test` (offline + parser + API tests), and publishes two downloadable artifacts: `package-lock.json`
and `test-output.txt`. The lockfile can also be generated locally with `npm install`.

ffmpeg: the server needs an `ffmpeg` binary. It uses, in order: `FFMPEG_PATH`, the bundled
`ffmpeg-static` package (optional dependency, downloads a binary during `npm install`), then `ffmpeg` on `PATH`.
If none exist, jobs fail with `AUDIO_TOOLING` and the server log says why.

---

## 4. Android-friendly setup with Replit

> Written from general knowledge of Replit. I have **not** run this on Replit, and Replit's UI changes
> often. If a step does not match what you see, tell me what you see.

1. Create a Replit account and a new **Node.js** Repl.
2. Get the `grandmaster-backend` folder into the Repl. Easiest: zip the folder, use **Files -> Upload** (or
   "Upload folder"), and unzip in the Shell with `unzip grandmaster-backend.zip`. Move the contents to the
   Repl root if needed (`package.json` must be at the root, or `cd` into the folder for every command).
3. Open the **Shell** tab and run:
   ```bash
   npm install
   ```
4. Open **Secrets** (the padlock tool) and add:
   | Key | Value |
   |---|---|
   | `ASSEMBLYAI_API_KEY` | your AssemblyAI key |
   | `ACCESS_TOKENS` | the token from the command in section 3 |
   | `ALLOWED_ORIGINS` | your Netlify URL (leave out for now if testing with `scripts/smoke.js`) |
5. Run the offline tests first, in the Shell:
   ```bash
   npm run test:offline
   ```
6. Then the full tests (these need the packages from step 3):
   ```bash
   npm test
   ```
7. Press **Run** (or `npm start`). Replit shows a public URL for the web server. Open `<that-url>/api/health`
   in Chrome on your Android phone: you should see `{"ok":true,...}`.
8. Send me the **complete output** of `npm run test:offline` and `npm test`, including any red errors.

Replit notes:
- Secrets are the Replit equivalent of `.env`. Do not paste keys into files.
- Free Repls sleep when idle. Use them for testing; Render is the planned host.
- If `ffmpeg` is missing, `replit.nix` asks for it, or rely on the `ffmpeg-static` package from `npm install`.
- If the test command says `Cannot find module 'chess.js'` (or express, multer...), `npm install` did not finish.

---

## 5. Environment variables

See `.env.example` for the full annotated list. Summary:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ASSEMBLYAI_API_KEY` | yes (if provider=assemblyai) | | STT key. Server-side only. |
| `ACCESS_TOKENS` | yes | | Comma-separated bearer tokens, 16+ chars each |
| `ALLOWED_ORIGINS` | **yes in production** | (dev: any) | CORS allow-list (your Netlify URL) |
| `NODE_ENV` | | development | `production` enforces `ALLOWED_ORIGINS` |
| `PORT` | | 3000 | Render/Replit set it |
| `STT_PROVIDER` | | assemblyai | `assemblyai` or `deepgram` |
| `ASSEMBLYAI_SPEECH_MODELS` | | `universal-3-5-pro,universal-2` | model preference order |
| `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL` | if deepgram | `nova-3` | fallback provider |
| `MAX_AUDIO_SECONDS` | | 600 | duration limit (10 min) |
| `MAX_UPLOAD_MB` | | 100 | upload size limit |
| `MAX_CONCURRENT_JOBS` / `MAX_QUEUED_JOBS` | | 1 / 5 | queue sizing (keep 1 on free tier) |
| `JOB_TTL_MIN` | | 60 | finished jobs kept this long |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SEC` | | 60 / 60 | per-IP API limit |
| `JOB_CREATE_LIMIT_PER_HOUR` | | 20 | uploads per token per hour (each costs money) |
| `TRUST_PROXY_HOPS` | | 1 | reverse proxies in front (Render = 1) |
| `FFMPEG_PATH`, `TMP_DIR`, `LOG_LEVEL`, `STT_TIMEOUT_SEC`, `STT_POLL_INTERVAL_MS` | | | tuning |

The server refuses to start (and says why) if tokens/keys/origins are missing or malformed.

---

## 6. API

All endpoints except `/api/health` need `Authorization: Bearer <token>` (never in the URL).
Errors always look like `{"error":{"code":"...","message":"...","retryable":true|false}}`.

### `GET /api/health`
No auth. Wakes a sleeping Render instance. Returns `{ok, version, sttProvider, maxAudioSeconds, maxUploadBytes}`.

### `POST /api/jobs`
`multipart/form-data`, one file in the field **`audio`**. Returns **202**:
```json
{ "id": "3f2a...32 hex...", "status": "queued", "pollUrl": "/api/jobs/3f2a..." }
```

```bash
curl -H "Authorization: Bearer $TOKEN" -F "audio=@recording.m4a;type=audio/mp4" http://localhost:3000/api/jobs
```

### `GET /api/jobs/:id`  (`?include=words` adds every recognised word)
```json
{
  "id": "...", "status": "queued|processing|done|error",
  "stage": "normalizing|stt_uploading|stt_queued|stt_processing|parsing|done|error",
  "progress": 0-100, "createdAt": "...", "expiresAt": "...",
  "error": { "code": "...", "message": "...", "retryable": false },
  "result": {
    "audio": { "durationMs": 187400 },
    "transcript": { "provider": "assemblyai", "wordCount": 412, "text": "...", "words": [ ... only with ?include=words ... ] },
    "parse": {
      "status": "complete | needs_review | no_moves",
      "pgn": "1. e4 e5 2. Nf3 ...", "result": "1-0|0-1|1/2-1/2|*", "finalFen": "...",
      "moves": [ {
        "index": 0, "moveNumber": 1, "color": "w", "san": "e4", "from": "e2", "to": "e4",
        "piece": "p", "captured": null, "promotion": null, "flags": "b", "fen": "...",
        "startMs": 1000, "endMs": 1400, "confidence": 0.98, "heard": "e4", "wordIndex": 0,
        "source": "speech|override|inserted", "warnings": ["low_confidence"]
      } ],
      "unresolved": null,
      "leftover": [ { "kind": "PIECE", "text": "rook", "startMs": 5300, "afterMove": 2 } ],
      "warnings": [ { "code": "unparsed_chess_words", "count": 1 } ],
      "stats": { "wordsIn": 412, "moves": 61, "lowConfidence": 2 }
    }
  }
}
```
Timestamps are **milliseconds from the start of the uploaded audio**. `startMs` is when the first word of
that move was spoken. Poll every 2-3 s.

### `POST /api/jobs/:id/reparse`
Applies human corrections to the stored transcript **without a second STT charge**.
```json
{ "overrides": {
    "6":  { "san": "Nbd2" },              // replace the phrase that starts at word 6
    "12": { "skip": true },               // that phrase was not a move
    "30": { "insertBefore": ["Nc6"] }     // the STT dropped this move (inserted moves have startMs = null)
} }
```
Returns `{ "id": "...", "parse": { ...same shape as above... } }`. Keys are the `wordIndex` values from the result.

### `DELETE /api/jobs/:id`
Cancels (if running) and deletes the job. Returns `{ "ok": true }`.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | missing/invalid token |
| `RATE_LIMITED` | 429 | slow down (retryable) |
| `SERVER_BUSY` | 503 | queue full; `Retry-After: 30` (retryable) |
| `NO_FILE`, `EMPTY_FILE`, `UPLOAD_INVALID`, `VALIDATION` | 400 | bad request |
| `UNSUPPORTED_TYPE` | 415 | not an audio upload |
| `UPLOAD_TOO_LARGE`, `AUDIO_TOO_LONG` | 413 | over size / duration limit |
| `AUDIO_UNREADABLE`, `AUDIO_EMPTY` | 422 | ffmpeg could not decode / no audio |
| `JOB_NOT_FOUND` | 404 | unknown, expired, **or server restarted** (Render free tier) -> upload again |
| `JOB_NOT_READY` | 409 | reparse before the job finished |
| `STT_AUTH`, `STT_QUOTA`, `STT_FAILED`, `STT_BAD_RESPONSE` | 502 | provider problem (server-side config) |
| `STT_RATE_LIMIT`, `STT_UNAVAILABLE`, `STT_NETWORK`, `STT_TIMEOUT` | 503/504 | transient (retryable) |
| `AUDIO_TOOLING` | 500 | ffmpeg missing on the server |
| `INTERNAL` | 500 | unexpected; details only in server logs |

---

## 7. How move parsing works (and its honest limits)

1. Words from the STT provider are turned into items: pieces, squares, "takes", castling, promotion, check/mate.
2. Starting from the standard position, each spoken phrase is matched against the **legal moves of the
   current position** (chess.js).
3. Exactly one legal match -> move accepted. Zero matches (**illegal**), several matches (**ambiguous**,
   e.g. two knights can reach d2), or a pawn reaching the last rank without a piece (**needs_promotion**)
   -> the parse **stops** with the candidates. Later moves depend on this one, so nothing is guessed.
4. Fix it with `/reparse` overrides (or speak/re-record clearly). No extra STT cost.

Accepted phrasing (case/punctuation do not matter):
`e4` · `e four` · `pawn to e4` · `knight f3` · `night f three` · `Nf3` · `knight takes e5` · `knight b d2` ·
`rook one d one` (rank disambiguation) · `e takes d5` · `exd5` · `queen takes f7 checkmate` ·
`castles` / `castles kingside` / `castles queen side` / `short castle` / `O-O` / `oh oh` ·
`g takes h8 equals queen` / `gxh8=Q` / `e8 queen` · long form with a joiner: `e2 to e4`, `knight g1 to f3`.
Homophones `be/see/dee/eff/gee/aitch` count as files only directly before a rank; `won/for/ate` as ranks only
directly after a file. Move numbers and ordinary commentary are ignored.

Known limitations:
- Standard starting position only; no FEN, no variations, one game per recording.
- Long form **without** a joiner (`knight g1 f3`) is not supported (it would be ambiguous with two consecutive moves).
- A pawn move with no file and no "takes" is a push; pawn captures must name a file ("e takes d5").
- `to`/`too` spoken right after a file is read as rank 2 unless a new square follows (`e to e four` = filler).
- A bare `castles` when both castles are legal is reported as ambiguous.
- If the STT **drops** a move, the next move usually fails as `illegal`; use `insertBefore` to repair it.
- Chess-looking words that fit no move are listed in `leftover` (warning), not silently discarded.
- Only checkmate and stalemate end the game; draws by repetition/50 moves do not stop parsing.
- `spoken_check_but_not_check` / `spoken_mate_but_not_checkmate` warnings flag likely mis-recognitions.

---

## 8. Security summary

- API keys live only in server environment variables; nothing secret is sent to or stored in the frontend.
- Bearer tokens, compared in constant time; tokens are accepted only in the `Authorization` header.
- Per-IP rate limit, per-token upload limit, upload size/type limits, duration limit, queue limit.
- Uploads are stored under random names in a private temp directory and deleted when the job finishes, fails or is cancelled.
- Jobs are scoped to the token that created them.
- Strict validation of ids and override bodies; error messages never contain provider text, paths or keys;
  the logger redacts secret values even if they appear inside strings.
- `helmet` headers, CORS allow-list, no `X-Powered-By`.
- Audio is sent to AssemblyAI for transcription and the transcript is deleted from AssemblyAI after retrieval (best effort).
- **Not covered**: per-user accounts, HTTPS termination (Render/Replit provide it), audit logging.

---

## 9. Deploy to Render (later)

1. Push this project root, including `package-lock.json`, to a GitHub repo. For reproducible builds, change
   `buildCommand` in `render.yaml` to `npm ci --omit=dev`.
2. Render dashboard -> **New -> Blueprint** (uses `render.yaml`) or **New -> Web Service** with:
   Build `npm install --omit=dev`, Start `npm start`, Health check path `/api/health`.
3. Environment tab: set `ASSEMBLYAI_API_KEY`, `ACCESS_TOKENS`, `ALLOWED_ORIGINS` (your Netlify URL, no trailing slash),
   `NODE_ENV=production`.
4. Deploy, then open `https://<service>.onrender.com/api/health`.

Render free tier: the service sleeps after ~15 minutes idle (first request then takes 30-60 s), has 512 MB RAM,
0.1 CPU, and loses in-memory jobs on every restart (clients must handle `JOB_NOT_FOUND`). The **Starter**
plan removes sleep with no code change. Whether `ffmpeg-static` installs and runs on Render's build image is
**untested**; if jobs fail with `AUDIO_TOOLING`, tell me and I will switch to a Docker deploy with a system ffmpeg.

---

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server exits at start with "Configuration problems" | missing/short `ACCESS_TOKENS`, missing API key, or (production) missing `ALLOWED_ORIGINS` |
| `Cannot find module 'express'` / `chess.js` ... | `npm install` not run or failed |
| `npm install` ETARGET / "No matching version" | a pinned version in `package.json` is wrong (I could not verify them) - send me the message |
| 401 on every call | token mismatch; header must be `Authorization: Bearer <token>` |
| Browser CORS error | `ALLOWED_ORIGINS` must exactly equal the page origin (scheme + host, no trailing slash) |
| First call takes ~1 min | Render free tier waking up; call `/api/health` first |
| `AUDIO_TOOLING` | no ffmpeg binary; set `FFMPEG_PATH` or install ffmpeg |
| `STT_AUTH` | wrong/expired AssemblyAI key on the server |
| `needs_review` results | normal: see section 7; fix via `/reparse` |
