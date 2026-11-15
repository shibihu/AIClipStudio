'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.join(__dirname, '..')
const PORT = 3800 + Math.floor(Math.random() * 150)
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'test-token'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclip-api-'))

let child
let logs = ''
let jobId = null

function ffmpeg(args) {
  execFileSync('ffmpeg', args, { stdio: 'pipe' })
}

async function waitForHealth() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`server did not start\n${logs}`)
}

function headers(extra = {}) {
  return { 'x-auth-token': TOKEN, ...extra }
}

async function postJson(pathname, body) {
  return fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  })
}

before(async () => {
  const env = {
    ...process.env,
    PORT: String(PORT),
    AUTH_TOKEN: TOKEN,
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
    GROQ_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    STT_PROVIDER: 'auto',
    JOBS_TTL_HOURS: '24',
    MAX_RENDER_QUEUE: '2',
  }
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const collect = (chunk) => { logs += chunk.toString() }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  await waitForHealth()
})

after(async () => {
  if (jobId) {
    await fetch(`${BASE}/api/job?id=${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      headers: headers(),
    }).catch(() => {})
  }
  child?.kill('SIGTERM')
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('health is public and advertises version, schema and STT capabilities', async () => {
  const r = await fetch(`${BASE}/api/health`)
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.ok, true)
  assert.equal(body.backend.name, 'ai-clip-studio')
  assert.equal(body.backend.apiSchemaVersion, 2)
  assert.match(body.backend.version, /^\d+\.\d+\.\d+/)
  assert.equal(body.capabilities.subtitlePositioning, true)
  assert.deepEqual(body.capabilities.subtitlePositions, [
    'top_center', 'center', 'bottom_center', 'top_left',
    'top_right', 'bottom_left', 'bottom_right',
  ])
  assert.equal(body.capabilities.stt.available, false)
  assert.ok(body.capabilities.stt.errorCodes.includes('STT_TIMEOUT'))
  assert.equal(body.renders.maxQueue, 2)
})

test('GET /api/version requires auth but returns the same capability contract', async () => {
  const unauth = await fetch(`${BASE}/api/version`)
  assert.equal(unauth.status, 401)

  const r = await fetch(`${BASE}/api/version`, { headers: headers() })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.apiSchemaVersion, 2)
  assert.equal(body.capabilities.sceneDetection, true)
  assert.equal(body.limits.maxRenderQueue, 2)
})

test('job routes reject malformed ids before touching the filesystem', async () => {
  const r = await fetch(`${BASE}/api/job?id=../../etc/passwd`, { headers: headers() })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error.code, 'BAD_JOB_ID')
})

test('/api/tool reports unsupported tools and unknown jobs', async () => {
  const bad = await postJson('/api/tool', { id: '00000000-0000-4000-8000-000000000000', tool: 'nope' })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error.code, 'TOOL_UNSUPPORTED')

  const unknown = await postJson('/api/tool', {
    id: '00000000-0000-4000-8000-000000000000',
    tool: 'detect_scenes',
  })
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error.code, 'UNKNOWN_JOB')
})

test('upload rejects unsupported file types', async () => {
  const form = new FormData()
  form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt')
  const r = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: headers(), body: form })
  assert.equal(r.status, 415)
  assert.equal((await r.json()).error.code, 'UPLOAD_TYPE_UNSUPPORTED')
})

test('upload accepts real video, scene detection runs, and STT errors are structured', async () => {
  const video = path.join(TMP, 'scenes.mp4')
  ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=1:r=25',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=1:r=25',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=16000',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-shortest', '-pix_fmt', 'yuv420p', video,
  ])

  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(video)], { type: 'video/mp4' }), 'scenes.mp4')
  const upload = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: headers(), body: form })
  const uploaded = await upload.json()
  assert.equal(upload.status, 200, JSON.stringify(uploaded))
  jobId = uploaded.id
  assert.match(jobId, /^[a-f0-9-]{36}$/)
  assert.equal(uploaded.meta.hasVideo, true)

  const scenes = await postJson('/api/tool', { id: jobId, tool: 'detect_scenes', args: { threshold: 0.2 } })
  const sceneBody = await scenes.json()
  assert.equal(scenes.status, 200, JSON.stringify(sceneBody))
  assert.equal(sceneBody.result.threshold, 0.2)
  assert.ok(Array.isArray(sceneBody.result.scenes))
  assert.ok(sceneBody.result.scenes.length >= 1, 'expected the red→blue cut')

  // No STT key is configured in this child process. This must be a structured
  // 503, never a silent 200 "couldn't transcribe" fallback.
  const captions = await postJson('/api/captions', { id: jobId, auto: true })
  const captionBody = await captions.json()
  assert.equal(captions.status, 503, JSON.stringify(captionBody))
  assert.equal(captionBody.error.code, 'STT_API_KEY_MISSING')
  assert.equal(captionBody.error.retryable, false)
  assert.ok(captionBody.reply)
})
