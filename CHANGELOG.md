# CHANGELOG

## Unreleased — stabilization pass 1

### Backend (`/root/AIClipStudio`)

- Added `stt.js`: Gemini/OpenAI/Groq transcription adapters, provider chain with
  fallback, per-request timeout, bounded retries, audio format/size validation,
  structured `SttError` with stable codes, and capability reporting.
- `ai.js.transcribeAudio()` now delegates to `stt.js` and never returns `null`
  for a failed transcription.
- `server.js`:
  - structured STT error responses in `/api/captions`;
  - `GET /api/version` with server version and API schema;
  - capability flags in `/api/health`;
  - `/api/tool` with `detect_scenes` for the Android client;
  - consistent job-id validation;
  - upload MIME/magic validation;
  - bounded render queue, FFmpeg watchdog kill, render-output validation, and
    sanitized 500 responses.
- Added HTTP contract tests (`test/api.test.js`) and STT tests
  (`test/stt.test.js`).
- Version `1.1.0`, API schema `2`.

### Android (`/root/FirstMobileApp`)

- Added canonical `SubtitlePosition` matching backend wire names.
- `SubtitleLayout` now anchors top/center/bottom blocks inside the safe area and
  honors configurable line limits.
- Preview subtitle overlay uses the computed block edges, position alignment,
  and position-aware text alignment; the ellipsis fallback is removed.
- Subtitle panel exposes all seven positions and 1–4 line limits; values are
  sent to `POST /api/captions` as `position` and `style.maxLines`.
- Added versioned binary `EditorProjectCodec` and atomic `ProjectStore`
  (`.tmp` + fsync + `.bak` recovery). The project, timeline, subtitles, audio
  clips, and subtitle layout restore on launch.
- Added "Delete project" with confirmation and full workspace reset.
- Backend errors now parse both string and structured `{ code, message }`
  payloads. Read timeout raised to 120 s.
- Assistant skill failures no longer repeat the error text in both the per-skill
  row and the summary.
- Audio volume is clamped to `0f..1f` in the view model, preview, and slider.
- Added `BackendCompatibility` (minimum schema 2) and wired it into the
  connection check and Skill execution guard.
- Downloaded renders are pruned to the newest four files, with a 64 MB free
  space guard before download.

### Verification

- Android: `./gradlew testDebugUnitTest --offline` — 32 tests pass.
- Backend: `node --test test/engine.test.js test/stt.test.js test/api.test.js
  test/subtitle-layout.test.js test/render-report.test.js` — 112 tests pass.
- Not verified on a device: preview/export overlay parity and audio mixing.
