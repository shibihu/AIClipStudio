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
