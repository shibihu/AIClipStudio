'use strict'

const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  transcribeAudio, SttError, providerChain, listSttProviders,
  validateAudioPath, looksLikeAudio, STATUS_BY_CODE,
} = require('../stt')

const ENV_KEYS = [
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY',
  'STT_PROVIDER', 'STT_FALLBACK', 'STT_MODEL',
  'GEMINI_STT_MODEL', 'OPENAI_STT_MODEL', 'GROQ_STT_MODEL',
  'GEMINI_MODEL', 'GEMINI_FALLBACK', 'STT_MAX_BYTES', 'STT_ATTEMPTS',
]
const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
})

function setEnv(values) {
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
}

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100, 1)])
const deps = (fetchImpl, extra = {}) => ({
  readFile: async () => MP3,
  sleep: async () => {},
  fetch: fetchImpl,
  ...extra,
})

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
    async text() { return JSON.stringify(body) },
  }
}

function geminiBody(cues) {
  return {
    candidates: [{
      content: { parts: [{ text: JSON.stringify({ cues }) }] },
    }],
  }
}

test('gemini: returns timestamped cues and provider metadata', async () => {
  setEnv({ GEMINI_API_KEY: 'g-test' })
  const calls = []
  const result = await transcribeAudio('/tmp/audio.mp3', {}, {}, deps(async (url, init) => {
    calls.push({ url, init })
    return jsonResponse(geminiBody([{ text: 'สวัสดีครับ', start: 0.2, end: 1.4 }]))
  }))
  assert.equal(result.provider, 'gemini')
  assert.match(result.model, /gemini/)
  assert.deepEqual(result.cues, [{ text: 'สวัสดีครับ', start: 0.2, end: 1.4 }])
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/)
  assert.ok(calls[0].init.signal)
})

test('no audio provider key is a structured error, never null', async () => {
  setEnv({ ANTHROPIC_API_KEY: 'text-only' })
  await assert.rejects(
    () => transcribeAudio('/tmp/audio.mp3', {}, {}, deps(async () => jsonResponse({}))),
    (error) => {
      assert.ok(error instanceof SttError)
      assert.equal(error.code, 'STT_API_KEY_MISSING')
      assert.equal(error.status, STATUS_BY_CODE.STT_API_KEY_MISSING)
      assert.equal(error.retryable, false)
      return true
    },
  )
})

test('text-only chat providers are never selected for audio', async () => {
  setEnv({ OPENAI_API_KEY: '' })
  assert.throws(() => {
    process.env.STT_PROVIDER = 'anthropic'
    providerChain()
  }, (error) => error.code === 'STT_PROVIDER_UNSUPPORTED')
})

test('openai: uses Whisper verbose_json segments when Gemini is absent', async () => {
  setEnv({ OPENAI_API_KEY: 'o-test' })
  let sawForm = false
  const result = await transcribeAudio('/tmp/audio.mp3', {}, {}, deps(async (url, init) => {
    assert.match(url, /api\.openai\.com\/v1\/audio\/transcriptions/)
    assert.equal(init.headers.authorization, 'Bearer o-test')
    sawForm = typeof init.body?.append === 'function'
    return jsonResponse({
      text: 'Hello world',
      segments: [{ text: ' Hello world', start: 0.1, end: 1.1 }],
    })
  }))
  assert.ok(sawForm, 'request must be multipart FormData')
  assert.equal(result.provider, 'openai')
  assert.equal(result.model, 'whisper-1')
  assert.equal(result.cues[0].text, 'Hello world')
})

test('429 is rate-limited, retried, then reported as retryable', async () => {
  // one model alias keeps the assertion focused on per-attempt retry policy
  setEnv({ GEMINI_API_KEY: 'g-test', STT_ATTEMPTS: '2', STT_MODEL: 'gemini-flash-latest' })
  let calls = 0
  await assert.rejects(
    () => transcribeAudio('/tmp/audio.mp3', {}, {}, deps(async () => {
      calls++
      return jsonResponse({ error: 'quota' }, 429)
    })),
    (error) => error.code === 'STT_RATE_LIMITED' && error.retryable === true,
  )
  assert.equal(calls, 2)
})

test('timeout is reported as STT_TIMEOUT', async () => {
  setEnv({ GEMINI_API_KEY: 'g-test', STT_ATTEMPTS: '1' })
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  await assert.rejects(
    () => transcribeAudio('/tmp/audio.mp3', {}, {}, deps(async () => { throw timeout })),
    (error) => error.code === 'STT_TIMEOUT' && error.retryable === true,
  )
})

test('transient 503 retries and can succeed', async () => {
  setEnv({ GEMINI_API_KEY: 'g-test', STT_ATTEMPTS: '2' })
  let calls = 0
  const result = await transcribeAudio('/tmp/audio.mp3', {}, {}, deps(async () => {
    calls++
    return calls === 1
      ? jsonResponse({ error: 'overloaded' }, 503)
      : jsonResponse(geminiBody([{ text: 'ok', start: 0, end: 1 }]))
  }))
  assert.equal(calls, 2)
  assert.equal(result.cues[0].text, 'ok')
})

test('gemini falls back to its lite model when the primary is unavailable', async () => {
  setEnv({ GEMINI_API_KEY: 'g-test', STT_ATTEMPTS: '1' })
  const models = []
  const result = await transcribeAudio('/tmp/audio.mp3', {}, {}, deps(async (url) => {
    const model = decodeURIComponent(url.match(/models\/([^:]+):/)[1])
    models.push(model)
    if (models.length === 1) return jsonResponse({ error: 'nope' }, 404)
    return jsonResponse(geminiBody([{ text: 'fallback', start: 0, end: 1 }]))
  }))
  assert.ok(models.length >= 2)
  assert.equal(result.model, 'gemini-flash-lite-latest')
})

test('empty cue list is STT_NO_SPEECH_DETECTED, not a provider failure', async () => {
  setEnv({ GEMINI_API_KEY: 'g-test' })
  await assert.rejects(
    () => transcribeAudio('/tmp/audio.mp3', {}, {}, deps(async () => jsonResponse(geminiBody([])))),
    (error) => {
      assert.equal(error.code, 'STT_NO_SPEECH_DETECTED')
      assert.equal(error.retryable, false)
      return true
    },
  )
})

test('malformed provider JSON is STT_INVALID_RESPONSE', async () => {
  setEnv({ GEMINI_API_KEY: 'g-test' })
  await assert.rejects(
    () => transcribeAudio('/tmp/audio.mp3', {}, {}, deps(async () => jsonResponse({
      candidates: [{ content: { parts: [{ text: 'not json at all' }] } }],
    }))),
    (error) => error.code === 'STT_INVALID_RESPONSE',
  )
})

test('oversized audio is rejected before any provider call', async () => {
  setEnv({ GEMINI_API_KEY: 'g-test' })
  let called = false
  await assert.rejects(
    () => transcribeAudio('/tmp/audio.mp3', { maxBytes: 10 }, {}, deps(async () => {
      called = true
      return jsonResponse(geminiBody([]))
    })),
    (error) => error.code === 'STT_AUDIO_TOO_LARGE',
  )
  assert.equal(called, false)
})

test('unsupported audio extension is STT_AUDIO_FORMAT_UNSUPPORTED', async () => {
  setEnv({ GEMINI_API_KEY: 'g-test' })
  await assert.rejects(
    () => transcribeAudio('/tmp/audio.txt', {}, {}, deps(async () => jsonResponse({}))),
    (error) => error.code === 'STT_AUDIO_FORMAT_UNSUPPORTED',
  )
})

test('audio validation accepts real containers and rejects text', () => {
  assert.equal(looksLikeAudio(MP3), true)
  assert.equal(looksLikeAudio(Buffer.from('RIFF....WAVE')), true)
  assert.equal(looksLikeAudio(Buffer.from('not audio')), false)
  assert.equal(validateAudioPath('a.wav', Buffer.from('RIFF....WAVE')).mime, 'audio/wav')
})

test('user subtitle instructions are forwarded to the transcript prompt', async () => {
  setEnv({ GEMINI_API_KEY: 'g-test' })
  let prompt = ''
  await transcribeAudio('/tmp/audio.mp3', {}, { instructions: 'Keep Thai spelling' }, deps(async (url, init) => {
    const body = JSON.parse(init.body)
    prompt = body.contents[0].parts.find((p) => p.text)?.text || ''
    return jsonResponse(geminiBody([{ text: 'x', start: 0, end: 1 }]))
  }))
  assert.match(prompt, /Keep Thai spelling/)
})

test('capabilities list only audio providers and expose limits', () => {
  setEnv({ OPENAI_API_KEY: 'o-test' })
  const caps = listSttProviders()
  assert.equal(caps.available, true)
  assert.equal(caps.provider, 'openai')
  assert.ok(caps.providers.some((p) => p.id === 'gemini' && p.configured === false))
  assert.ok(caps.errorCodes.includes('STT_NO_SPEECH_DETECTED'))
  assert.ok(caps.providers.every((p) => p.maxBytes > 0 && p.formats.includes('.mp3')))
})
