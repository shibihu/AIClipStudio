# SYSTEM AUDIT — AIClipStudio + FirstMobileApp

Date: 2026-11-15
Scope: backend `/root/AIClipStudio` (Node.js/FFmpeg) and Android `/root/FirstMobileApp`.
Method: source inspection, route/contract tracing, existing test runs, targeted runtime checks.

## 1. Verified baseline

| Area | Command | Result |
|---|---|---|
| Backend unit tests | `node --test test/engine.test.js test/render-report.test.js test/subtitle-layout.test.js` | 91/91 pass |
| Backend FFmpeg integration | `node --test test/render-integration.test.js` | 10/10 pass (real 9:16 clip, caption burn-in, replace mode, audio preservation) |
| Android JVM tests | `./gradlew testDebugUnitTest --offline` | BUILD SUCCESSFUL (cached; re-run required after changes) |
| FFmpeg runtime | `ffmpeg -version` | 8.1.2 available on PATH |
| Vendored fonts | `vendor/fonts/DejaVuSans-Bold.ttf` | Present (no Thai font in repo) |

No test run failed before modification. Findings below are therefore regressions/contract gaps, not failing baseline tests.

## 2. Architecture

### Backend
- Zero-dependency Node HTTP server (`server.js`, 1250 lines) plus `ai.js` (LLM + cue math + ASS).
- `subtitle-layout.js` is the authoritative caption geometry engine (positions, style, Thai wrapping, ASS).
- `subtitle-removal.js` detects and blurs burned-in caption bands.
- `caption-render.js` assembles add/replace render fragments.
- `render-report.js` produces user-safe summaries.
- Jobs under `jobs/<uuid>/job.json`; render queue is in-memory but `pending.json` rehydrates after restart.
- FFmpeg is synchronous-per-job (`RENDER_CONCURRENCY = 1`); client polls `/api/render`.

### Android
- Single-module Compose app, MVVM (`AppViewModel` StateFlow), Media3 ExoPlayer preview, Media3 Transformer export.
- `EditorTimeline` is a compact model: video segments, audio clips, subtitle cues, scene markers.
- `SubtitleLayout.kt` is a new, uncommitted Kotlin mirror of the server layout engine.
- Project state currently persists only the source URI in SharedPreferences.
- AI skills are declared in `AiSkill.kt`; execution is dispatched by `AppViewModel`.

## 3. Confirmed findings

### P0 — critical

**P0-1 STT provider is Gemini-only and silently returns `null`.**
`ai.js:779-836`: `transcribeAudio()` returns `null` when the active provider is not Gemini, on any HTTP failure, on malformed JSON, and on empty cues. Callers cannot distinguish "no speech" from "provider unreachable". A server with only `OPENAI_API_KEY` reports an AI key in `/api/health` but auto-captions always fail.

**P0-2 STT options contract is broken.**
`server.js` calls `transcribeAudio(audioPath, meta, { instructions })`; the function signature is `(audioPath, { maxBytes }, { instructions })`. The metadata object replaces the options object, so `maxBytes` is never applied and the call is misleading.

**P0-3 STT has no timeout and no cross-provider retry/fallback.**
The audio fetch has no `AbortSignal`. A stalled provider hangs the captions request until the client/OS timeout. Structurally valid JSON with no cues is indistinguishable from an upstream failure.

**P0-4 Android scene detection targets a route the backend does not implement.**
`AiClipStudioApi.detectScenes()` posts `/api/tool`; `server.js` has no `/api/tool` handler, so every Scene detection skill execution returns 404. (Route table verified by inspection; runtime check below.)

**P0-5 Android has no persistent editing project.**
Only `imported_video_uri` is stored (`AppViewModel.KEY_IMPORTED_VIDEO_URI`). After process death/restart the timeline resets to one full-length clip: trims, splits, audio clips, subtitle cues, scene markers and playhead are lost.

**P0-6 Preview subtitle placement is hardcoded bottom-centre.**
`VideoPreview.kt` always aligns the overlay `BottomCenter` and ignores the backend position. Android never sends `position`/`style` to `/api/captions`, so preview and export can disagree by construction.

**P0-7 Android export cannot mix imported audio tracks.**
`exportVideo()` refuses to export when `audioSegments` is non-empty (`AppViewModel.kt:274-279`). Timeline audio therefore cannot reach an exported MP4.

**P0-8 Android auto-caption failure produces duplicate errors.**
A failed subtitle skill creates a FAILED tool card, then `sendAssistantMessage` appends an assistant "Not completed: …" summary with the same text and a second Retry affordance.

**P0-9 Structured STT errors cannot reach Android.**
`AiClipStudioApi.readResponse()` reads `json.optString("error")`, which yields `""` for an object error payload and hides status codes. The UI can only show a generic HTTP message.

### P1 — core functionality incomplete/broken

**P1-1 No backend version/schema/capability contract.**
`/api/health` exposes some booleans, but no backend version, API schema version, STT capabilities or render capabilities. `/api/version` is POST-only (pin a version) and cannot be used for compatibility. Android validates only `androidSkills` and `captionInstructions`.

**P1-2 Render watchdog resolves without killing FFmpeg.**
`server.js:450` resolves the wait promise at 15 minutes without `proc.kill()`. The job is marked failed while the process may keep writing; a later `pumpRenders()` can run a second FFmpeg concurrently. Orphaned child processes are possible.

**P1-3 Render queue has no bound.**
`enqueueRender()` always pushes; `RENDER_CONCURRENCY` limits only execution. A client can queue unlimited jobs, consuming disk with `pending.json` and source versions.

**P1-4 Render output validation is shallow.**
Completion trusts FFmpeg exit code and `probe()`. `probe()` returns optimistic defaults (`hasVideo: true, hasAudio: true, fps: 30`) when `ffprobe` fails. There is no explicit check for non-zero size, duration, resolution, frame rate or decodability before returning `done`.

**P1-5 Upload accepts arbitrary files.**
`extOf()` falls back to `bin`; `parseMultipart` validates size only. `probe()` returns optimistic defaults on unreadable input, so a non-media upload can create a job that fails later with a render error.

**P1-6 Job authorization is all-or-nothing.**
With `AUTH_TOKEN`, any token holder can read/delete every job. There is no per-job ownership or signed media URL. Acceptable for a single-user deployment, not for multi-tenant production.

**P1-7 Android audio preview volume is clamped differently from the model.**
`AudioSegment.volume` is clamped to `0..4` in the view model, but `AudioTrackPlayback` clamps playback to `0..1`. The slider lies above 100%.

**P1-8 Android rebuilds the player playlist on every timeline mutation.**
`LaunchedEffect(exoPlayer, video.uri, timeline.videoSegments)` re-prepares and seeks on every trim/split/delete, which can cause visible stalls and position jumps during editing.

**P1-9 Media3 export ignores subtitles, overlays, transitions and animations.**
`ExportRepository` builds a composition only from clipped video items. Subtitle cues and other tracks are silently absent from the local MP4. The UI does not state this.

**P1-10 Backend has no HTTP/API tests.**
No test starts the HTTP server or exercises auth, route validation, structured error codes, `/api/version`, or scene detection. Engine and FFmpeg integration are covered.

**P1-11 Android has no instrumented or device tests.**
Only JVM tests exist. Preview/export parity, URI restore, lifecycle and low-storage behavior are unverified on a device.

**P1-12 Backend delete/upload job-id validation is inconsistent.**
`/api/job DELETE` validates the UUID shape; `/api/chat`, `/api/captions`, `/api/render` and `/api/job GET` rely on map/path lookups. Path traversal in media names is partly mitigated by the media regex, but job ids are not uniformly validated before path joins.

### P2 — UX/performance/reliability

- **P2-1** `SubtitleOverlay` uses `TextOverflow.Ellipsis`; pathological cues can be truncated in preview while the export engine never truncates.
- **P2-2** No Thai font asset is bundled. Render relies on host fontconfig; Android preview relies on the system Thai font. Long-term parity is not guaranteed.
- **P2-3** Android downloads every render into `filesDir/backend-media` and never prunes. Storage grows without bound.
- **P2-4** No free-space check before upload/export/download; a full disk produces opaque failures.
- **P2-5** No thumbnail cache on Android; Media3 renders the first frame each time.
- **P2-6** `MediaRepository` does not deduplicate imported assets.
- **P2-7** Rate limiting is in-memory per socket IP; behind a proxy all users share a bucket, and restarts reset limits.
- **P2-8** `readJson()` has no explicit 413 response; oversized bodies destroy the request and surface as a generic error.
- **P2-9** Playhead polling writes StateFlow every 200 ms; project autosave must throttle or it will thrash storage.
- **P2-10** Backend `JOBS_TTL_HOURS` cleanup runs every 30 min and uses directory mtime; active long jobs can be cleaned if mtime is not touched.
- **P2-11** `/api/strip` caches a filmstrip forever with no TTL/invalidations beyond job cleanup.
- **P2-12** No render queue progress ETA or cancellation endpoint; cancellation is only implicit via job deletion.

### P3 — feature expansion (not implemented)

- Multi-clip import, transitions, stickers, sound-effect library, Lottie/keyframe animation, visual canvas gestures.
- Timeline drag/drop, zoom, snapping, undo/redo history beyond one snackbar snapshot.
- Room-backed project database (a JSON project store is the incremental step in this pass).
- Multi-tenant accounts, per-job ACLs, signed URLs.

## 4. Suspected issues requiring device/runtime verification

1. Media3 `Composition` clip boundaries may drift by one frame across multiple clipped items; needs frame-diff testing on device.
2. `ExoPlayer` clipping + `seekTo(globalMs)` after rebuilding a multi-item playlist may land on the wrong clip when the playhead is near a boundary.
3. `AudioTrackPlayback` uses one ExoPlayer per audio clip and seeks when drift > 400 ms; audible stutter/overlap is possible on low-RAM devices.
4. Burned-in caption detection assumes horizontal bright text with ≥30% temporal persistence; dark, outlined, animated or non-Latin captions may be missed. No false-positive corpus exists.
5. Thai line breaking depends on `Intl.Segmenter('th')` in Node and `BreakIterator` on Android; dictionaries differ, so preview/export line breaks can differ for edge cases.
6. Render `expected` duration for speed changes is approximated and may make progress non-linear.
7. `/api/upload` 1 GB streaming limit is larger than the STT 20 MB limit; no separate audio-extraction quota check.

## 5. Security observations

- `AUTH_TOKEN` is optional and logs a clear "open access" warning. Production `render.yaml` leaves it `sync: false`, so a deploy can be public unless the operator sets it.
- Token comparison uses plain `===` (timing-visible in theory); acceptable for a shared human token, not for per-user auth.
- Error sanitization (`stripInternalDetails`) is applied to chat/render replies but top-level `500` responses still return `e.message`. Most messages are operational, but this can leak paths/filter text.
- Uploaded file names are sanitized for multipart headers on Android; backend derives extensions from filename/MIME and discards the original path. Media serving uses a strict regex.
- Android stores the backend token encrypted with Android Keystore AES/GCM. Good.
- No CSRF token, but auth uses a custom header or HttpOnly cookie with `SameSite=Lax`; state-changing routes accept JSON only.
- No secrets are committed (`.env` is gitignored).

## 6. Deployment

- `render.yaml` uses a paid `0.5c-512mb` plan with a 5 GB persistent disk at `jobs/`. Free plan has no disk; job history and pending renders are lost on restart.
- FFmpeg/ffprobe binaries are vendored (`vendor/ffmpeg-*`); the build command only chmods them. No apt install.
- Health check `/api/health` is public by design and reports provider presence (not key values).
- Single-process in-memory render registry means horizontal scaling is unsupported: another instance cannot poll a render started elsewhere.
- 512 MB RAM with 1 GB uploads and FFmpeg suggests OOM risk on long/high-resolution clips; no resource guard or per-job resolution limit.
