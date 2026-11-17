# Automatic Subtitle Jobs Design

## Intent

Remove the long synchronous automatic-caption request. Submission must return quickly, while the backend performs extraction, STT, normalization, and render enqueueing in a durable worker lifecycle that Android can observe and resume.

## Goals

- Add `POST /api/captions/jobs`, `GET /api/captions/jobs/:taskId`, and cancellation for the same task.
- Persist task state under `jobs/<jobId>/caption-tasks/<taskId>.json`.
- Expose the stages `queued`, `extracting_audio`, `uploading_audio`, `transcribing`, `normalizing`, `rendering`, `completed`, `failed`, and `cancelled`, with measurable progress where available.
- Reuse current caption normalization, render construction, and render queue behavior.
- Make Android submit once, poll off the UI thread, retain the task ID across restart, recover after network interruption, and distinguish retryable from terminal failures.
- Keep `POST /api/captions` unchanged for existing clients during migration.

## Non-goals

This change does not introduce an external queue, a second service, horizontal worker coordination, a new provider SDK, or a replacement for the existing render API. Gemini Files API support is added only if the current adapter can use the existing HTTP surface without a new dependency; otherwise the adapter retains its current bounded upload path and reports its limit.

## Architecture

`server.js` validates the source job and creates a task synchronously, then a bounded in-process worker advances it. Every state transition is written atomically to the task JSON, including timestamps, progress, provider/model, attempts, error, and render ID. On boot, queued and safely resumable non-terminal tasks are requeued; an interrupted provider call is retried within the total deadline, while an already-started render is represented by its existing render registry/persistence path.

The worker extracts one cached mono 16 kHz file per source fingerprint, validates its size, calls `stt.js` with a deadline and provider health/backoff policy, normalizes timestamped cues, and invokes the existing caption render enqueue path. Cancellation is cooperative: queued tasks are removed before work starts; active provider/render processes receive cancellation where supported, and no later stage may publish success after cancellation.

Android adds a small persisted caption-task record containing backend URL, source job ID, task ID, and last status. The API wrapper uses bounded request timeouts for submit/status/cancel. The view model polls with a configurable interval/backoff from `Dispatchers.IO`, updates stage/progress text, retries only transport failures or server-declared retryable errors, and clears the record only on completed, failed, or cancelled terminal state.

## Failure and observability rules

Errors use `{ code, message, retryable }` and distinguish extraction, STT, normalization, and rendering. Logs record task ID, source job ID, stage, duration, provider, model, attempt count, queue wait, audio bytes, and render duration; credentials and audio contents are never logged. Provider health is process-local with cooldown after repeated retryable failures, and all retry delays use bounded exponential backoff with jitter under a total task deadline.

## Acceptance proof

Backend tests cover immediate submission, every public stage shape, persistence/recovery, duplicate submission, cancellation, retryable/terminal errors, cache reuse, and render handoff. Android tests cover one submission, polling recovery, restart restoration, cancellation, timeout handling, and progress mapping. Existing caption and render suites must remain green.
