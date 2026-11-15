# REMAINING ISSUES

Items that are still open after stabilization pass 1. Nothing here is marked
fixed without a reproduction or a passing test.

## P0

### P0-7 — Imported audio is not mixed into MP4 export

- Evidence: `AppViewModel.exportVideo` returns an explicit error when
  `editorTimeline.audioSegments` is non-empty.
- Impact: users can import and preview audio, but cannot export a video that
  contains it.
- Required fix: either Media3 multi-sequence composition or backend FFmpeg
  mixing with verified duration/offset behavior.
- Blocked on: device validation. Do not fake the export path.

## P1

### P1-6 — Shared auth token grants access to all jobs

- Evidence: `/api/health`, upload, captions, render, and tool routes validate the
  token but do not scope jobs to an owner.
- Required fix: per-token owner identity or per-job signed capability.

### P1-8 — Preview playlist rebuilt on every timeline edit

- Evidence: `VideoPreview` keys the media-item effect on
  `timeline.videoSegments`.
- Impact: trim/split rebuilds the ExoPlayer playlist and interrupts playback.
- Required fix: diff the segment list and preserve the player position.

### P1-9 — Local export omits subtitles, overlays, and transitions

- Evidence: `ExportRepository` composites only clipped video segments.
- Impact: exported MP4 does not match the preview for caption/overlay content.
- Required fix: burn captions with the same geometry as the preview, or render
  through the backend pipeline.

### P1-11 — No Android device/instrumented tests

- Evidence: only local JVM tests run in this environment.
- Required fix: instrumentation or managed-device coverage for import, preview,
  export, and project restore.

## P2

- **P2-2** No bundled Thai font; rendering depends on the device font stack.
- **P2-5** No thumbnail cache; repeated imports re-probe media.
- **P2-6** No duplicate-asset prevention in `MediaRepository`.
- **P2-7** In-memory rate limiter is per process/IP.
- **P2-8** Oversized JSON bodies have no explicit 413 response.
- **P2-9** Autosave skips playhead-only updates and duplicate snapshots, but has
  no time-based debounce; slider drags can still write repeatedly.
- **P2-10** TTL cleanup can remove a job that is still active.
- **P2-11** Filmstrip cache has no TTL.
- **P2-12** No render cancel or queue-ETA endpoint.

## P3

- Multi-track editor, transitions, stickers, animation, canvas tools.

## Device-only verification still required

1. Preview subtitle block edges vs exported video at 16:9, 9:16, and 1:1.
2. Thai combining marks and line wrapping with the device font.
3. ExoPlayer playlist stability across trim/split/seek.
4. Project restore after process death and after a partially written save.
5. Audio preview volume/offset and the eventual export mix.
