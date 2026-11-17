# Automatic Subtitle Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move automatic subtitle transcription behind a durable, pollable backend job API and migrate FirstMobileApp to submit, resume, and cancel those jobs without long HTTP waits.

**Architecture:** Add a persistent caption-task store and bounded worker in AIClipStudio. The worker reuses the existing audio/caption/render pipeline and `stt.js`; task JSON is the source of truth until render handoff, while the existing render registry reports render progress. Add a small Android task record and IO-scoped polling loop in `AiClipStudioApi`/`AppViewModel`.

**Tech Stack:** Node.js 20 built-in APIs and `node:test`; Kotlin, coroutines, Android `SharedPreferences`, and existing `HttpURLConnection` client.

**Spec:** `docs/automatic-subtitle-jobs-design.md`

## Global Constraints

- Preserve legacy `POST /api/captions` behavior for existing clients.
- New task states are exactly: `queued`, `extracting_audio`, `uploading_audio`, `transcribing`, `normalizing`, `rendering`, `completed`, `failed`, `cancelled`.
- Never log API keys or audio contents.
- Keep request timeouts bounded; do not use zero or infinite read timeouts.
- Preserve OpenAI and Groq STT adapters and existing subtitle render behavior.
- Keep the backend dependency-free and the Android UI non-blocking.

## Review Focus

- Duplicate submission must return/reuse one task rather than enqueueing twice; test the idempotency key and persisted task lookup in Task 1.
- Restart during each non-terminal stage must either safely resume or expose a retryable failure; test rehydration in Task 1.
- Cancellation racing with provider completion/render enqueue must never publish completed; test transition guards in Task 1 and Task 3.
- Network loss during Android polling must preserve the task ID and resume without resubmission; test the repository/persistence seam in Task 5.
- Provider failures must expose actionable retryability without leaking provider responses or secrets; test structured errors in Task 2 and Task 5.

### Task 1: Persistent backend caption-task lifecycle

**Files:**
- Create: `caption-jobs.js`
- Modify: `server.js`
- Test: `test/caption-jobs.test.js`

**Interfaces:**
- `createCaptionTask(jobId, request, deps) -> task`
- `getCaptionTask(jobId, taskId) -> task | null`
- `updateCaptionTask(jobId, taskId, patch) -> task`
- `cancelCaptionTask(jobId, taskId) -> task`
- `rehydrateCaptionTasks() -> void`

- [ ] Write failing unit tests for atomic persistence, public task shape, duplicate idempotency, legal stage transitions, cancellation, and restart rehydration.
- [ ] Run `node --test test/caption-jobs.test.js`; confirm failures are about the missing lifecycle.
- [ ] Implement JSON persistence using temp-file-plus-rename, UUID validation, transition guards, task deadline metadata, and a bounded in-memory queue backed by persisted state.
- [ ] Add route handling for `POST /api/captions/jobs`, `GET /api/captions/jobs/:taskId`, and `DELETE /api/captions/jobs/:taskId`; validate source job/media, request fields, and an idempotency key.
- [ ] Add boot rehydration and cooperative cancellation hooks without changing legacy `/api/captions`.
- [ ] Run the focused test and the existing backend suite.

### Task 2: Audio extraction/cache and STT reliability

**Files:**
- Modify: `stt.js`
- Modify: `server.js`
- Test: `test/stt.test.js`
- Test: `test/caption-jobs.test.js`

**Interfaces:**
- `transcribeAudio(audioPath, options, extra, deps)` continues returning timestamped cues or `SttError`.
- Add worker callbacks for stage/progress and cancellation signal without changing provider adapter contracts.

- [ ] Add failing tests for provider-specific timeouts, bounded exponential jitter, total deadline, unhealthy-provider cooldown, timestamp validation, and duration/attempt metadata.
- [ ] Add failing tests for cached mono 16 kHz extraction keyed by source stat/fingerprint, size validation, safe cleanup, and cancellation.
- [ ] Implement provider policy and health tracking in `stt.js`; retain Gemini/OpenAI/Groq adapters and avoid retries for non-retryable errors.
- [ ] Implement extraction as a streamed/temp-file operation with cache reuse and per-task cleanup.
- [ ] Add provider/model duration logging with sanitized fields; use Gemini Files API only within the current dependency-free HTTP implementation where size requires it, otherwise return the existing structured size error.
- [ ] Run `node --test test/stt.test.js test/caption-jobs.test.js` and the full backend suite.

### Task 3: Background worker and render handoff

**Files:**
- Modify: `server.js`
- Modify: `ai.js` only if a typed normalization seam is required
- Test: `test/caption-jobs.test.js`
- Test: `test/render-integration.test.js`

**Interfaces:**
- Worker consumes persisted tasks and calls existing caption/render helpers.
- Public status returns `{ taskId, status, stage, progress, renderId?, error? }`.

- [ ] Write failing tests for the stage sequence, queue wait, render ID handoff, separated STT/render failures, deadline expiry, bounded concurrency, and restart recovery.
- [ ] Implement the worker state machine: extraction, provider submission, normalization, render enqueue, and terminal completion/failure.
- [ ] Reuse existing caption render fragment and `enqueueRender`; map render completion/failure back to the task without duplicating render logic.
- [ ] Add task cleanup that excludes active tasks and removes orphaned temp audio safely.
- [ ] Run focused caption/render tests and the full backend suite.

### Task 4: Backend API contract and compatibility tests

**Files:**
- Modify: `API_COMPATIBILITY.md`
- Modify: `package.json` only if test coverage command needs inclusion
- Test: `test/api.test.js`

- [ ] Write failing HTTP tests for immediate POST response, status payloads, structured errors, duplicate requests, cancellation, invalid IDs, and legacy endpoint compatibility.
- [ ] Implement only the route/error mapping needed to satisfy the contract; keep task IDs scoped to source jobs/auth behavior already used by the server.
- [ ] Document polling and cancellation examples and the new schema version/capability if required by existing compatibility conventions.
- [ ] Run `node --test test/api.test.js test/caption-jobs.test.js` and the full backend test command.

### Task 5: Android API and durable polling

**Files:**
- Modify: `/root/FirstMobileApp/app/src/main/java/com/example/nativestarter/data/AiClipStudioApi.kt`
- Modify: `/root/FirstMobileApp/app/src/main/java/com/example/nativestarter/viewmodel/AppViewModel.kt`
- Modify: relevant AI UI screen/state file only for progress/cancel controls
- Test: Android unit tests under `app/src/test/java/com/example/nativestarter/data/` and `.../viewmodel/`

**Interfaces:**
- API methods: `submitCaptionJob`, `captionJobStatus`, `cancelCaptionJob`.
- Persisted record: backend URL, source job ID, task ID, and last known status.

- [ ] Write failing tests for request paths/payloads, bounded timeout policy, stage-to-message/progress mapping, idempotent submit, retryable transport errors, terminal errors, and cancellation.
- [ ] Implement API methods with bounded connection/read policies and structured error parsing.
- [ ] Implement `SharedPreferences` task persistence and an IO dispatcher polling job with configurable interval/backoff; restore and resume on view-model initialization.
- [ ] Prevent a second submission while a task is active, preserve task ID across temporary failures, and clear it only on terminal state.
- [ ] Wire meaningful progress and cancel action into the existing subtitle UI without blocking the main thread.
- [ ] Run `./gradlew test` (or the repository’s available focused Gradle test task) and assemble/debug if practical.

### Task 6: End-to-end verification and handoff

- [ ] Run backend `npm test`, all backend test files, and Android unit tests.
- [ ] Exercise submit → poll → render completion against a local backend with a small media fixture.
- [ ] Verify duplicate submission, process restart, network interruption, cancellation, provider timeout, and render failure manually or with test fixtures.
- [ ] Review logs for secrets/audio content and inspect `git diff` for unrelated changes.

