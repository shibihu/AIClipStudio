# KNOWN ISSUES

Status legend: `CONFIRMED` = reproduced by test or direct code/route trace; `SUSPECTED` = needs device/runtime verification; `FIXED` = changed and covered in this pass.

| ID | Sev | Status | Issue | Evidence | Target |
|---|---|---|---|---|---|
| P0-1 | P0 | FIXED | STT Gemini-only; failures return `null` | `ai.js` old `transcribeAudio`; new `stt.js` adapters | Phase 1 |
| P0-2 | P0 | FIXED | STT called with `meta` as options | `server.js` call site + `stt.test.js` | Phase 1 |
| P0-3 | P0 | FIXED | No STT timeout/retry/fallback | `stt.js` timeout + retries + provider chain | Phase 1 |
| P0-4 | P0 | FIXED | `/api/tool` missing for Scene detection | route trace; new handler + HTTP test | Phase 2 |
| P0-5 | P0 | FIXED | Timeline not persisted across restart | versioned binary `EditorProjectCodec` + atomic `ProjectStore` + JVM round-trip tests | Phase 3 |
| P0-6 | P0 | FIXED | Preview hardcoded bottom-centre; no style request | position-aware preview overlay + position/max-lines UI + captions API params | Phase 1/2 |
| P0-7 | P0 | OPEN | Imported audio not mixed into export | `AppViewModel.exportVideo` guard | Phase 4/6 |
| P0-8 | P0 | FIXED | Failed skill shows tool error + assistant duplicate | ViewModel summary logic | Phase 2 |
| P0-9 | P0 | FIXED | Structured object errors hidden by Android | `readResponse` object/string parsing | Phase 2 |
| P1-1 | P1 | FIXED | No backend/schema/capability contract | `/api/version` + health + `BackendCompatibility` (min schema 2) | Phase 2 |
| P1-2 | P1 | FIXED | Watchdog does not kill FFmpeg | `startRender` kill + queue cleanup | Phase 6 |
| P1-3 | P1 | FIXED | Unbounded render queue | `MAX_RENDER_QUEUE` + 429 | Phase 6 |
| P1-4 | P1 | PARTIAL | Shallow render output validation | `validateRenderOutput()` | Phase 6 |
| P1-5 | P1 | FIXED | Arbitrary upload types | magic/type validation | Phase 7 |
| P1-6 | P1 | OPEN | Shared token grants access to all jobs | auth design | Phase 7 |
| P1-7 | P1 | FIXED | Preview volume clamped to 1 | `AudioTrackPlayback` | Phase 2 |
| P1-8 | P1 | OPEN | Playlist rebuilt every timeline edit | `VideoPreview` LaunchedEffect | Phase 2 |
| P1-9 | P1 | OPEN | Local export omits subtitles/overlays/transitions | `ExportRepository` | Phase 4/6 |
| P1-10 | P1 | PARTIAL | No backend HTTP tests | new `api.test.js` | Phase 8 |
| P1-11 | P1 | OPEN | No Android device tests | test plan only | Phase 8 |
| P1-12 | P1 | FIXED | Job id validation inconsistent | `validJobId()` on all job routes | Phase 7 |
| P2-1 | P2 | FIXED | Preview ellipsis can truncate | `TextOverflow.Clip` + engine wraps | Phase 2 |
| P2-2 | P2 | OPEN | No bundled Thai font | `vendor/fonts` | Phase 1 |
| P2-3 | P2 | FIXED | Downloaded renders never pruned | `pruneDownloadedMedia` keeps newest renders | Phase 3 |
| P2-4 | P2 | FIXED | No free-space check before download | `StatFs` guard before render download | Phase 3 |
| P2-5 | P2 | OPEN | No thumbnail cache | MediaRepository | Phase 3 |
| P2-6 | P2 | OPEN | No duplicate asset prevention | MediaRepository | Phase 3 |
| P2-7 | P2 | OPEN | In-memory rate limiter per IP | server | Phase 7 |
| P2-8 | P2 | OPEN | Oversized JSON gets no 413 | `readJson` | Phase 7 |
| P2-9 | P2 | PARTIAL | Autosave write frequency | playhead-only ticks skipped + content dedupe; no time-based debounce | Phase 3 |
| P2-10 | P2 | OPEN | TTL cleanup can remove active job | `cleanupJobs` | Phase 6 |
| P2-11 | P2 | OPEN | Filmstrip cache has no TTL | `/api/strip` | Phase 6 |
| P2-12 | P2 | OPEN | No cancel/queue ETA endpoint | render API | Phase 6 |
| P3-* | P3 | OPEN | Multi-track editor, transitions, stickers, animation, canvas | audit §3 | Phase 4/5 |
