'use strict'

// ---------------------------------------------------------------------------
// stt.js — speech-to-text provider adapters.
//
// Speech-to-text is deliberately separate from the chat LLM providers in ai.js:
// a text-only chat model must never be treated as an audio transcriber. Each
// adapter declares the audio formats and byte limits it supports and returns
// timestamped cues. Failures are structured SttError instances, never `null`,
// so the HTTP layer can distinguish "no speech" from "provider broken".
// ---------------------------------------------------------------------------

const fs = require('fs')
const path = require('path')

const MB = 1024 * 1024
const STT_TIMEOUT_MS = Math.max(1000, Number(process.env.STT_TIMEOUT_MS) || 60000)
const STT_ATTEMPTS = Math.max(1, Math.min(4, Number(process.env.STT_ATTEMPTS) || 2))
const STT_RETRY_BASE_MS = Math.max(0, Number(process.env.STT_RETRY_BASE_MS) || 800)

const STT_ERROR_CODES = Object.freeze([
  'STT_PROVIDER_UNSUPPORTED',
  'STT_API_KEY_MISSING',
  'STT_PROVIDER_UNREACHABLE',
  'STT_RATE_LIMITED',
  'STT_TIMEOUT',
  'STT_AUDIO_TOO_LARGE',
  'STT_AUDIO_FORMAT_UNSUPPORTED',
  'STT_NO_SPEECH_DETECTED',
  'STT_INVALID_RESPONSE',
  'STT_EMPTY_TRANSCRIPT',
])

const STATUS_BY_CODE = Object.freeze({
  STT_PROVIDER_UNSUPPORTED: 400,
  STT_API_KEY_MISSING: 503,
  STT_PROVIDER_UNREACHABLE: 502,
  STT_RATE_LIMITED: 429,
  STT_TIMEOUT: 504,
  STT_AUDIO_TOO_LARGE: 413,
  STT_AUDIO_FORMAT_UNSUPPORTED: 415,
  STT_NO_SPEECH_DETECTED: 422,
  STT_INVALID_RESPONSE: 502,
  STT_EMPTY_TRANSCRIPT: 422,
})

const RETRYABLE_BY_CODE = Object.freeze({
  STT_PROVIDER_UNREACHABLE: true,
  STT_RATE_LIMITED: true,
  STT_TIMEOUT: true,
})

class SttError extends Error {
  constructor(code, message, { provider = null, model = null, status = null, cause = null } = {}) {
    super(message)
    this.name = 'SttError'
    this.code = STATUS_BY_CODE[code] ? code : 'STT_PROVIDER_UNREACHABLE'
    this.provider = provider
    this.model = model
    this.status = status || STATUS_BY_CODE[this.code]
    this.retryable = RETRYABLE_BY_CODE[this.code] === true
    this.cause = cause || null
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.model ? { model: this.model } : {}),
    }
  }
}

const AUDIO_FORMATS = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
})

function formatOf(file) {
  const ext = path.extname(file || '').toLowerCase()
  return { ext, mime: AUDIO_FORMATS[ext] || null }
}

// Small magic-byte sanity check. We only reject a file when it is clearly not
// audio; unknown containers are left to the provider/ffprobe rather than being
// refused by a too-strict local matcher.
function looksLikeAudio(buf) {
  if (!buf || buf.length < 4) return false
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return true // MP3 with ID3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true // MPEG audio frame
  if (buf.slice(0, 4).toString('latin1') === 'RIFF') return true // WAV/AVI
  if (buf.slice(0, 4).toString('latin1') === 'OggS') return true // Ogg
  if (buf.slice(0, 4).toString('latin1') === 'fLaC') return true // FLAC
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return true // MP4/M4A
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true // WebM
  if (buf.slice(0, 2).toString('latin1') === 'FORM') return true // AIFF
  return false
}

function providerKey(id) {
  switch (id) {
    case 'gemini': return String(process.env.GEMINI_API_KEY || '').trim()
    case 'openai': return String(process.env.OPENAI_API_KEY || '').trim()
    case 'groq': return String(process.env.GROQ_API_KEY || '').trim()
    default: return ''
  }
}

function customModel(id) {
  if (process.env.STT_MODEL) return String(process.env.STT_MODEL).trim()
  if (id === 'gemini') return String(process.env.GEMINI_STT_MODEL || '').trim()
  if (id === 'openai') return String(process.env.OPENAI_STT_MODEL || '').trim()
  if (id === 'groq') return String(process.env.GROQ_STT_MODEL || '').trim()
  return ''
}

function geminiModels() {
  const custom = customModel('gemini')
  if (custom) return [custom]
  const primary = String(process.env.GEMINI_MODEL || 'gemini-flash-latest').trim()
  const fallback = String(process.env.GEMINI_FALLBACK || 'gemini-flash-lite-latest').trim()
  return primary === fallback ? [primary] : [primary, fallback]
}

const PROVIDERS = Object.freeze({
  gemini: {
    id: 'gemini',
    label: 'Google Gemini audio',
    key: () => providerKey('gemini'),
    models: geminiModels,
    maxBytes: Math.min(Number(process.env.STT_MAX_BYTES) || 20 * MB, 20 * MB),
    formats: ['.mp3', '.wav', '.m4a', '.mp4', '.ogg', '.flac', '.aac', '.aiff', '.webm'],
    async transcribe({ buf, ext, mime, model, prompt, key, deps }) {
      const fetchImpl = deps.fetch || globalThis.fetch
      const r = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(deps.timeoutMs || STT_TIMEOUT_MS),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              role: 'user',
              parts: [{ text: 'You transcribe audio and answer ONLY with the JSON object.' }],
            },
            contents: [{
              role: 'user',
              parts: [
                { inline_data: { mime_type: mime, data: buf.toString('base64') } },
                { text: prompt },
              ],
            }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
          }),
        },
      )
      if (!r.ok) throw httpError(r.status, 'gemini', model)
      const json = await r.json()
      if (json?.promptFeedback?.blockReason) {
        throw new SttError('STT_PROVIDER_UNSUPPORTED', 'The speech provider refused this audio (content policy).', { provider: 'gemini', model })
      }
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
      return { text, cues: parseJsonCues(text, 'gemini', model) }
    },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI Whisper',
    key: () => providerKey('openai'),
    models: () => [customModel('openai') || 'whisper-1'],
    maxBytes: Math.min(Number(process.env.STT_MAX_BYTES) || 25 * MB, 25 * MB),
    formats: ['.mp3', '.mpga', '.m4a', '.mp4', '.wav', '.webm'],
    async transcribe({ buf, ext, mime, model, prompt, key, deps }) {
      const fetchImpl = deps.fetch || globalThis.fetch
      const form = new FormData()
      form.append('file', new Blob([buf], { type: mime }), `audio${ext || '.mp3'}`)
      form.append('model', model)
      form.append('response_format', 'verbose_json')
      form.append('temperature', '0')
      if (prompt) form.append('prompt', prompt)
      const r = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        signal: AbortSignal.timeout(deps.timeoutMs || STT_TIMEOUT_MS),
        headers: { authorization: `Bearer ${key}` },
        body: form,
      })
      if (!r.ok) throw httpError(r.status, 'openai', model)
      const json = await r.json()
      const cues = Array.isArray(json.segments)
        ? json.segments.map((s) => ({ text: String(s.text || '').trim(), start: s.start, end: s.end }))
        : []
      if (!cues.length && String(json.text || '').trim()) {
        throw new SttError('STT_INVALID_RESPONSE', 'The speech provider returned text without timestamps.', { provider: 'openai', model })
      }
      return { text: String(json.text || ''), cues }
    },
  },
  groq: {
    id: 'groq',
    label: 'Groq Whisper',
    key: () => providerKey('groq'),
    models: () => [customModel('groq') || String(process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo')],
    maxBytes: Math.min(Number(process.env.STT_MAX_BYTES) || 25 * MB, 25 * MB),
    formats: ['.mp3', '.mpga', '.m4a', '.mp4', '.wav', '.webm'],
    async transcribe({ buf, ext, mime, model, prompt, key, deps }) {
      const fetchImpl = deps.fetch || globalThis.fetch
      const form = new FormData()
      form.append('file', new Blob([buf], { type: mime }), `audio${ext || '.mp3'}`)
      form.append('model', model)
      form.append('response_format', 'verbose_json')
      form.append('temperature', '0')
      if (prompt) form.append('prompt', prompt)
      const r = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        signal: AbortSignal.timeout(deps.timeoutMs || STT_TIMEOUT_MS),
        headers: { authorization: `Bearer ${key}` },
        body: form,
      })
      if (!r.ok) throw httpError(r.status, 'groq', model)
      const json = await r.json()
      const cues = Array.isArray(json.segments)
        ? json.segments.map((s) => ({ text: String(s.text || '').trim(), start: s.start, end: s.end }))
        : []
      if (!cues.length && String(json.text || '').trim()) {
        throw new SttError('STT_INVALID_RESPONSE', 'The speech provider returned text without timestamps.', { provider: 'groq', model })
      }
      return { text: String(json.text || ''), cues }
    },
  },
})

function httpError(status, provider, model) {
  if (status === 429) {
    return new SttError('STT_RATE_LIMITED', 'The speech service is rate limited. Try again in a moment.', { provider, model, status })
  }
  if (status === 401 || status === 403) {
    return new SttError('STT_API_KEY_MISSING', 'The configured speech provider key was rejected.', { provider, model, status })
  }
  if (status === 408 || status === 504) {
    return new SttError('STT_TIMEOUT', 'The speech service took too long to respond.', { provider, model, status })
  }
  if (status === 413) {
    return new SttError('STT_AUDIO_TOO_LARGE', 'The audio file is too large for the speech provider.', { provider, model, status })
  }
  if (status === 415) {
    return new SttError('STT_AUDIO_FORMAT_UNSUPPORTED', 'The speech provider does not accept this audio format.', { provider, model, status })
  }
  if (status === 404 || status === 400) {
    return new SttError('STT_PROVIDER_UNSUPPORTED', 'The configured speech provider or model is not available.', { provider, model, status })
  }
  return new SttError('STT_PROVIDER_UNREACHABLE', 'The speech service is unreachable right now.', { provider, model, status })
}

function parseJsonCues(raw, provider, model) {
  const text = String(raw || '').trim()
  if (!text) return []
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim()
  const a = cleaned.indexOf('{')
  const b = cleaned.lastIndexOf('}')
  let parsed
  try {
    parsed = JSON.parse(a !== -1 && b > a ? cleaned.slice(a, b + 1) : cleaned)
  } catch {
    throw new SttError('STT_INVALID_RESPONSE', 'The speech provider returned an unreadable response.', { provider, model })
  }
  const rawCues = Array.isArray(parsed?.cues) ? parsed.cues : Array.isArray(parsed) ? parsed : null
  if (!rawCues) {
    throw new SttError('STT_INVALID_RESPONSE', 'The speech provider returned no caption list.', { provider, model })
  }
  const cues = []
  for (const cue of rawCues) {
    const cueText = String(cue?.text || '').replace(/\s+/g, ' ').trim()
    const start = Number(cue?.start)
    const end = Number(cue?.end)
    if (!cueText || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    cues.push({ text: cueText, start: Math.max(0, start), end })
  }
  if (rawCues.length > 0 && cues.length === 0) {
    throw new SttError('STT_INVALID_RESPONSE', 'The speech provider returned malformed caption timings.', { provider, model })
  }
  return cues
}

function providerChain() {
  const requested = String(process.env.STT_PROVIDER || 'auto').trim().toLowerCase()
  if (requested && requested !== 'auto' && !PROVIDERS[requested]) {
    throw new SttError('STT_PROVIDER_UNSUPPORTED',
      `STT_PROVIDER="${requested}" is not an audio-capable provider. Use gemini, openai, groq or auto.`,
      { provider: requested })
  }
  const fallback = String(process.env.STT_FALLBACK || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((id) => id !== requested)
  const ordered = requested && requested !== 'auto'
    ? [requested, ...fallback]
    : ['gemini', 'openai', 'groq', ...fallback]
  const seen = new Set()
  return ordered.filter((id) => {
    if (seen.has(id) || !PROVIDERS[id]) return false
    seen.add(id)
    return true
  })
}

function listSttProviders() {
  const configured = Object.values(PROVIDERS).filter((p) => p.key())
  return {
    available: configured.length > 0,
    provider: configured[0]?.id || null,
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      configured: !!p.key(),
      models: p.models(),
      maxBytes: p.maxBytes,
      formats: p.formats,
    })),
    errorCodes: STT_ERROR_CODES,
    timeoutMs: STT_TIMEOUT_MS,
  }
}

function validateAudioPath(file, buf) {
  const { ext, mime } = formatOf(file)
  if (!mime) {
    throw new SttError('STT_AUDIO_FORMAT_UNSUPPORTED',
      `Unsupported audio format "${ext || 'unknown'}". Use mp3, wav, m4a, mp4, webm, ogg, flac, aac or aiff.`)
  }
  if (!buf.length) {
    throw new SttError('STT_EMPTY_TRANSCRIPT', 'The extracted audio file is empty.')
  }
  if (!looksLikeAudio(buf)) {
    throw new SttError('STT_AUDIO_FORMAT_UNSUPPORTED', 'The extracted audio file is not a recognized audio container.')
  }
  return { ext, mime }
}

const STT_PROMPT = `You are a captioning engine. Transcribe ALL spoken words in this audio.
Return ONLY JSON (no markdown, no commentary): {"cues":[{"text":"...","start":0.0,"end":1.2}]}
Rules:
- start/end are numbers in seconds, relative to the audio start.
- One cue per natural caption: break at sentence ends or natural pauses, max ~12 words per cue.
- text contains only the spoken words (no speaker labels, no timestamps inside the text).
- Keep the original language. If there is no speech, return {"cues":[]}.
- Never translate unless the user explicitly asks for translation.`

/**
 * Transcribe an audio file with the first configured audio-capable provider.
 *
 * @param {string} audioPath
 * @param {{maxBytes?:number}} [options]
 * @param {{instructions?:string}} [extra]
 * @param {{fetch?:Function, readFile?:Function, timeoutMs?:number, sleep?:Function}} [deps]
 * @returns {Promise<{cues:Array<{text:string,start:number,end:number}>, provider:string, model:string, rawCueCount:number}>}
 * @throws {SttError}
 */
async function transcribeAudio(audioPath, options = {}, extra = {}, deps = {}) {
  const readFile = deps.readFile || fs.promises.readFile
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const preference = String(extra?.instructions || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  const prompt = preference
    ? `${STT_PROMPT}\n- Provider preference from the user (follow it only where it does not conflict with the rules above): ${preference}`
    : STT_PROMPT

  let buf
  try {
    buf = await readFile(audioPath)
  } catch (e) {
    throw new SttError('STT_AUDIO_FORMAT_UNSUPPORTED', 'The extracted audio file could not be read.', { cause: e })
  }
  const { ext, mime } = validateAudioPath(audioPath, buf)

  const chain = providerChain()
  const candidates = chain.filter((id) => PROVIDERS[id].key())
  if (!candidates.length) {
    throw new SttError('STT_API_KEY_MISSING',
      'No audio-capable speech provider is configured. Set GEMINI_API_KEY, OPENAI_API_KEY or GROQ_API_KEY on the server.')
  }

  let lastError = null
  let skipped = null
  for (const id of chain) {
    const provider = PROVIDERS[id]
    if (!provider.key()) {
      skipped = skipped || new SttError('STT_API_KEY_MISSING', `The ${id} speech provider has no API key.`, { provider: id })
      continue
    }
    if (!provider.formats.includes(ext)) {
      lastError = new SttError('STT_AUDIO_FORMAT_UNSUPPORTED',
        `The ${id} speech provider does not accept ${ext} audio.`, { provider: id })
      continue
    }
    if (buf.length > Math.min(provider.maxBytes, Number(options.maxBytes) || provider.maxBytes)) {
      lastError = new SttError('STT_AUDIO_TOO_LARGE',
        `The audio is too large for ${id} (max ${Math.round(provider.maxBytes / MB)} MB).`, { provider: id })
      continue
    }
    const models = provider.models().filter(Boolean)
    for (const model of models) {
      let attemptError = null
      for (let attempt = 0; attempt < STT_ATTEMPTS; attempt++) {
        try {
          const result = await provider.transcribe({
            buf, ext, mime, model, prompt, key: provider.key(), deps,
          })
          if (!Array.isArray(result.cues) || result.cues.length === 0) {
            throw new SttError('STT_NO_SPEECH_DETECTED',
              'No clear speech was detected in this clip.', { provider: id, model })
          }
          return {
            cues: result.cues,
            provider: id,
            model,
            rawCueCount: result.cues.length,
          }
        } catch (e) {
          const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
          const err = e instanceof SttError
            ? e
            : new SttError(timedOut ? 'STT_TIMEOUT' : 'STT_PROVIDER_UNREACHABLE',
              timedOut ? 'The speech service took too long to respond.' : 'The speech service is unreachable right now.',
              { provider: id, model, cause: e })
          attemptError = err
          lastError = err
          if (err.code === 'STT_NO_SPEECH_DETECTED' || err.code === 'STT_EMPTY_TRANSCRIPT') break
          if (!err.retryable || attempt === STT_ATTEMPTS - 1) break
          await sleep(STT_RETRY_BASE_MS * (attempt + 1))
        }
      }
      // A model that definitively found no speech is a real answer, not an
      // invitation to try another model.
      if (attemptError?.code === 'STT_NO_SPEECH_DETECTED' || attemptError?.code === 'STT_EMPTY_TRANSCRIPT') {
        throw attemptError
      }
      // Fall through to the provider's next model alias. Gemini exposes a
      // lighter fallback model precisely for overload/5xx cases.
    }
  }

  if (lastError) throw lastError
  throw skipped || new SttError('STT_API_KEY_MISSING', 'No audio-capable speech provider is configured.')
}

module.exports = {
  SttError,
  STT_ERROR_CODES,
  STATUS_BY_CODE,
  STT_PROMPT,
  transcribeAudio,
  listSttProviders,
  providerChain,
  validateAudioPath,
  looksLikeAudio,
  formatOf,
  AUDIO_FORMATS,
  PROVIDERS,
  STT_TIMEOUT_MS,
  STT_ATTEMPTS,
}
