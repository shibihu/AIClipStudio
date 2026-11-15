# TEST PLAN

## Automated gates

### Backend
Run from `/root/AIClipStudio`:

```bash
node --test test/engine.test.js test/subtitle-layout.test.js test/render-report.test.js
node --test test/stt.test.js
node --test test/api.test.js
node --test test/render-integration.test.js
```

Coverage required:
- STT provider selection (Gemini/OpenAI; text-only providers rejected).
- Missing API key, unsupported provider, unreachable, 429, timeout, oversized, invalid payload, no speech, empty transcript.
- Thai and English cue normalisation, ordering, no word loss, no overlap.
- Position → ASS alignment for all seven positions; preview/export parity data.
- Add vs replace; detection confidence; audio preservation.
- `/api/version` schema/capabilities.
- `/api/tool detect_scenes`.
- Job id validation and upload type rejection.
- Render queue limit and output validation helpers.

### Android
Run from `/root/FirstMobileApp`:

```bash
./gradlew testDebugUnitTest --offline
```

Coverage required:
- Subtitle layout for 9:16, 16:9, 1:1, extreme frames.
- Position-aware vertical/horizontal anchors.
- Thai combining marks stay attached.
- Project snapshot round-trip, corrupt snapshot recovery, missing-media state, timeline fidelity.
- Backend compatibility parsing (outdated schema, structured errors).
- Error de-duplication: all-failed skills produce one error card.
- Audio volume clamp consistency.

## Manual device matrix

Devices: small phone (≤5.5"), standard phone, tablet.

Scenarios:
1. Import 9:16, 16:9, 1:1 videos; restart app; timeline and playhead restored.
2. Import audio; set volume 0/50/100%; preview matches; export currently blocked (P0-7 documented).
3. Trim, split, delete, seek; preview stays on the correct clip across boundaries.
4. Auto subtitles with Gemini and OpenAI-compatible provider; verify Thai text and timestamps.
5. Each of the seven positions; compare preview frame with exported frame at the same timestamp.
6. Long Thai caption (no spaces), 2-line cap, safe margins, no truncation.
7. Add mode on a clip with burned-in captions: pixels untouched.
8. Replace mode: detection card reports confidence; before/after frames inspected; unrelated text preserved; failure reported truthfully.
9. Failed skill: exactly one error card, Retry preserves the prompt, no assistant duplicate.
10. Backend offline: actionable message; no success claim.
11. Outdated backend: compatibility warning with required schema version.
12. Low storage: download/export blocked with a clear message; no partial file left.
13. Background/foreground during playback and render; no duplicate audio playback.
14. Inspect exported MP4 with `ffprobe` (streams, duration, resolution, fps) and play it back.

## Regression rules

- Do not mark an issue fixed without a reproducing test or a measured frame/ffprobe check.
- Keep the full FFmpeg integration suite green.
- Any new API field must be documented in `API_COMPATIBILITY.md` and consumed defensively on Android.
