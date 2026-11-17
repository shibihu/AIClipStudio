'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

process.env.CAPTION_WORKER_CONCURRENCY = '2'

const { CaptionTaskStore } = require('../caption-jobs')
const { CaptionWorker } = require('../caption-worker')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeDeps(overrides = {}) {
  const calls = { extract: 0, transcribe: 0, normalize: 0, enqueue: 0, waitFor: 0, buildRender: 0 }
  const deps = {
    store: null,
    jobsDir: null,
    ffmpeg: '/bin/true',
    probe: async () => ({ duration: 10, width: 640, height: 360, hasVideo: true, hasAudio: true, fps: 30 }),
    transcribeAudio: async (audioPath, options, extra, d) => {
      calls.transcribe++
      if (overrides.transcribeDelay) await sleep(overrides.transcribeDelay)
      if (d?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      return {
        cues: [{ text: 'สวัสดี', start: 0.1, end: 1.0 }],
        provider: 'gemini', model: 'gemini-flash-latest',
        rawCueCount: 1, attempts: 1, durationMs: 12,
      }
    },
    SttError: class SttError extends Error {
      constructor(code, message) { super(message); this.code = code }
    },
    normalizeTranscriptCues: (cues) => {
      calls.normalize++
      return cues.map((c, i) => ({ ...c, index: i }))
    },
    detectBurnedInSubtitles: async () => ({ found: false, skipped: true, reason: 'x' }),
    buildObscureGraph: () => null,
    buildCaptionRender: () => {
      calls.buildRender++
      return {
        frag: { desc: ['captions'], facts: {}, verify: null },
        summary: 'Placing 1 caption',
        facts: {}, verify: null,
      }
    },
    enqueueCaptionRender: async () => {
      calls.enqueue++
      return { rid: overrides.rid || 'rid-1' }
    },
    waitForRender: async (rid, { onProgress } = {}) => {
      calls.waitFor++
      onProgress?.(50)
      await sleep(overrides.renderDelay ?? 10)
      return overrides.renderResult || { status: 'done', media: { url: `/media/j/out-1.mp4` } }
    },
    killRender: () => {},
    ...overrides.deps,
  }
  return { deps, calls }
}

async function makeTask(store, worker, { audioExists = true } = {}) {
  const task = await store.create('job-1', {
    idempotencyKey: `key-${Math.random()}`,
    instructions: 'Thai captions',
    options: {
      srcName: 'input.mp4',
      mode: 'add',
      layout: { position: 'bottom_center', style: { fontSize: 24 }, maxChars: 30, maxLines: 2, layer: null },
      meta: { duration: 10, hasAudio: true, hasVideo: true },
    },
  })
  await fs.mkdir(path.join(store.root, 'job-1'), { recursive: true })
  // the source media file must exist or the worker fails the task safely
  await fs.writeFile(path.join(store.root, 'job-1', 'input.mp4'), Buffer.alloc(16))
  if (audioExists) {
    // pretend a previous run already extracted the audio artifact
    await fs.writeFile(path.join(store.root, 'job-1', `caption-audio-${task.taskId}.mp3`), Buffer.alloc(10))
  }
  worker.submit(task)
  return task
}

async function waitForStage(store, taskId, stage, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = await store.get('job-1', taskId)
    if (!task) throw new Error('task vanished')
    if (['completed', 'failed', 'cancelled'].includes(task.stage) || task.stage === stage) return task
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${stage}; last=${task.stage}`)
    await sleep(20)
  }
}

test('worker runs a task end-to-end: stages, metrics, completion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-worker-'))
  const store = new CaptionTaskStore(root)
  const { deps, calls } = makeDeps({ deps: { store, jobsDir: root } })
  const worker = new CaptionWorker(deps)
  const task = await makeTask(store, worker, { audioExists: false })

  const finished = await waitForStage(store, task.taskId, 'completed')
  assert.equal(finished.stage, 'completed')
  assert.equal(finished.status, 'completed')
  assert.equal(finished.progress, 100)
  assert.equal(finished.renderId, 'rid-1')
  assert.equal(finished.error, null)
  assert.equal(calls.transcribe, 1)
  assert.equal(calls.enqueue, 1)
  assert.equal(finished.metrics.stt.provider, 'gemini')
  assert.equal(finished.metrics.stt.attempts, 1)
  assert.ok(finished.metrics.renderMs >= 0)
  assert.ok(finished.metrics.audioBytes >= 0)
  // temp audio cleaned up on completion
  await assert.rejects(fs.access(path.join(root, 'job-1', `caption-audio-${task.taskId}.mp3`)))
})

test('duplicate submissions do not create duplicate processing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-worker-'))
  const store = new CaptionTaskStore(root)
  const { deps, calls } = makeDeps({ transcribeDelay: 120, deps: { store, jobsDir: root } })
  const worker = new CaptionWorker(deps)
  const task = await store.create('job-1', {
    idempotencyKey: 'dup-key',
    options: { srcName: 'input.mp4', mode: 'add', layout: {}, meta: { duration: 10, hasAudio: true } },
  })
  await fs.mkdir(path.join(root, 'job-1'), { recursive: true })
  await fs.writeFile(path.join(root, 'job-1', 'input.mp4'), Buffer.alloc(16))
  assert.equal(worker.submit(task), true)
  assert.equal(worker.submit({ ...task, taskId: task.taskId }), false, 'same task must not be queued twice')
  await waitForStage(store, task.taskId, 'completed')
  assert.equal(calls.transcribe, 1)
})

test('worker concurrency is bounded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-worker-'))
  const store = new CaptionTaskStore(root)
  let concurrent = 0
  let peak = 0
  const { deps } = makeDeps({
    transcribeDelay: 80,
    deps: {
      store, jobsDir: root,
      transcribeAudio: async (f, o, e, d) => {
        concurrent++
        peak = Math.max(peak, concurrent)
        await sleep(80)
        concurrent--
        if (d?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        return { cues: [{ text: 'x', start: 0, end: 1 }], provider: 'gemini', model: 'm', rawCueCount: 1, attempts: 1, durationMs: 1 }
      },
    },
  })
  const worker = new CaptionWorker(deps)
  assert.equal(worker.concurrency, 2)
  const tasks = []
  for (let i = 0; i < 4; i++) tasks.push(await makeTask(store, worker))
  await Promise.all(tasks.map((t) => waitForStage(store, t.taskId, 'completed', 15000)))
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the bound`)
})

test('cancellation during transcription aborts the provider call and cancels the task', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-worker-'))
  const store = new CaptionTaskStore(root)
  const { deps, calls } = makeDeps({
    deps: {
      store, jobsDir: root,
      transcribeAudio: async (f, o, e, d) => {
        calls.transcribe++
        // resolve only when the worker aborts us; never return cues
        await new Promise((resolve, reject) => {
          if (d?.signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          d?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
      },
    },
  })
  const worker = new CaptionWorker(deps)
  const task = await makeTask(store, worker, { audioExists: false })
  await waitForStage(store, task.taskId, 'transcribing')
  assert.ok(calls.transcribe <= 1, 'the provider call must have started or been aborted before starting')
  worker.cancel(task.taskId)
  await store.cancel('job-1', task.taskId)
  const final = await waitForStage(store, task.taskId, 'cancelled')
  assert.equal(final.stage, 'cancelled')
  assert.equal(final.status, 'cancelled')
  await sleep(80)
  const still = await store.get('job-1', task.taskId)
  assert.equal(still.stage, 'cancelled', 'a cancelled task must never advance to another stage')
  assert.notEqual(still.stage, 'failed')
})

test('missing source media fails the task safely', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-worker-'))
  const store = new CaptionTaskStore(root)
  const { deps } = makeDeps({ deps: { store, jobsDir: root } })
  const worker = new CaptionWorker(deps)
  const task = await store.create('job-1', {
    idempotencyKey: 'gone',
    options: { srcName: 'input.mp4', mode: 'add', layout: {}, meta: { duration: 10, hasAudio: true } },
  })
  worker.submit(task)
  const finished = await waitForStage(store, task.taskId, 'failed')
  assert.equal(finished.error.code, 'CAPTION_SOURCE_MISSING')
  assert.equal(finished.stage, 'failed')
})

test('render failure after successful transcription fails the task, never completes it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-worker-'))
  const store = new CaptionTaskStore(root)
  const { deps, calls } = makeDeps({ renderResult: { status: 'failed', reply: 'boom' }, deps: { store, jobsDir: root } })
  const worker = new CaptionWorker(deps)
  const task = await makeTask(store, worker)
  const finished = await waitForStage(store, task.taskId, 'failed')
  assert.equal(finished.error.code, 'RENDER_FAILED')
  assert.equal(finished.stage, 'failed')
  assert.equal(calls.transcribe, 1)
})

test('restart recovery resumes from persisted artifacts without re-running STT', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-worker-'))
  const store = new CaptionTaskStore(root)
  const { deps, calls } = makeDeps({ deps: { store, jobsDir: root } })
  const worker = new CaptionWorker(deps)
  const task = await makeTask(store, worker, { audioExists: false })
  await waitForStage(store, task.taskId, 'completed')
  assert.equal(calls.transcribe, 1)

  // simulate a restart: same store artifacts, fresh worker, task requeued
  await store.recover('job-1', task.taskId, { stage: 'queued' })
  const { deps: deps2, calls: calls2 } = makeDeps({ deps: { store, jobsDir: root } })
  const worker2 = new CaptionWorker(deps2)
  const fresh = await store.get('job-1', task.taskId)
  worker2.submit(fresh)
  await waitForStage(store, task.taskId, 'completed', 15000)
  // audio artifact file was cleaned on completion, so extraction runs again,
  // but the persisted cues mean the provider is never called twice.
  assert.equal(calls2.transcribe, 0, 'persisted cues must skip the paid STT call')
})

test('cancellation during rendering stops the render FFmpeg and cancels the task', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-worker-'))
  const store = new CaptionTaskStore(root)
  let killed = null
  const { deps } = makeDeps({
    deps: {
      store, jobsDir: root,
      waitForRender: (rid, { signal } = {}) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('cancelled'))
        signal?.addEventListener('abort', () => reject(new Error('cancelled')))
      }),
      killRender: (rid) => { killed = rid },
    },
  })
  const worker = new CaptionWorker(deps)
  const task = await makeTask(store, worker)
  await waitForStage(store, task.taskId, 'rendering')
  await sleep(150) // let the render enqueue finish so the rid is known
  worker.cancel(task.taskId)
  await store.cancel('job-1', task.taskId)
  const final = await waitForStage(store, task.taskId, 'cancelled')
  assert.equal(final.stage, 'cancelled')
  assert.equal(killed, 'rid-1', 'the render process must be killed on cancel')
})

test('provider fallback within deadline is recorded in task metrics', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-worker-'))
  const store = new CaptionTaskStore(root)
  const { deps } = makeDeps({
    deps: {
      store, jobsDir: root,
      transcribeAudio: async () => ({
        cues: [{ text: 'fallback', start: 0, end: 1 }],
        provider: 'openai', model: 'whisper-1',
        rawCueCount: 1, attempts: 3, durationMs: 4200,
      }),
    },
  })
  const worker = new CaptionWorker(deps)
  const task = await makeTask(store, worker)
  const finished = await waitForStage(store, task.taskId, 'completed')
  assert.equal(finished.metrics.stt.provider, 'openai')
  assert.equal(finished.metrics.stt.attempts, 3)
  assert.equal(finished.metrics.stt.durationMs, 4200)
})
