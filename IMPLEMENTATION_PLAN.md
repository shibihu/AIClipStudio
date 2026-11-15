# IMPLEMENTATION PLAN

Principle: incremental, contract-first, no rewrite of working render paths. Every phase ends with a runnable test gate.

## Phase 0 — Audit (complete)

- Inspect both repos, run baseline tests, record confirmed vs suspected findings.
- Deliverables: `SYSTEM_AUDIT.md`, `KNOWN_ISSUES.md`, `IMPLEMENTATION_PLAN.md`, `API_COMPATIBILITY.md`, `TEST_PLAN.md`.

## Phase 1 — STT and subtitle pipeline (this pass)

1. Add `stt.js`: provider adapter interface, Gemini audio adapter, OpenAI Whisper adapter, configurable model, timeout, retry, fallback, audio format/size validation, structured `SttError`.
2. Keep `ai.js.transcribeAudio()` as a compatibility delegate; return cues or throw `SttError`. Never return `null` for a provider failure.
3. Update `/api/captions`:
   - correct `transcribeAudio(audioPath, options, { instructions })` call;
   - map `SttError` to HTTP status + `{error:{code,message,retryable,provider}}` and a user-safe `reply`;
   - distinguish no-speech (`STT_NO_SPEECH_DETECTED`) from provider failure.
4. Expose STT capabilities and supported error codes in `/api/health`, `/api/version`.
5. Preserve Thai/English cue normalization, wrapping and source audio.
6. Add tests: provider selection, missing key, timeout, rate limit, unsupported provider, invalid response, no speech, empty transcript, Thai cue preservation.
7. Verify positioning propagation with existing FFmpeg integration tests (already cover 5 positions, Thai text, audio preservation).

Gate: `node --test test/stt.test.js test/engine.test.js test/subtitle-layout.test.js test/render-integration.test.js`.

## Phase 2 — Native/backend integration (this pass)

1. Add `GET /api/version` with `backendVersion`, `apiSchemaVersion`, capabilities (`stt`, `subtitle`, `render`, `sceneDetection`) and limits.
2. Add `POST /api/tool` implementing `detect_scenes` (FFmpeg scene score), returning `{result:{scenes:[{time,score}],threshold,count}}`; validate job + tool + threshold.
3. Android `readResponse`: parse string **or** object errors, preserve code/status; surface `retryable`.
4. Android compatibility check: require minimum schema; show actionable warning for outdated backend.
5. Remove duplicate assistant error summary for all-failed skill runs; keep one failed tool card with Retry. Mixed runs summarize only successes.
6. Subtitle position/style end-to-end:
   - Android sends `position`, `style`, `mode` to `/api/captions`;
   - preview uses the same position and max-lines/style defaults as the request;
   - add a position selector in the editor subtitle panel (seven positions).
7. Preview fixes: no ellipsis truncation, correct audio volume clamp, avoid duplicate caption layers.

Gate: Android `./gradlew testDebugUnitTest`, backend `api.test.js` + integration tests.

## Phase 3 — Project persistence and media lifecycle (this pass, JSON store)

1. Add `ProjectStore` (atomic JSON in `filesDir`, `.bak` recovery) containing source metadata/URI, full timeline, playhead, subtitle position/style, backend job binding, schema version.
2. Autosave on timeline mutation and throttled playhead updates; restore on process start; graceful missing-media state; explicit Delete Project (never deletes the source file).
3. Prune old `backend-media` downloads; enforce a minimum free-space check; keep the currently referenced file.
4. Keep a SharedPreferences migration path for the legacy `imported_video_uri` key.

Gate: JVM tests for round-trip, corrupt-file recovery, missing-media path, timeline fidelity.

## Phase 4 — Audio mixing/export (next pass)

- Evaluate Media3 `Composition` multi-sequence audio mixing on device; if unsupported, implement a native mux/mix path or a backend composition endpoint.
- Do not expose export as complete until audio actually reaches the MP4 and is verified by ffprobe + audible playback.

Gate: exported file has expected audio stream, duration, and mixed track; device playback check.

## Phase 5 — Timeline/editor features (next passes)

- Multi-track model, drag/drop, zoom, snapping, undo/redo stack, canvas gestures, sticker/sound/transition/animation libraries.
- Build backend rendering for every control exposed in UI; otherwise hide the control.

## Phase 6 — Render reliability (partial this pass)

1. Kill FFmpeg on watchdog; clear pending marker; mark failed with user-safe report.
2. Bound queue (`MAX_RENDER_QUEUE`, default 8) and return 429 with structured error.
3. Validate output: file exists/non-zero, ffprobe stream presence, duration tolerance, resolution, fps, decodability probe.
4. Add cancellation endpoint and queue ETA later.

## Phase 7 — Security/deployment (partial this pass)

1. Reject non-audio/video uploads using extension + MIME allowlist and ffprobe validation.
2. Validate job ids on every job-scoped route.
3. Sanitize top-level 500 responses.
4. Document free vs paid disk behavior; keep `AUTH_TOKEN` warning.

Later: per-job ownership, signed URLs, persistent rate limits.

## Phase 8 — QA (continuous)

- Backend: STT unit tests, API HTTP tests, existing FFmpeg integration suite.
- Android: JVM tests for layout, persistence, error de-duplication, schema compatibility.
- Device checklist in `TEST_PLAN.md` remains mandatory before release.
