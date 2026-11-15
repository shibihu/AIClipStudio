# API COMPATIBILITY

Backend version: `1.1.0` (this pass; previously `1.0.0`)
API schema version: `2` (additive changes only; schema `1` clients keep working for existing routes)

## Compatibility policy

- Existing request/response fields are preserved. New fields are additive.
- Unknown request fields are ignored, except when a capability is explicitly required by the client.
- Android must read `apiSchemaVersion` and fail loudly if it is below its minimum (`2`).
- Structured errors always include a top-level `error` object; a legacy `reply`/`error` string may accompany it for old clients.

## Endpoints

### `GET /api/health`
Public (exempt from `AUTH_TOKEN`). Additive response fields:

```json
{
  "ok": true,
  "backend": { "name": "ai-clip-studio", "version": "1.1.0", "apiSchemaVersion": 2 },
  "ffmpeg": "/path/ffmpeg",
  "ffmpegOk": true,
  "aiKey": true,
  "llm": { "reachable": true },
  "auth": true,
  "renders": { "active": 0, "queued": 0, "concurrency": 1, "maxQueue": 8 },
  "capabilities": {
    "androidSkills": true,
    "captionInstructions": true,
    "subtitlePositioning": true,
    "subtitlePositions": ["top_center", "center", "bottom_center", "top_left", "top_right", "bottom_left", "bottom_right"],
    "subtitleModes": ["add", "replace"],
    "subtitleStyle": true,
    "burnedInSubtitleDetection": true,
    "renderDebugMode": false,
    "stt": {
      "available": true,
      "provider": "gemini",
      "providers": [{ "id": "gemini", "models": ["gemini-flash-latest"], "maxBytes": 20971520, "formats": ["audio/mpeg"] }],
      "errorCodes": ["STT_PROVIDER_UNSUPPORTED", "..."]
    },
    "sceneDetection": true,
    "renderValidation": true
  }
}
```

### `GET /api/version`
New. Same `backend` + `capabilities` payload as health, without health-only fields.

### `POST /api/tool`
New. Requires an existing job.

Request:
```json
{ "id": "<job uuid>", "tool": "detect_scenes", "args": { "threshold": 0.35 } }
```
Response:
```json
{ "result": { "scenes": [{ "time": 1.23, "score": 0.41 }], "threshold": 0.35, "count": 1 } }
```
Errors: `400` invalid tool/threshold, `404` unknown job, `422` no video stream, `500` FFmpeg failure. Scene detection uses `select='gt(scene,threshold)',showinfo`.

### `POST /api/captions`
Existing fields preserved: `id`, `auto`, `text`, `instructions`, `position`, `style`, `mode`, `layer`.

Additive behaviour:
- `position` is one of the seven canonical positions; invalid values add a warning and fall back to `bottom_center`.
- `style` accepts `fontSize`, `fontFamily`, `textColor`, `outlineColor`, `outlineWidth`, `background`, `backgroundOpacity`, `maxLines`, `safeMarginX`, `safeMarginY`, `bold`.
- `auto: true` now returns structured STT errors instead of a generic "couldn't transcribe" reply.

Success (auto/pasted) returns the existing `{ reply, renderId, summary, captions, position, positionLabel, alignment, ... }`.

STT error response:
```json
{
  "error": {
    "code": "STT_PROVIDER_UNREACHABLE",
    "message": "The speech service could not be reached. Try again shortly.",
    "retryable": true,
    "provider": "gemini"
  },
  "reply": "The speech service could not be reached. Try again shortly."
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `STT_PROVIDER_UNSUPPORTED` | 400 | Configured provider does not support audio, or unknown provider id |
| `STT_API_KEY_MISSING` | 503 | No audio-capable provider key is configured |
| `STT_PROVIDER_UNREACHABLE` | 502 | Network/DNS/5xx failure after retries |
| `STT_RATE_LIMITED` | 429 | Provider returned 429 after retries |
| `STT_TIMEOUT` | 504 | Provider exceeded `STT_TIMEOUT_MS` |
| `STT_AUDIO_TOO_LARGE` | 413 | Audio exceeds the provider byte limit |
| `STT_AUDIO_FORMAT_UNSUPPORTED` | 415 | Extension/MIME not accepted by the adapter |
| `STT_NO_SPEECH_DETECTED` | 422 | Valid provider response with zero cues |
| `STT_INVALID_RESPONSE` | 502 | Non-JSON/malformed cue payload |
| `STT_EMPTY_TRANSCRIPT` | 422 | Provider returned cues whose text is empty |

### Render endpoints
`/api/chat`, `/api/render`, `/api/job`, `/api/version` (POST pin), `/api/strip`, `/api/upload`, `/api/jobs`, `/api/auth` are unchanged in shape.

New structured render failure fields (additive):
- `success: false`
- `verification` present when pixel verification ran
- queue-full response: `429 { "error": { "code": "RENDER_QUEUE_FULL", ... } }`

## Android contract

- Minimum API schema: `2` (`BackendCompatibility.MIN_API_SCHEMA`).
- On mismatch: show "Backend is outdated" with the required version and the URL, and disable skills that depend on missing capabilities.
- `AiClipStudioApi.readResponse()` accepts:
  - legacy `{"error":"text"}`;
  - structured `{"error":{"code","message","retryable","provider"}}`.
- Auto subtitles request: `{ id, auto:true, instructions, position, style, mode }`.
- Scene detection request: `{ id, tool:"detect_scenes", args:{ threshold } }`.
- Version check: `GET /api/version`; fall back to `/api/health` if the backend predates the route.

## Breaking changes

None. Schema `2` is additive. The only behaviour change is that STT provider failures now return a non-2xx structured error instead of a silent 200 fallback. This is intentional and required for correctness; clients that treated every 200 as success must handle the new codes.
