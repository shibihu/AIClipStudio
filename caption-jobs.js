'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const STAGES = Object.freeze([
  'queued', 'extracting_audio', 'uploading_audio', 'transcribing',
  'normalizing', 'rendering', 'completed', 'failed', 'cancelled',
])
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const TRANSITIONS = new Map([
  ['queued', new Set(['extracting_audio', 'uploading_audio', 'failed', 'cancelled'])],
  ['extracting_audio', new Set(['uploading_audio', 'transcribing', 'failed', 'cancelled'])],
  ['uploading_audio', new Set(['transcribing', 'failed', 'cancelled'])],
  ['transcribing', new Set(['normalizing', 'failed', 'cancelled'])],
  ['normalizing', new Set(['rendering', 'failed', 'cancelled'])],
  ['rendering', new Set(['completed', 'failed', 'cancelled'])],
])
// How long a claimed (leased) task keeps other workers out. A worker must
// finish or renew its claim within this window or the task becomes claimable
// again (e.g. after a crashed worker).
const LEASE_MS = Math.max(60000, Number(process.env.CAPTION_TASK_LEASE_MS) || 15 * 60000)

function safeId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

function normalizeError(error) {
  if (!error) return null
  if (typeof error === 'string') return { code: 'CAPTION_TASK_FAILED', message: error.slice(0, 500), retryable: false }
  return {
    code: String(error.code || 'CAPTION_TASK_FAILED').slice(0, 64),
    message: String(error.message || 'The caption task failed.').slice(0, 500),
    retryable: error.retryable === true,
    ...(error.stage ? { stage: String(error.stage).slice(0, 32) } : {}),
  }
}

class CaptionTaskStore {
  constructor(root) {
    this.root = root
    this.locks = new Map()
  }

  dir(jobId) { return path.join(this.root, jobId, 'caption-tasks') }
  file(jobId, taskId) { return path.join(this.dir(jobId), `${taskId}.json`) }

  async create(jobId, request = {}) {
    if (!safeId(jobId)) throw new Error('invalid job id')
    const key = String(request.idempotencyKey || '').slice(0, 128)
    if (!key) throw new Error('idempotency key is required')
    // Serialize creation per job: two concurrent submissions with one
    // idempotency key must produce exactly one task.
    return this.withLock(`create:${jobId}`, () => this.createLocked(jobId, key, request))
  }

  async createLocked(jobId, key, request = {}) {
    await fs.mkdir(this.dir(jobId), { recursive: true })
    const entries = await fs.readdir(this.dir(jobId)).catch(() => [])
    for (const name of entries.filter((n) => n.endsWith('.json'))) {
      const old = await this.readFile(path.join(this.dir(jobId), name))
      if (old?.idempotencyKey === key && !TERMINAL.has(old.stage)) return this.public(old)
    }
    const now = Date.now()
    const task = {
      taskId: crypto.randomUUID(), jobId, idempotencyKey: key,
      request: {
        instructions: String(request.instructions || '').slice(0, 1000),
        // worker execution options resolved at submission time: source file,
        // caption layout, mode and STT prompt context.
        ...(request.options ? { options: request.options } : {}),
      },
      status: 'queued', stage: 'queued', progress: 0, renderId: null,
      error: null, createdAt: now, updatedAt: now, attempts: 0,
      // observability: durations, sizes and provider facts per stage
      metrics: {},
      // intermediate artifacts persisted so recovery can resume without
      // repeating paid work (extracted audio file, normalized cues)
      artifacts: {},
      // lease bookkeeping: which worker run owns this task right now
      runToken: null, lockedAt: null,
    }
    await this.write(this.file(jobId, task.taskId), task)
    return this.public(task)
  }

  async get(jobId, taskId) {
    if (!safeId(jobId) || !safeId(taskId)) return null
    const task = await this.readFile(this.file(jobId, taskId))
    return task ? this.public(task) : null
  }

  /** Full persisted task (incl. artifacts/lease) for worker-internal merges. */
  async getRaw(jobId, taskId) {
    if (!safeId(jobId) || !safeId(taskId)) return null
    return this.readFile(this.file(jobId, taskId))
  }

  async update(jobId, taskId, patch) {
    return this.withLock(taskId, async () => {
      const file = this.file(jobId, taskId)
      const task = await this.readFile(file)
      if (!task) throw new Error('task not found')
      const nextStage = patch.stage || task.stage
      if (TERMINAL.has(task.stage)) throw new Error('task is terminal')
      if (nextStage !== task.stage && !TRANSITIONS.get(task.stage)?.has(nextStage)) throw new Error(`invalid task transition: ${task.stage} -> ${nextStage}`)
      Object.assign(task, patch, { stage: nextStage, status: patch.status || (TERMINAL.has(nextStage) ? nextStage : 'running'), updatedAt: Date.now() })
      await this.write(file, task)
      return this.public(task)
    })
  }

  /**
   * Claim a task for a worker run. Returns the full task when the caller owns
   * it, or null when it is terminal, leased by another run, or missing.
   */
  async claim(jobId, taskId, runToken) {
    if (!safeId(jobId) || !safeId(taskId) || !safeId(runToken)) return null
    return this.withLock(taskId, async () => {
      const task = await this.readFile(this.file(jobId, taskId))
      if (!task || TERMINAL.has(task.stage)) return null
      const leased = task.lockedAt && (Date.now() - task.lockedAt) < LEASE_MS
      if (leased && task.runToken !== runToken) return null
      task.runToken = runToken
      task.lockedAt = Date.now()
      task.attempts = (task.attempts || 0) + 1
      await this.write(this.file(jobId, taskId), task)
      return task
    })
  }

  /** Renew (or clear) the lease of a claimed task without touching its stage. */
  async heartbeat(jobId, taskId, runToken, { release = false } = {}) {
    return this.withLock(taskId, async () => {
      const task = await this.readFile(this.file(jobId, taskId))
      if (!task || task.runToken !== runToken) return null
      task.lockedAt = release ? null : Date.now()
      if (release) task.runToken = null
      await this.write(this.file(jobId, taskId), task)
      return task
    })
  }

  /**
   * Recovery after a restart: put an interrupted task back into the queue.
   * Bypasses the forward-only transition map because the pipeline restarts
   * from a known-idempotent stage. Terminal tasks are never touched.
   */
  async recover(jobId, taskId, { stage = 'queued' } = {}) {
    if (!safeId(jobId) || !safeId(taskId)) return null
    return this.withLock(taskId, async () => {
      const file = this.file(jobId, taskId)
      const task = await this.readFile(file)
      if (!task || TERMINAL.has(task.stage)) return this.public(task)
      task.stage = STAGES.includes(stage) && !TERMINAL.has(stage) ? stage : 'queued'
      task.status = 'queued'
      task.progress = 0
      task.error = null
      task.runToken = null
      task.lockedAt = null
      task.updatedAt = Date.now()
      await this.write(file, task)
      return this.public(task)
    })
  }

  /** Mark a task failed with a structured, client-safe error payload. */
  async fail(jobId, taskId, error, { metrics = {} } = {}) {
    return this.update(jobId, taskId, {
      stage: 'failed', status: 'failed',
      error: normalizeError(error),
      metrics: { ...(metrics || {}) },
    })
  }

  async cancel(jobId, taskId) {
    const current = await this.get(jobId, taskId)
    if (!current) throw new Error('task not found')
    if (TERMINAL.has(current.stage)) return current
    return this.update(jobId, taskId, { stage: 'cancelled', status: 'cancelled', progress: current.progress })
  }

  async listRecoverable(jobId) {
    const entries = await fs.readdir(this.dir(jobId)).catch(() => [])
    const tasks = []
    for (const name of entries.filter((n) => n.endsWith('.json'))) {
      const task = await this.readFile(path.join(this.dir(jobId), name))
      if (task && !TERMINAL.has(task.stage)) tasks.push(this.public(task))
    }
    return tasks
  }

  public(task) {
    const { request, idempotencyKey, runToken, lockedAt, artifacts, ...safe } = task
    return { ...safe, error: safe.error || null }
  }
  async readFile(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null } }
  async write(file, value) {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 })
    await fs.rename(temp, file)
  }
  async withLock(key, fn) {
    const previous = this.locks.get(key) || Promise.resolve()
    const current = previous.then(fn, fn)
    this.locks.set(key, current.catch(() => {}).then(() => {
      if (this.locks.get(key) === current) this.locks.delete(key)
    }))
    return current
  }
}

module.exports = { CaptionTaskStore, STAGES, TERMINAL, TRANSITIONS, LEASE_MS }
