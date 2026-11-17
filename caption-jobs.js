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

function safeId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
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
    await fs.mkdir(this.dir(jobId), { recursive: true })
    const entries = await fs.readdir(this.dir(jobId)).catch(() => [])
    for (const name of entries.filter((n) => n.endsWith('.json'))) {
      const old = await this.readFile(path.join(this.dir(jobId), name))
      if (old?.idempotencyKey === key && !TERMINAL.has(old.stage)) return this.public(old)
    }
    const now = Date.now()
    const task = {
      taskId: crypto.randomUUID(), jobId, idempotencyKey: key,
      request: { instructions: String(request.instructions || '').slice(0, 1000) },
      status: 'queued', stage: 'queued', progress: 0, renderId: null,
      error: null, createdAt: now, updatedAt: now, attempts: 0,
    }
    await this.write(this.file(jobId, task.taskId), task)
    return this.public(task)
  }

  async get(jobId, taskId) {
    if (!safeId(jobId) || !safeId(taskId)) return null
    const task = await this.readFile(this.file(jobId, taskId))
    return task ? this.public(task) : null
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
    const { request, idempotencyKey, ...safe } = task
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

module.exports = { CaptionTaskStore, STAGES }
