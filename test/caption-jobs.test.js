'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { CaptionTaskStore } = require('../caption-jobs')

test('caption task store persists, deduplicates, and exposes a safe public shape', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-tasks-'))
  const store = new CaptionTaskStore(root)
  const first = await store.create('job-1', { idempotencyKey: 'same', instructions: 'Thai' })
  const duplicate = await store.create('job-1', { idempotencyKey: 'same', instructions: 'Thai' })

  assert.equal(duplicate.taskId, first.taskId)
  assert.equal(first.status, 'queued')
  assert.equal(first.stage, 'queued')
  assert.equal(first.progress, 0)
  assert.equal(first.error, null)
  assert.equal((await store.get('job-1', first.taskId)).request, undefined)

  await store.update('job-1', first.taskId, { stage: 'extracting_audio' })
  const updated = await store.update('job-1', first.taskId, { stage: 'transcribing', progress: 42 })
  assert.equal(updated.stage, 'transcribing')
  assert.equal(updated.progress, 42)
  assert.equal((await store.listRecoverable('job-1')).length, 1)
})

test('caption task store prevents completion after cancellation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-tasks-'))
  const store = new CaptionTaskStore(root)
  const task = await store.create('job-1', { idempotencyKey: 'cancel-me' })
  await store.update('job-1', task.taskId, { stage: 'extracting_audio' })
  await store.update('job-1', task.taskId, { stage: 'transcribing' })
  const cancelled = await store.cancel('job-1', task.taskId)
  assert.equal(cancelled.status, 'cancelled')
  await assert.rejects(store.update('job-1', task.taskId, { stage: 'completed', status: 'completed' }), /terminal/)
})

test('claim leases a task once: a second worker run cannot take it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-tasks-'))
  const store = new CaptionTaskStore(root)
  const task = await store.create('job-1', { idempotencyKey: 'k1' })

  const first = await store.claim('job-1', task.taskId, 'run-a')
  assert.equal(first.runToken, 'run-a')
  assert.equal(first.attempts, 1)

  const second = await store.claim('job-1', task.taskId, 'run-b')
  assert.equal(second, null, 'a leased task must not be claimable by another run')

  // the owner can re-claim (idempotent heartbeat style) and release
  const again = await store.claim('job-1', task.taskId, 'run-a')
  assert.equal(again.attempts, 2)
  await store.heartbeat('job-1', task.taskId, 'run-a', { release: true })
  const freed = await store.claim('job-1', task.taskId, 'run-b')
  assert.equal(freed.runToken, 'run-b')
})

test('expired leases are claimable again so a crashed worker cannot strand a task', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-tasks-'))
  const store = new CaptionTaskStore(root)
  const task = await store.create('job-1', { idempotencyKey: 'k1' })
  await store.claim('job-1', task.taskId, 'run-a')
  // simulate an old lease
  const file = store.file('job-1', task.taskId)
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  raw.lockedAt = Date.now() - 60 * 60 * 1000
  await fs.writeFile(file, JSON.stringify(raw))
  const stolen = await store.claim('job-1', task.taskId, 'run-b')
  assert.equal(stolen.runToken, 'run-b')
})

test('recover requeues an interrupted task and never touches terminal tasks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-tasks-'))
  const store = new CaptionTaskStore(root)
  const task = await store.create('job-1', { idempotencyKey: 'k1' })
  await store.update('job-1', task.taskId, { stage: 'extracting_audio' })
  await store.update('job-1', task.taskId, { stage: 'transcribing', progress: 42 })
  const recovered = await store.recover('job-1', task.taskId, { stage: 'queued' })
  assert.equal(recovered.stage, 'queued')
  assert.equal(recovered.status, 'queued')
  assert.equal(recovered.progress, 0)
  assert.equal(recovered.error, null)
  assert.ok(!recovered.runToken, 'recovered task must not keep a stale lease')

  await store.update('job-1', task.taskId, { stage: 'extracting_audio' })
  await store.update('job-1', task.taskId, { stage: 'transcribing' })
  await store.fail('job-1', task.taskId, { code: 'NO_AUDIO', message: 'no audio', retryable: false })
  const untouched = await store.recover('job-1', task.taskId, { stage: 'queued' })
  assert.equal(untouched.stage, 'failed', 'terminal tasks must stay terminal')
})

test('fail persists a structured, client-safe error payload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-tasks-'))
  const store = new CaptionTaskStore(root)
  const task = await store.create('job-1', { idempotencyKey: 'k1' })
  await store.update('job-1', task.taskId, { stage: 'extracting_audio' })
  await store.update('job-1', task.taskId, { stage: 'transcribing' })
  const failed = await store.fail('job-1', task.taskId, { code: 'STT_TIMEOUT', message: 'too slow', retryable: true })
  assert.equal(failed.stage, 'failed')
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.error, { code: 'STT_TIMEOUT', message: 'too slow', retryable: true })
  const fetched = await store.get('job-1', task.taskId)
  assert.equal(fetched.error.code, 'STT_TIMEOUT')
})

test('create persists worker options and concurrent idempotent submissions deduplicate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caption-tasks-'))
  const store = new CaptionTaskStore(root)
  const request = { idempotencyKey: 'same-key', instructions: 'Thai', options: { srcName: 'input.mp4' } }
  const [a, b] = await Promise.all([
    store.create('job-1', request),
    store.create('job-1', request),
  ])
  assert.equal(a.taskId, b.taskId, 'concurrent submissions with one key must yield one task')
})
