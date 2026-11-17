'use strict'

// ---------------------------------------------------------------------------
// caption-worker.js — bounded in-process worker for automatic caption tasks.
//
// A task submitted to POST /api/captions/jobs is persisted first, then handed
// to this worker. It walks the persisted task through the stage machine
// (queued → extracting_audio → transcribing → normalizing → rendering →
// completed) with these guarantees:
//   • every meaningful stage transition is persisted before work continues
//   • intermediate artifacts (extracted audio, transcript cues) are persisted
//     so a restart resumes instead of repeating paid provider work
//   • cancellation (queued or running) aborts provider requests and kills
//     FFmpeg processes, and a cancelled task can never advance a stage
//   • one task is processed by at most one worker run at a time (in-process
//     active set + persisted lease in the store)
//   • concurrency is bounded by CAPTION_WORKER_CONCURRENCY
// Observability (durations, sizes, provider facts) is recorded per task
// without ever logging audio content or API keys.
// ---------------------------------------------------------------------------

const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const fsp = require('node:fs/promises')

const STAGE_PROGRESS = Object.freeze({
  queued: 0,
  extracting_audio: 8,
  uploading_audio: 14,
  transcribing: 30,
  normalizing: 68,
  rendering: 74,
  completed: 100,
  failed: 100,
  cancelled: 100,
})

const STT_DEADLINE_MS = Math.max(30000, Number(process.env.CAPTION_STT_DEADLINE_MS) || 300000)
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.CAPTION_WORKER_CONCURRENCY) || 2))

// Error payload used when a task must fail safely (no retry, no completion).
function failure(code, message, { stage, retryable = false } = {}) {
  return { code, message, retryable, ...(stage ? { stage } : {}) }
}

class CaptionWorker {
  /**
   * @param {object} deps injected by server.js
   *   store            CaptionTaskStore
   *   jobsDir          absolute jobs/ directory
   *   ffmpeg           ffmpeg binary path
   *   probe(file)      ffprobe metadata helper from server.js
   *   transcribeAudio, SttError   from stt.js
   *   normalizeTranscriptCues     from ai.js
   *   detectBurnedInSubtitles, buildObscureGraph  from subtitle-removal.js
   *   buildCaptionRender          from caption-render.js
   *   enqueueCaptionRender(task, {frag, result, meta, userMsg}) → Promise<{rid}>
   *   waitForRender(rid, {signal, onProgress}) → Promise<{status, media?, reply?}>
   *   killRender(rid)             abort queued/running render FFmpeg
   */
  constructor(deps) {
    this.store = deps.store
    this.jobsDir = deps.jobsDir
    this.deps = deps
    this.concurrency = CONCURRENCY
    this.queue = []               // { jobId, taskId, enqueuedAt }
    this.queuedIds = new Set()
    this.active = new Map()       // taskId → { abort, procs, runToken }
    this.stopped = false
  }

  stats() {
    return { queued: this.queue.length, active: this.active.size, concurrency: this.concurrency }
  }

  /**
   * Submit a persisted task for processing. Returns false when the same task
   * is already queued or running (duplicate-submission guard).
   */
  submit(task) {
    if (this.stopped) return false
    if (this.active.has(task.taskId) || this.queuedIds.has(task.taskId)) return false
    this.queue.push({ jobId: task.jobId, taskId: task.taskId, enqueuedAt: Date.now() })
    this.queuedIds.add(task.taskId)
    this.pump()
    return true
  }

  /** Cancel a queued or running task: abort providers, kill FFmpeg, unqueue. */
  cancel(taskId) {
    this.queuedIds.delete(taskId)
    this.queue = this.queue.filter((entry) => entry.taskId !== taskId)
    const run = this.active.get(taskId)
    if (run) {
      run.cancelled = true
      try { run.abort.abort() } catch { /* already aborted */ }
      if (run.renderId) {
        try { this.deps.killRender?.(run.renderId) } catch { /* already gone */ }
      }
      for (const proc of run.procs) {
        try { proc.kill('SIGKILL') } catch { /* already gone */ }
      }
    }
    return Boolean(run)
  }

  pump() {
    while (!this.stopped && this.active.size < this.concurrency && this.queue.length) {
      const entry = this.queue.shift()
      this.queuedIds.delete(entry.taskId)
      const run = this.process(entry)
      this.active.set(entry.taskId, run)
      run.done.finally(() => {
        if (this.active.get(entry.taskId) === run) this.active.delete(entry.taskId)
        this.pump()
      })
    }
  }

  /** Runs one task end-to-end; never throws. */
  process(entry) {
    const run = { abort: new AbortController(), procs: new Set(), cancelled: false }
    run.done = (async () => {
      const { jobId, taskId, enqueuedAt } = entry
      const runToken = crypto.randomUUID()
      const claimed = await this.store.claim(jobId, taskId, runToken).catch(() => null)
      if (!claimed) return
      run.runToken = runToken
      const startedAt = Date.now()
      try {
        await this.execute(jobId, taskId, runToken, claimed, {
          queueWaitMs: startedAt - enqueuedAt,
          run,
        })
      } catch (e) {
        await this.settleError(jobId, taskId, runToken, e, run).catch(() => {})
      } finally {
        for (const proc of run.procs) {
          try { proc.kill('SIGKILL') } catch { /* already gone */ }
        }
        run.procs.clear()
        await this.store.heartbeat(jobId, taskId, runToken, { release: true }).catch(() => {})
      }
    })().catch((e) => {
      console.error(`[caption-worker] task ${entry.taskId} crashed:`, e?.message || e)
    })
    return run
  }

  /** True when the task was cancelled (persisted or signalled). */
  async isCancelled(jobId, taskId, run) {
    if (run.cancelled || run.abort.signal.aborted) return true
    const current = await this.store.get(jobId, taskId).catch(() => null)
    return !current || current.stage === 'cancelled' || current.stage === 'failed'
  }

  /**
   * Persist a patch (stage/progress/metrics/artifacts/renderId). Throws when
   * the task hit a terminal state (cancel/fail won the race).
   */
  async patch(jobId, taskId, patch) {
    const current = await this.store.getRaw(jobId, taskId).catch(() => null)
    const metrics = { ...(current?.metrics || {}), ...(patch.metrics || {}) }
    const artifacts = { ...(current?.artifacts || {}), ...(patch.artifacts || {}) }
    return this.store.update(jobId, taskId, {
      ...patch,
      ...(Object.keys(metrics).length ? { metrics } : {}),
      ...(Object.keys(artifacts).length ? { artifacts } : {}),
    })
  }

  audioFile(jobId, taskId) {
    return path.join(this.jobsDir, jobId, `caption-audio-${taskId}.mp3`)
  }

  async execute(jobId, taskId, runToken, claimed, { queueWaitMs, run }) {
    const { store, deps } = this
    const request = claimed.request || {}
    const options = request.options || {}
    const instructions = request.instructions || ''
    const srcName = options.srcName
    const src = path.join(this.jobsDir, jobId, srcName || '')

    // Source media must still exist; a deleted job can never complete.
    let sourceStat = null
    try { sourceStat = await fsp.stat(src) } catch { /* missing below */ }
    if (!srcName || !sourceStat) {
      await store.fail(jobId, taskId, failure('CAPTION_SOURCE_MISSING',
        'The source media for this caption task is gone. Re-open the project and submit again.',
        { stage: 'queued' }), { metrics: { failureStage: 'queued', errorCode: 'CAPTION_SOURCE_MISSING', queueWaitMs } })
      return
    }

    const meta = options.meta && options.meta.duration
      ? options.meta
      : await deps.probe(src)
    if (!meta || !meta.hasAudio) {
      await store.fail(jobId, taskId, failure('NO_AUDIO',
        'This version has no audio track to transcribe.', { stage: 'queued' }),
        { metrics: { failureStage: 'queued', errorCode: 'NO_AUDIO', queueWaitMs } })
      return
    }

    // ---- stage: extracting_audio ------------------------------------------
    await this.patch(jobId, taskId, { stage: 'extracting_audio', progress: STAGE_PROGRESS.extracting_audio })
    if (await this.isCancelled(jobId, taskId, run)) return
    const audioPath = this.audioFile(jobId, taskId)
    const extractStart = Date.now()
    let audioSize = 0
    try {
      const st = await fsp.stat(audioPath).catch(() => null)
      if (st && st.size > 0) {
        audioSize = st.size // reuse the artifact from an interrupted run
      } else {
        audioSize = await this.extractAudio(src, audioPath, run)
      }
    } catch (e) {
      await fsp.rm(audioPath, { force: true }).catch(() => {})
      if (await this.isCancelled(jobId, taskId, run)) return
      await store.fail(jobId, taskId, failure('STT_AUDIO_EXTRACTION_FAILED',
        'Could not extract the audio track for transcription.', { stage: 'extracting_audio' }),
        { metrics: { failureStage: 'extracting_audio', errorCode: 'STT_AUDIO_EXTRACTION_FAILED', audioExtractionMs: Date.now() - extractStart, queueWaitMs } })
      return
    }
    await this.patch(jobId, taskId, {
      progress: STAGE_PROGRESS.uploading_audio,
      metrics: { audioExtractionMs: Date.now() - extractStart, audioBytes: audioSize, queueWaitMs },
      artifacts: { audio: path.basename(audioPath) },
    })

    // ---- stage: transcribing ----------------------------------------------
    await this.patch(jobId, taskId, { stage: 'transcribing', progress: STAGE_PROGRESS.transcribing })
    if (await this.isCancelled(jobId, taskId, run)) { await this.cleanupAudio(jobId, taskId); return }
    const sttStart = Date.now()
    let stt
    try {
      stt = await deps.transcribeAudio(audioPath, { maxBytes: 20 * 1024 * 1024 }, { instructions }, {
        signal: run.abort.signal,
        deadlineAt: Date.now() + STT_DEADLINE_MS,
      })
    } catch (e) {
      await fsp.rm(audioPath, { force: true }).catch(() => {})
      if (await this.isCancelled(jobId, taskId, run)) return
      const stt = e instanceof deps.SttError ? e : new deps.SttError('STT_PROVIDER_UNREACHABLE',
        'The speech service is unreachable right now.')
      await store.fail(jobId, taskId, failure(stt.code, stt.message, { stage: 'transcribing', retryable: stt.retryable }), {
        metrics: {
          failureStage: 'transcribing', errorCode: stt.code, queueWaitMs,
          stt: { provider: stt.provider, model: stt.model, attempts: e.attempts || 0, durationMs: e.durationMs || (Date.now() - sttStart) },
        },
      })
      return
    }
    await this.patch(jobId, taskId, {
      progress: 60,
      metrics: { stt: { provider: stt.provider, model: stt.model, attempts: stt.attempts, durationMs: stt.durationMs } },
      artifacts: { cues: stt.cues },
    })

    // ---- stage: normalizing ------------------------------------------------
    await this.patch(jobId, taskId, { stage: 'normalizing', progress: STAGE_PROGRESS.normalizing })
    if (await this.isCancelled(jobId, taskId, run)) { await this.cleanupAudio(jobId, taskId); return }
    const normStart = Date.now()
    const placed = deps.normalizeTranscriptCues(stt.cues, meta, {
      maxChars: options.layout?.maxChars,
      maxLines: options.layout?.maxLines,
    })
    if (!placed.length) {
      await this.cleanupAudio(jobId, taskId)
      await store.fail(jobId, taskId, failure('STT_EMPTY_TRANSCRIPT',
        'The speech provider returned no usable caption cues for this clip.',
        { stage: 'normalizing' }),
        { metrics: { failureStage: 'normalizing', errorCode: 'STT_EMPTY_TRANSCRIPT', normalizationMs: Date.now() - normStart } })
      return
    }
    await this.patch(jobId, taskId, { metrics: { normalizationMs: Date.now() - normStart } })

    // ---- stage: rendering ---------------------------------------------------
    await this.patch(jobId, taskId, { stage: 'rendering', progress: STAGE_PROGRESS.rendering })
    if (await this.isCancelled(jobId, taskId, run)) { await this.cleanupAudio(jobId, taskId); return }
    const renderStart = Date.now()
    let caption
    try {
      caption = await this.buildRender(jobId, taskId, { placed, meta, options, instructions })
    } catch (e) {
      await this.cleanupAudio(jobId, taskId)
      if (await this.isCancelled(jobId, taskId, run)) return
      await store.fail(jobId, taskId, failure('CAPTION_RENDER_BUILD_FAILED',
        'Could not build the caption render for this clip.', { stage: 'rendering' }),
        { metrics: { failureStage: 'rendering', errorCode: 'CAPTION_RENDER_BUILD_FAILED', renderMs: Date.now() - renderStart } })
      return
    }

    let rid
    try {
      const enqueued = await deps.enqueueCaptionRender(
        { jobId, taskId },
        {
          frag: caption.frag,
          result: { summary: caption.summary, ops: caption.frag.desc },
          meta,
          srcName: options.srcName,
          userMsg: '🎙 auto-transcribe and caption the spoken words',
        },
      )
      rid = enqueued.rid
    } catch (e) {
      await this.cleanupAudio(jobId, taskId)
      if (await this.isCancelled(jobId, taskId, run)) return
      const code = e?.code === 'RENDER_QUEUE_FULL' ? 'RENDER_QUEUE_FULL' : 'CAPTION_RENDER_ENQUEUE_FAILED'
      await store.fail(jobId, taskId, failure(code, e?.message || 'The render queue refused the caption render.', { stage: 'rendering', retryable: code === 'RENDER_QUEUE_FULL' }),
        { metrics: { failureStage: 'rendering', errorCode: code, renderMs: Date.now() - renderStart } })
      return
    }
    await this.patch(jobId, taskId, { renderId: rid })

    let render
    try {
      run.renderId = rid
      render = await deps.waitForRender(rid, {
        signal: run.abort.signal,
        onProgress: (p) => {
          const mapped = STAGE_PROGRESS.rendering + Math.round((Math.max(0, Math.min(99, p)) / 100) * 25)
          this.patch(jobId, taskId, { progress: mapped }).catch(() => {})
        },
      })
    } catch (e) {
      // Cancelled or render lost. Never mark an unfinished task completed.
      if (await this.isCancelled(jobId, taskId, run)) { await this.cleanupAudio(jobId, taskId); return }
      await store.fail(jobId, taskId, failure('RENDER_LOST',
        'The caption render was interrupted by a server restart and could not be resumed.',
        { stage: 'rendering' }),
        { metrics: { failureStage: 'rendering', errorCode: 'RENDER_LOST', renderMs: Date.now() - renderStart, renderId: rid } })
      return
    }
    await this.cleanupAudio(jobId, taskId)
    if (render.status !== 'done') {
      await store.fail(jobId, taskId, failure('RENDER_FAILED',
        'Rendering the captions failed after a successful transcription.', { stage: 'rendering' }),
        { metrics: { failureStage: 'rendering', errorCode: 'RENDER_FAILED', renderMs: Date.now() - renderStart, renderId: rid } })
      return
    }
    await this.patch(jobId, taskId, {
      stage: 'completed', status: 'completed', progress: 100,
      metrics: { renderMs: Date.now() - renderStart, renderId: rid, totalMs: Date.now() - (claimed.createdAt || Date.now()) },
    })
    console.log(`[caption-worker] ${jobId}/${taskId} completed via render ${rid}`)
  }

  /** Replace-mode band detection + caption ASS/fragment build (server parity). */
  async buildRender(jobId, taskId, { placed, meta, options, instructions }) {
    const { deps } = this
    const layout = options.layout || {}
    const mode = options.mode || 'add'
    const src = path.join(this.jobsDir, jobId, options.srcName)
    let detection
    if (mode === 'replace') {
      detection = await deps.detectBurnedInSubtitles(this.deps.ffmpeg, src, meta, { samples: 24 })
    } else {
      detection = {
        found: false, skipped: true,
        reason: 'add mode never modifies existing video content, so burned-in text was left untouched',
      }
    }
    const caption = deps.buildCaptionRender({
      placed, meta, dir: path.join(this.jobsDir, jobId),
      layout: { ...layout, style: layout.style || {}, position: layout.position },
      mode, detection, layer: layout.layer,
    })
    const frag = caption.frag
    frag.facts = caption.facts
    frag.verify = caption.verify
    return { frag, summary: caption.summary }
  }

  /** Async, killable ffmpeg audio extraction (mono 16 kHz mp3, provider-ready). */
  extractAudio(src, dest, run) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.deps.ffmpeg, [
        '-y', '-hide_banner', '-i', src, '-vn', '-ac', '1', '-ar', '16000',
        '-b:a', '48k', '-map', 'a:0', dest,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      run.procs.add(proc)
      let errTail = ''
      proc.stderr.on('data', (d) => {
        errTail = (errTail + d.toString()).split('\n').slice(-4).join('\n')
      })
      proc.on('error', (e) => { run.procs.delete(proc); reject(e) })
      proc.on('close', (code) => {
        run.procs.delete(proc)
        if (code === 0) {
          fsp.stat(dest).then((st) => resolve(st.size)).catch(() => resolve(0))
        } else {
          reject(new Error(`ffmpeg audio extraction exited ${code}: ${errTail.slice(-300)}`))
        }
      })
    })
  }

  async cleanupAudio(jobId, taskId) {
    await fsp.rm(this.audioFile(jobId, taskId), { force: true }).catch(() => {})
  }

  /** Map an unexpected pipeline error to a structured failure — or swallow it when the task was cancelled first. */
  async settleError(jobId, taskId, runToken, error, run) {
    if (await this.isCancelled(jobId, taskId, run)) return
    const terminal = /task is terminal|invalid task transition/.test(String(error?.message))
    if (terminal) return // cancel/fail already persisted; never overwrite
    console.error(`[caption-worker] ${jobId}/${taskId} failed:`, error?.message || error)
    await this.store.fail(jobId, taskId, failure('CAPTION_TASK_FAILED',
      'Automatic subtitles failed while processing this task.', { retryable: true }),
      { metrics: { errorCode: 'CAPTION_TASK_FAILED' } }).catch(() => {})
  }
}

module.exports = { CaptionWorker, STAGE_PROGRESS, STT_DEADLINE_MS, CONCURRENCY }
