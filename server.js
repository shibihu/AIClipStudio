// ---------------------------------------------------------------------------
// server.js — AI Clip Studio: zero-dependency Node.js video-editing web app
//   • upload a clip (any ffmpeg-readable format)
//   • chat with the AI about the edits you want — ANY free-form request —
//     the AI (Gemini/OpenAI/Anthropic via env keys, else local engine) turns
//     your words into an ffmpeg pipeline and renders it, and answers
//     non-edit questions conversationally.
//   • renders run asynchronously with live progress (1 ffmpeg at a time,
//     extras are queued), every result becomes a version with a thumbnail,
//     the client can preview all versions and pin any as the edit base,
//     a filmstrip API powers the visual trim picker, and captions are
//     burned in by distributing pasted script lines over detected speech.
// Used ffmpeg binary: ./vendor/ffmpeg-<arch> if present, else ./vendor/ffmpeg, else whatever is on PATH.
// ---------------------------------------------------------------------------

// --- load .env (key-value lines) — never committed --------------------------
{
  const envPath = __dirname + '/.env'
  try {
    for (const line of require('fs').readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
    }
  } catch { /* no .env — fine */ }
}

const http = require('http')

// prefer IPv4 A-records when a host has both: on IPv6-broken networks those
// connections silently blackhole and stall every LLM call for minutes
require('dns').setDefaultResultOrder('ipv4first')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFile, spawn } = require('child_process')
const { resolveBinaries } = require('./ffmpeg')
const {
  understand, understandWithLLM, build, makeTextOverlay, writeCaptionAss,
  buildCues, placeCues, normalizeTranscriptCues, getLlmHealth,
} = require('./ai')
const {
  transcribeAudio, SttError, listSttProviders,
} = require('./stt')
const {
  POSITIONS, DEFAULT_POSITION, SUBTITLE_MODES,
  normalizePosition, normalizeMode, normalizeStyle, positionLabel,
  parseSubtitleInstructions, resolveCaptionLayout, captionRegion, resolveFontFamily,
} = require('./subtitle-layout')
const {
  detectBurnedInSubtitles, buildObscureGraph, verifyCaptionRender,
} = require('./subtitle-removal')
const {
  formatRenderReport, formatRenderError, renderFacts, stripInternalDetails,
  technicalDetails, maybeAttachTechnical, DEBUG_ENABLED,
} = require('./render-report')
const { buildFfmpegArgs, displayCommand } = require('./render-args')
const { buildCaptionRender } = require('./caption-render')
const { CaptionTaskStore } = require('./caption-jobs')

const ROOT = __dirname
const PUBLIC = path.join(ROOT, 'public')
const JOBS = path.join(ROOT, 'jobs')
const MAX_UPLOAD = 1024 * 1024 * 1024 // 1 GB
const RENDER_CONCURRENCY = 1 // serialize renders: one ffmpeg at a time
const MAX_RENDER_QUEUE = Math.max(1, Math.min(64, Number(process.env.MAX_RENDER_QUEUE) || 8))
const BACKEND_VERSION = '1.1.0'
const API_SCHEMA_VERSION = 2
const UPLOAD_AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'aiff', 'aif', 'mpga'])
const UPLOAD_VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi', 'gif'])
const captionTasks = new CaptionTaskStore(JOBS)

const CAPABILITIES = Object.freeze({
  androidSkills: true,
  captionInstructions: true,
  subtitlePositioning: true,
  subtitlePositions: POSITIONS,
  subtitleModes: SUBTITLE_MODES,
  subtitleStyle: true,
  burnedInSubtitleDetection: true,
  sceneDetection: true,
  renderValidation: true,
  structuredSttErrors: true,
  apiSchemaVersion: API_SCHEMA_VERSION,
  stt: null, // filled from stt.js (keys can change between requests in dev)
})

function backendInfo() {
  return {
    name: 'ai-clip-studio',
    version: BACKEND_VERSION,
    apiSchemaVersion: API_SCHEMA_VERSION,
  }
}

function currentCapabilities() {
  return { ...CAPABILITIES, stt: listSttProviders() }
}

fs.mkdirSync(JOBS, { recursive: true })

// --- locate ffmpeg/ffprobe --------------------------------------------------
// Binaries are vendored per-arch for Linux/Render. Windows uses its native
// FFmpeg installation from PATH because the bundled files are Linux binaries.
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = resolveBinaries(ROOT)

function findFont() {
  const candidates = [
    path.join(ROOT, 'vendor', 'fonts', 'DejaVuSans-Bold.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    'C:/Windows/Fonts/arialbd.ttf',
  ]
  for (const c of candidates) {
    try { fs.accessSync(c); return c } catch { /* next */ }
  }
  const dir = '/usr/share/fonts'
  try {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { const r = walk(p); if (r) return r }
        else if (/\.ttf$/i.test(e.name)) return p
      }
      return null
    }
    return walk(dir)
  } catch { return null }
}
const FONT = findFont()

let FFMPEG_OK = null
execFile(FFMPEG, ['-version'], { timeout: 15000 }, (err, stdout) => {
  FFMPEG_OK = !err
  console.log(err ? `[ai-studio] ffmpeg check FAILED: ${err.message}` : `[ai-studio] ffmpeg OK — ${String(stdout).split('\n')[0]}`)
})
console.log(`[ai-studio] ffmpeg: ${FFMPEG}${FONT ? ` | font: ${FONT}` : ' | font: none (text overlays need fontconfig/default font)'}`)

// --- helpers -----------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
}

function send(res, code, body, headers = {}) {
  const h = { ...headers }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    h['content-type'] ||= 'text/plain; charset=utf-8'
    h['content-length'] = Buffer.byteLength(body)
  }
  res.writeHead(code, h)
  res.end(body)
}

function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'content-type': 'application/json' })
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch (e) { reject(e) } })
  })
}

// streaming multipart/form-data parser: file parts are piped straight to
// destPath (memory stays flat for 1 GB uploads); fields are buffered (≤ 1 MB).
// Only the FIRST file part is captured; later ones are skipped.
function parseMultipart(req, boundary, destPath) {
  return new Promise((resolve, reject) => {
    const B = Buffer.from(`--${boundary}`)
    const D = Buffer.from(`\r\n--${boundary}`)
    let buf = Buffer.alloc(0)
    let total = 0
    let done = false, failed = false
    let state = 'preamble' // preamble → delimEnd → headers ↔ body
    let fields = {}
    let curField = null
    let fieldBytes = 0
    let file = null
    let ws = null

    const fail = (e) => {
      if (failed) return
      failed = true
      if (ws) { try { ws.destroy() } catch {} }
      try { fs.unlinkSync(destPath) } catch {}
      req.destroy()
      reject(e)
    }
    const sink = (part) => {
      if (ws) { ws.write(part); file.size += part.length }
      else if (curField !== null) {
        fieldBytes += part.length
        if (fieldBytes > 1024 * 1024) return fail(new Error('form field too large'))
        fields[curField] = (fields[curField] || '') + part.toString('utf8')
      }
    }

    function pump() {
      for (;;) {
        if (state === 'preamble') {
          const i = buf.indexOf(B)
          if (i === -1) {
            if (buf.length > B.length) buf = buf.slice(buf.length - B.length)
            return
          }
          buf = buf.slice(i + B.length) // consume '--boundary'; '\r\n' or terminator follows
          state = 'delimEnd'
        } else if (state === 'delimEnd') {
          if (buf.length < 2) return
          if (buf[0] === 0x2d && buf[1] === 0x2d) { done = true; return }
          if (buf[0] === 0x0d && buf[1] === 0x0a) { buf = buf.slice(2); state = 'headers' }
          else return fail(new Error('malformed multipart body'))
        } else if (state === 'headers') {
          const he = buf.indexOf('\r\n\r\n')
          if (he === -1) {
            if (buf.length > 64 * 1024) return fail(new Error('multipart header too large'))
            return
          }
          const head = buf.slice(0, he).toString('utf8')
          buf = buf.slice(he + 4)
          const nameM = head.match(/name="([^"]*)"/)
          const fileM = head.match(/filename="([^"]*)"/)
          const ctype = (head.match(/content-type:\s*([^\r\n]+)/i) || [])[1]
          curField = null; ws = null
          if (nameM) {
            if (fileM && fileM[1]) {
              if (!file) {
                file = { filename: fileM[1], mime: (ctype || 'application/octet-stream').trim(), size: 0, path: destPath }
                ws = fs.createWriteStream(destPath, { flags: 'w' })
              } // else: skip extra file parts
            } else { curField = nameM[1]; fields[curField] = '' }
          }
          fieldBytes = 0
          state = 'body'
        } else { // body
          const k = buf.indexOf(D)
          if (k === -1) {
            const keep = Math.min(buf.length, D.length - 1) // hold back a partial delimiter
            const cut = buf.length - keep
            if (cut > 0) { sink(buf.slice(0, cut)); buf = buf.slice(cut) }
            return
          }
          if (k > 0) sink(buf.slice(0, k))
          buf = buf.slice(k + D.length)
          curField = null; ws = null
          state = 'delimEnd'
        }
      }
    }

    req.on('data', (c) => {
      if (failed) return
      total += c.length
      if (total > MAX_UPLOAD) return fail(new Error('File too large (max 1 GB)'))
      buf = buf.length ? Buffer.concat([buf, c]) : c
      pump()
    })
    req.on('error', (e) => fail(e))
    req.on('aborted', () => fail(new Error('upload aborted')))
    req.on('end', () => {
      if (failed) return
      if (!done) return fail(new Error('truncated multipart body'))
      const finish = () => resolve({ fields, file })
      if (ws) ws.end(finish)
      else finish()
    })
  })
}

function extOf(filename, mime) {
  const m = (filename || '').match(/\.([a-z0-9]{2,5})$/i)
  if (m) return m[1].toLowerCase()
  const map = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }
  return map[mime] || 'bin'
}

function fmtMB(n) { return n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB' }

function validJobId(id) {
  return typeof id === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
}

function uploadKind(ext) {
  if (UPLOAD_VIDEO_EXT.has(ext)) return 'video'
  if (UPLOAD_AUDIO_EXT.has(ext)) return 'audio'
  return null
}

function sttErrorPayload(error) {
  const stt = error instanceof SttError
    ? error
    : new SttError('STT_PROVIDER_UNREACHABLE', 'The speech service is unreachable right now.')
  return {
    error: stt.toJSON(),
    // Legacy clients read `reply`/`error` as a string; keep a human message
    // alongside the structured object without hiding the code from new clients.
    reply: stt.message,
    retryable: stt.retryable,
  }
}

function ffprobeJson(file) {
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(null)
      try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
    })
  })
}

async function probe(file) {
  const j = await ffprobeJson(file)
  if (!j) {
    return {
      duration: null, width: null, height: null,
      hasVideo: false, hasAudio: false, fps: null,
      format: 'unknown', probeFailed: true,
    }
  }
  const v = (j.streams || []).find((s) => s.codec_type === 'video')
  const a = (j.streams || []).find((s) => s.codec_type === 'audio')
  const meta = {
    duration: j.format ? Math.round(parseFloat(j.format.duration) * 100) / 100 : null,
    width: v?.width || null,
    height: v?.height || null,
    // hasVideo===false means audio-only (exported mp3 / audio upload): visual
    // edits and even -an must never run here (ffmpeg picks zero streams)
    hasVideo: !!v,
    hasAudio: !!a,
    fps: v && v.avg_frame_rate && v.avg_frame_rate.includes('/') ? Math.round((v.avg_frame_rate.split('/').reduce((a2, b) => a2 / b)) * 100) / 100 : 30,
    format: j.format?.format_name || 'unknown',
    probeFailed: false,
  }
  return meta
}

function run(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || err.message).split('\n').filter(Boolean).slice(-4).join('\n') })
      else resolve({ ok: true })
    })
  })
}

// tiny thumbnail helper — shared by upload, renders and version pinning
async function makeThumb(dir, srcFile, thumbName) {
  const meta = await probe(srcFile)
  const at = meta.duration ? Math.max(0, Math.min(meta.duration / 2, meta.duration - 0.3)) : 0
  const r = await run(FFMPEG, ['-y', '-hide_banner', '-ss', String(at), '-i', srcFile, '-frames:v', '1', '-vf', 'scale=240:-2', '-q:v', '5', path.join(dir, thumbName)], 30000)
  return r.ok
}

// --- vision: small sample frames shown to the LLM (Phase: AI upgrades) --------
// Frames are cached per source version in jobs/<id>/frames-<srcName>/ so repeat
// questions don't re-decode. 432px-wide JPEGs keep the inline payload small.
async function extractFrames(dir, srcFile, srcName, { count = 6 } = {}) {
  const cacheDir = path.join(dir, `frames-${path.basename(srcName).replace(/\W+/g, '_').replace(/_+$/, '')}`)
  const read = async (n) => {
    const files = (await fsp.readdir(cacheDir)).filter((f) => /^\d+\.jpg$/.test(f)).sort((a, b) => (+a.replace(/\D/g, '')) - (+b.replace(/\D/g, '')))
    if (files.length < Math.min(n, count)) return null
    const frames = []
    for (const f of files.slice(0, count)) {
      frames.push({ mime: 'image/jpeg', data: (await fsp.readFile(path.join(cacheDir, f))).toString('base64') })
    }
    return frames
  }
  try { const cached = await read(count); if (cached) return cached } catch { /* extract below */ }
  const meta = await probe(srcFile)
  const dur = meta.duration
  if (!dur || dur < 0.3) return []
  const n = Math.max(2, Math.min(count, Math.ceil(dur / 5)))
  const fpsVal = Math.max(0.05, Math.min(n / dur, 2)).toFixed(5)
  await fsp.mkdir(cacheDir, { recursive: true })
  const r = await run(FFMPEG, ['-y', '-hide_banner', '-i', srcFile, '-vf', `fps=${fpsVal},scale=432:-2:flags=bicubic`, '-frames:v', String(n), path.join(cacheDir, '%03d.jpg')], 90000)
  if (!r.ok) return []
  try { return (await read(n)) || [] } catch { return [] }
}

// messages that benefit from actually SEEING the clip
const VISION_RE = /\b(suggest|recommend|ideas?\b|best (part|moment|segment|hook|clip)|improve|engaging|hook|tiktok|shorts?|reels?|highlights?|funny|viral|should i|vibe|aesthetic|what do you see|what.?s in (the|this|my)|describe|footage|scenes?|shots?)\b/i

// --- job state (persisted to jobs/<id>/job.json so restarts keep history) -----
// versions: [{ name, desc, thumb, meta }] — v[0] is the original upload.
// base: index of the version new edits render from (moves forward after each
// render; rewinding just re-pins an older version — history is never lost).
function normalizeJob(job) {
  if (!job) return null
  if (!Array.isArray(job.msgs)) job.msgs = []
  job.versions = (job.versions || []).map((v, i) =>
    typeof v === 'string' ? { name: v, desc: i === 0 ? 'original upload' : '', thumb: null, meta: null } : v
  )
  if (typeof job.base !== 'number' || job.base < 0 || job.base >= job.versions.length) {
    job.base = Math.max(0, job.versions.length - 1)
  }
  if (!(job.next >= 1)) job.next = job.versions.length
  return job
}

function loadJob(id) {
  try { return normalizeJob(JSON.parse(fs.readFileSync(path.join(JOBS, id, 'job.json'), 'utf8'))) } catch { return null }
}

const history = new Map() // id → normalized job

function getJob(id) {
  let job = history.get(id)
  if (!job) { job = loadJob(id); if (job) history.set(id, job) }
  return job || null
}

async function saveJob(job, id) {
  try { await fsp.writeFile(path.join(JOBS, id, 'job.json'), JSON.stringify(job)) } catch { /* transient */ }
}

// --- async render pipeline ----------------------------------------------------
// Renders are enqueued with progress; one ffmpeg runs at a time, the rest queue.
// The chat endpoint answers immediately; the client polls /api/render?id&rid.

const renders = new Map()      // rid → registry entry
const renderQueue = []         // rids waiting while another render runs
let activeRuns = 0

// user message → done/failed replies are appended to the chat history when the
// render settles, so /api/job stays consistent with what was actually made.
// A pending.json marker survives server restarts: rehydrateRenders() re-queues
// the interrupted render on boot (or reports it as failed if the source is gone).
async function enqueueRender(job, jobId, srcName, frag, result, meta, userMsg) {
  if (renderQueue.length + activeRuns >= MAX_RENDER_QUEUE) {
    const error = new Error('The render queue is full. Wait for an edit to finish and try again.')
    error.code = 'RENDER_QUEUE_FULL'
    error.status = 429
    throw error
  }
  const src = path.join(JOBS, jobId, srcName)
  const outName = `out-${job.next++}.${frag.output}`
  const outPath = path.join(JOBS, jobId, outName)

  const args = buildFfmpegArgs({ frag, src, outPath, meta })

  const cmdDisplay = displayCommand('ffmpeg', args, outPath)

  // expected output length drives the progress percentage
  let expected = Math.max(1, meta.duration || 1)
  if (frag.seek) {
    if (frag.seek.to != null) expected = frag.seek.to - (frag.seek.from || 0)
    else if (frag.seek.from != null) expected = Math.max(1, (meta.duration || 1) - frag.seek.from)
  }
  for (const op of result.ops || []) {
    const rate = op.rate || (op.vf || '').match(/^setpts=PTS\/([\d.]+)/)?.[1]
    if (op.kind === 'speed' && rate) expected /= (+rate) || 1
  }
  expected = Math.max(1, Math.round(expected * 10) / 10)

  const rid = crypto.randomUUID()
  const reg = {
    rid, jobId, status: 'queued', progress: 0,
    srcName, args, cmdDisplay, outPath, outName,
    summary: result.summary || frag.desc.join(' + '),
    ops: frag.desc,
    userMsg,
    fromIndex: job.base,
    expected, proc: null, media: null, thumb: null, reply: null,
    // source facts for output validation (audio must survive a caption burn)
    sourceMeta: meta ? { hasAudio: !!meta.hasAudio, hasVideo: !!meta.hasVideo } : null,
    // structured, user-safe facts (captions/position/audio/detection) — the
    // raw args stay server-side and only surface in explicit debug mode
    facts: frag.facts || {},
    errTail: '',
  }
  renders.set(rid, reg)
  renderQueue.push(rid)
  // The raw command lives ONLY in this on-disk marker (server filesystem) and
  // in the server log; it is never sent to a client unless EXPOSE_RENDER_DEBUG.
  console.log(`[ai-studio] render ${jobId}/${outName} queued: ${cmdDisplay}`)
  try {
    await fsp.writeFile(path.join(JOBS, jobId, 'pending.json'), JSON.stringify({
      rid, srcName, args, cmdDisplay, outPath, outName,
      summary: reg.summary, ops: reg.ops, userMsg, fromIndex: job.base,
      expected, facts: reg.facts, createdAt: Date.now(),
    }))
  } catch { /* best-effort marker */ }
  pumpRenders()
  return { rid, reg }
}

function pumpRenders() {
  while (activeRuns < RENDER_CONCURRENCY && renderQueue.length) {
    const rid = renderQueue.shift()
    const reg = renders.get(rid)
    if (!reg) continue
    activeRuns++
    startRender(reg).catch((e) => console.error('[ai-studio] render crash:', e)).finally(() => {
      activeRuns--
      pumpRenders()
    })
  }
}

async function startRender(reg) {
  reg.status = 'running'
  reg.startedAt = Date.now()
  console.log(`[ai-studio] render ${reg.jobId}/${reg.outName} started (queue ${renderQueue.length})`)
  let errTail = ''
  let code = 1

  await new Promise((resolve) => {
    let proc
    try {
      proc = spawn(FFMPEG, reg.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      errTail = e.message
      return resolve()
    }
    reg.proc = proc
    const watchdog = setTimeout(() => {
      // A watchdog that only resolves leaves an orphan FFmpeg writing the
      // output while the queue advances. Kill the process, then settle.
      errTail = 'render timed out after 15 minutes'
      reg.timedOut = true
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
      resolve()
    }, 15 * 60 * 1000)
    proc.on('error', (e) => { errTail = e.message; clearTimeout(watchdog); resolve() })
    proc.stdout.on('data', (d) => {
      if (!reg.expected) return
      const s = d.toString()
      for (const m of s.matchAll(/out_time_us=(\d+)/g)) {
        reg.progress = Math.max(reg.progress, Math.min(99, Math.round(((+m[1] / 1e6) / reg.expected) * 100)))
      }
    })
    proc.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        errTail = (errTail ? errTail.split('\n') : []).concat(line).slice(-6).join('\n')
      }
      if (errTail.length > 6000) errTail = '…' + errTail.slice(-5000)
    })
    proc.on('close', (c) => { code = c === 0 ? 0 : 1; clearTimeout(watchdog); resolve() })
  })

  const fail = (reg, errTail) => {
    reg.status = 'failed'
    reg.failureHint = 'I hit a problem while rendering that edit.'
    reg.reply = formatRenderReport(reg)
  }
  fsp.rm(path.join(JOBS, reg.jobId, 'pending.json'), { force: true }).catch(() => {})
  reg.finishedAt = Date.now()
  reg.errTail = errTail
  if (code === 0) {
    const outputKind = /\.mp3$/i.test(reg.outName) ? 'audio' : 'video'
    const validation = await validateRenderOutput(reg.outPath, {
      kind: outputKind,
      expectAudio: reg.sourceMeta?.hasAudio === true && outputKind === 'video' && !reg.args.includes('-an'),
      duration: reg.expected,
    })
    if (!validation.ok) {
      code = 1
      errTail = `output validation failed: ${validation.reason}`
      console.error(`[ai-studio] render ${reg.jobId}/${reg.outName} ${errTail}`)
    } else {
      reg.validation = { ok: true, duration: validation.meta.duration }
    }
    const outMeta = validation.ok ? validation.meta : null
    if (!outMeta) {
      // skip the success branch below; failure cleanup is shared
    } else {
    const thumbName = `thumb-${reg.outName}.jpg`
    const thumbOk = await makeThumb(path.join(JOBS, reg.jobId), reg.outPath, thumbName)
    reg.media = { url: `/media/${reg.jobId}/${encodeURIComponent(reg.outName)}`, ...outMeta, name: reg.outName }
    reg.thumb = thumbOk ? `/media/${reg.jobId}/${encodeURIComponent(thumbName)}` : null
    reg.progress = 100
    reg.status = 'done'
    reg.facts = { ...reg.facts, outputDuration: outMeta.duration }

    // Pixel-level verification: did the render actually do what the report
    // claims? Measured, never assumed.
    if (reg.verify) {
      try {
        const sourcePath = path.join(JOBS, reg.jobId, reg.srcName)
        const verification = await verifyCaptionRender(FFMPEG, sourcePath, reg.outPath, outMeta, {
          oldBand: reg.verify.oldBand,
          newBand: reg.verify.newBand,
        })
        reg.facts.verification = verification
        console.log(`[ai-studio] verify ${reg.jobId}/${reg.outName}: ${JSON.stringify(verification)}`)
      } catch (e) {
        console.error('[ai-studio] render verification failed:', e.message)
      }
    }
    reg.reply = formatRenderReport(reg)

    const job = getJob(reg.jobId)
    if (job) {
      const vN = job.versions.length + 1
      job.versions.push({ name: reg.outName, desc: reg.summary, thumb: reg.thumb, meta: { duration: outMeta.duration, width: outMeta.width, height: outMeta.height, hasVideo: outMeta.hasVideo, hasAudio: outMeta.hasAudio, fps: outMeta.fps } })
      // audio-only outputs (exported mp3) become a version, but the edit base
      // must stay on video — editing "from" an mp3 is what caused
      // "Output file does not contain any stream" render failures
      if (outMeta.hasVideo !== false) job.base = job.versions.length - 1
      job.msgs.push({ role: 'user', content: reg.userMsg }, { role: 'assistant', content: reg.reply })
      await saveJob(job, reg.jobId)
      console.log(`[ai-studio] render ${reg.jobId}/${reg.outName} done → v${vN}`)
    }
    }
  } else {
    await fsp.rm(reg.outPath, { force: true }).catch(() => {})
    fail(reg, errTail)
    const job = getJob(reg.jobId)
    if (job) {
      job.msgs.push({ role: 'user', content: reg.userMsg }, { role: 'assistant', content: reg.reply })
      await saveJob(job, reg.jobId)
    }
    // detailed stderr stays in the server log only
    console.error(`[ai-studio] render ${reg.jobId}/${reg.outName} FAILED:\n${errTail}\ncommand: ${reg.cmdDisplay}`)
  }
}

// restart safety: pending.json markers left behind by a crash/restart are
// RE-QUEUED on boot — the marker carries the full ffmpeg command, so a deploy
// or restart no longer loses an edit. Only a missing/malformed marker or a
// gone source file falls back to a visible "lost render" failure the client
// can still poll.
async function rehydrateRenders() {
  let names
  try { names = await fsp.readdir(JOBS) } catch { return }
  for (const id of names) {
    if (/^_/.test(id) || !/^[a-f0-9-]{16,64}$/.test(id)) continue
    let pend
    try { pend = JSON.parse(await fsp.readFile(path.join(JOBS, id, 'pending.json'), 'utf8')) } catch { continue }
    if (!pend || !pend.rid || !Array.isArray(pend.args)) {
      await fsp.rm(path.join(JOBS, id, 'pending.json'), { force: true }).catch(() => {})
      continue
    }
    // can the source be re-rendered at all?
    const sourceOk = await fsp.stat(path.join(JOBS, id, pend.srcName)).then(() => true, () => false)
    if (sourceOk) {
      const sourceMeta = await probe(path.join(JOBS, id, pend.srcName))
      renders.set(pend.rid, {
        rid: pend.rid, jobId: id, status: 'queued', progress: 0,
        srcName: pend.srcName, args: pend.args, cmdDisplay: pend.cmdDisplay,
        outPath: pend.outPath, outName: pend.outName,
        summary: pend.summary || '', ops: pend.ops || [],
        userMsg: pend.userMsg, fromIndex: pend.fromIndex ?? null,
        expected: pend.expected || 0, proc: null, media: null, thumb: null, reply: null,
        sourceMeta: { hasAudio: !!sourceMeta.hasAudio, hasVideo: !!sourceMeta.hasVideo },
        facts: pend.facts || {}, errTail: '',
      })
      // the marker stays until this requeued render finishes (startRender removes it)
      renderQueue.push(pend.rid)
      console.log(`[ai-studio] render ${id}/${pend.outName} survived a restart → requeued`)
    } else {
      const job = loadJob(id)
      const reply = '⚠️ The server restarted while this render was running and its source file is gone. Upload the clip again — I\'ll re-run the edit right away.'
      renders.set(pend.rid, {
        rid: pend.rid, jobId: id, status: 'failed', progress: 0,
        srcName: pend.srcName, args: pend.args, cmdDisplay: pend.cmdDisplay,
        outPath: pend.outPath, outName: pend.outName,
        summary: pend.summary || '', ops: pend.ops || [],
        userMsg: pend.userMsg, fromIndex: pend.fromIndex ?? null,
        expected: 0, proc: null, media: null, thumb: null, reply,
      })
      if (job && pend.userMsg) {
        job.msgs.push({ role: 'user', content: pend.userMsg }, { role: 'assistant', content: reply })
        await saveJob(job, id)
      }
      await fsp.rm(path.join(JOBS, id, 'pending.json'), { force: true }).catch(() => {})
      console.log(`[ai-studio] rehydrated interrupted render ${id}/${pend.outName} as failed (source gone)`)
    }
  }
  if (renderQueue.length) pumpRenders()
}

// --- captions: distribute pasted script lines over detected speech -----------
// buildCues() / placeCues() (pure cue math) live in ai.js — unit-tested there.
// speechSegments() stays here because it shells out to ffmpeg silencedetect.

function speechSegments(src, meta) {
  return new Promise((resolve) => {
    execFile(FFMPEG,
      ['-hide_banner', '-i', src, '-vn', '-af', 'silencedetect=noise=-30dB:d=0.3', '-f', 'null', '-'],
      { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = String(stderr || '')
        const events = []
        for (const m of out.matchAll(/silence_start:\s*([\d.]+)/g)) events.push({ t: +m[1], type: 'start' })
        for (const m of out.matchAll(/silence_end:\s*([\d.]+)/g)) events.push({ t: +m[1], type: 'end' })
        events.sort((a, b) => a.t - b.t)
        const dur = meta.duration
        const segs = []
        let cur = 0
        for (const ev of events) {
          if (ev.type === 'start') {
            if (dur == null || ev.t - cur > 0.5) segs.push([cur, ev.t])
            cur = ev.t
          } else cur = ev.t
        }
        if (dur == null) segs.push([cur, cur + 30])
        else if (dur - cur > 0.5) segs.push([cur, dur])
        let ok = segs.filter((s) => s[1] - s[0] > 0.3)
        if (!ok.length && dur) ok = [[0, dur]]
        resolve(ok)
      })
  })
}

// --- scene detection (FFmpeg scene score) ------------------------------------
// Returns timeline positions in seconds. This is the route the Android
// "Scene detection" skill has always called; it used to be a 404.
function detectSceneCuts(src, { threshold = 0.35 } = {}) {
  const t = Math.min(0.95, Math.max(0.05, Number(threshold) || 0.35))
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG,
      ['-hide_banner', '-i', src, '-an', '-vf', `select='gt(scene,${t})',showinfo`, '-f', 'null', '-'],
      { timeout: 180000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // select+showinfo exits 0; a decode failure is a real error.
        if (err) return reject(new Error('scene detection failed'))
        const times = []
        for (const m of String(stderr || '').matchAll(/pts_time:\s*([\d.]+)/g)) {
          const time = Math.round(parseFloat(m[1]) * 1000) / 1000
          if (Number.isFinite(time) && time >= 0) times.push(time)
        }
        resolve({ scenes: [...new Set(times)].sort((a, b) => a - b), threshold: t })
      },
    )
  })
}

// --- render output validation ------------------------------------------------
// Never report success just because FFmpeg exited 0. Keep the checks cheap and
// independent from the render fragment: file, streams, duration, dimensions.
async function validateRenderOutput(outPath, expected = {}) {
  let st
  try { st = await fsp.stat(outPath) } catch {
    return { ok: false, reason: 'output file missing' }
  }
  if (!st.isFile() || st.size <= 0) return { ok: false, reason: 'output file is empty' }
  const meta = await probe(outPath)
  if (meta.probeFailed) return { ok: false, reason: 'output is not decodable' }
  if (expected.kind !== 'audio' && !meta.hasVideo) return { ok: false, reason: 'output has no video stream' }
  if (expected.expectAudio && !meta.hasAudio) return { ok: false, reason: 'output lost the expected audio stream' }
  if (!meta.duration || meta.duration < 0.05) return { ok: false, reason: 'output duration is invalid' }
  if (expected.duration != null && expected.duration > 0) {
    const tolerance = Math.max(0.75, expected.duration * 0.08)
    if (Math.abs(meta.duration - expected.duration) > tolerance) {
      return {
        ok: false,
        reason: `output duration ${meta.duration}s differs from expected ${expected.duration}s`,
      }
    }
  }
  if (meta.hasVideo && (!meta.width || !meta.height)) {
    return { ok: false, reason: 'output has no frame dimensions' }
  }
  return { ok: true, meta }
}

// --- periodic cleanup: remove job dirs older than JOBS_TTL_HOURS (default 24) --
const JOBS_TTL_MS = Math.max(0.01, +process.env.JOBS_TTL_HOURS || 24) * 3600 * 1000
async function cleanupJobs() {
  let names
  try { names = await fsp.readdir(JOBS) } catch { return }
  const cutoff = Date.now() - JOBS_TTL_MS
  for (const name of names) {
    if (/^_/.test(name)) continue // helpers like _sample.mp4 are kept
    const dir = path.join(JOBS, name)
    try {
      const st = await fsp.stat(dir)
      if (!st.isDirectory()) continue
      if (st.mtimeMs < cutoff) {
        await fsp.rm(dir, { recursive: true, force: true })
        console.log(`[ai-studio] cleaned stale job ${name}`)
      }
    } catch { /* gone or unreadable */ }
  }
}

// --- auth: optional shared access token --------------------------------------
// Set AUTH_TOKEN in .env to lock the studio behind a shared password.
// When set: every /api/* (except /api/auth and static pages) and every /media/*
// requires the token — via HttpOnly cookie (set by POST /api/auth), the
// x-auth-token header, or ?auth= (covers <img>/<video> tags). Static pages are
// served open so the browser login overlay can obtain the token first.
const AUTH_TOKEN = (process.env.AUTH_TOKEN && String(process.env.AUTH_TOKEN).trim()) || ''

function parseCookies(req) {
  const out = {}
  const h = req.headers.cookie || ''
  for (const part of h.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function authorized(req, url) {
  if (!AUTH_TOKEN) return true
  if (parseCookies(req).auth === AUTH_TOKEN) return true
  if (req.headers['x-auth-token'] === AUTH_TOKEN) return true
  return url.searchParams.get('auth') === AUTH_TOKEN
}

// visible signal when an edit/chat got answered by the offline engine because
// the LLM just failed (timeout / overloaded / unreachable) — otherwise it looks
// like the AI silently degraded with no explanation
function llmFallbackNote(now = Date.now()) {
  const h = getLlmHealth()
  if (!h.aiKey || h.reachable !== false) return ''
  if (!h.lastErrorAt || now - h.lastErrorAt > 2 * 60 * 1000) return ''
  const detail = h.lastError ? ` (${String(h.lastError).slice(0, 140)})` : ''
  return `\n\nℹ️ The AI service seems unreachable${detail} — this answer came from the built-in offline engine, so more exotic requests may not be understood right now.`
}

// Every string a client reads passes through here. Raw FFmpeg commands, server
// paths and stderr never belong in a chat reply, even if some upstream text
// accidentally contains them.
function publicReply(text) {
  return stripInternalDetails(text)
}

// --- rate limiting: small sliding-window buckets per ip+route -----------------
const RATE_RULES = [
  { match: /^\/api\/auth$/, max: 6, windowMs: 60000 },
  { match: /^\/api\/chat$/, max: 12, windowMs: 60000 },
  { match: /^\/api\/upload$/, max: 5, windowMs: 10 * 60000 },
  { match: /^\/api\/captions$/, max: 8, windowMs: 60000 },
  { match: /^\/api\/strip$/, max: 40, windowMs: 60000 },
  { match: /^\/api\/jobs$/, max: 30, windowMs: 60000 },
]
const rateBuckets = new Map() // ip+route → [timestamps]

function hitRate(rule, ip) {
  const now = Date.now()
  const key = ip + '|' + rule.match.source
  const ts = (rateBuckets.get(key) || []).filter((t) => now - t < rule.windowMs)
  if (ts.length >= rule.max) {
    ts.push(now)
    return false
  }
  ts.push(now)
  rateBuckets.set(key, ts)
  if (rateBuckets.size > 4096) {
    for (const [k, v] of rateBuckets) {
      if (!v.length || now - v[v.length - 1] > 15 * 60000) rateBuckets.delete(k)
    }
  }
  return true
}

// --- request router ------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    const ip = req.socket?.remoteAddress || 'local'

    // rate limits run first (even for unauthenticated ticks — cheaper to burn here)
    for (const rule of RATE_RULES) {
      if (rule.match.test(p) && !hitRate(rule, ip)) {
        return json(res, 429, { error: 'Too many requests — take a breath and try again shortly.' })
      }
    }

    // auth gate: api + media require a token when AUTH_TOKEN is configured
    // (/api/auth is exempt — it's how you obtain the session in the first place,
    //  /api/health is exempt — it powers uptime/health checks like Render's)
    if (AUTH_TOKEN && !authorized(req, url) && p !== '/api/auth' && p !== '/api/health') {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'auth required' })
      if (p.startsWith('/media/')) return send(res, 401, 'auth required')
    }

    // static files
    if (req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/media/')) {
      const file = p === '/' ? '/index.html' : p
      const abs = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''))
      if (!abs.startsWith(PUBLIC)) return send(res, 403, 'forbidden')
      try {
        const data = await fsp.readFile(abs)
        return send(res, 200, data, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' })
      } catch {
        return send(res, 404, 'not found')
      }
    }

    // media files (Range-aware so browsers can scrub/seek)
    const mediaM = p.match(/^\/media\/([a-f0-9-]+)\/([\w.-]+)$/)
    if (req.method === 'GET' && mediaM) {
      const abs = path.join(JOBS, mediaM[1], mediaM[2])
      if (!abs.startsWith(JOBS)) return send(res, 403, 'forbidden')
      let st
      try { st = await fsp.stat(abs) } catch { return send(res, 404, 'not found') }
      const ct = MIME[path.extname(abs)] || 'application/octet-stream'
      const base0 = { 'content-type': ct, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' }
      const rangeM = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/)
      if (rangeM) {
        let start = rangeM[1] === '' ? null : parseInt(rangeM[1], 10)
        let end = rangeM[2] === '' ? null : parseInt(rangeM[2], 10)
        if (start === null) { // suffix range: last N bytes
          start = Math.max(0, st.size - (end || 0))
          end = st.size - 1
        }
        end = Math.min(end ?? st.size - 1, st.size - 1)
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'content-range': `bytes */${st.size}` })
          return res.end()
        }
        res.writeHead(206, {
          ...base0,
          'content-range': `bytes ${start}-${end}/${st.size}`,
          'content-length': end - start + 1,
        })
        const rs = fs.createReadStream(abs, { start, end })
        rs.on('error', () => res.destroy())
        res.on('close', () => rs.destroy())
        rs.pipe(res)
      } else {
        res.writeHead(200, { ...base0, 'content-length': st.size })
        const rs = fs.createReadStream(abs)
        rs.on('error', () => res.destroy())
        res.on('close', () => rs.destroy())
        rs.pipe(res)
      }
      return
    }

    if (p === '/api/health') {
      return json(res, 200, {
        ok: true,
        backend: backendInfo(),
        ffmpeg: FFMPEG,
        ffmpegOk: FFMPEG_OK,
        aiKey: !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
        llm: getLlmHealth(),
        auth: !!AUTH_TOKEN,
        renders: {
          active: activeRuns,
          queued: renderQueue.length,
          concurrency: RENDER_CONCURRENCY,
          maxQueue: MAX_RENDER_QUEUE,
        },
        // Capability flags let the Android client fail loudly instead of
        // silently dropping a setting this deployment does not support.
        capabilities: {
          ...currentCapabilities(),
          renderDebugMode: DEBUG_ENABLED(),
        },
      })
    }

    // ---- machine-readable version + capabilities (Android compatibility) ----
    if (p === '/api/version' && req.method === 'GET') {
      return json(res, 200, {
        ...backendInfo(),
        capabilities: currentCapabilities(),
        limits: {
          maxUploadBytes: MAX_UPLOAD,
          maxRenderQueue: MAX_RENDER_QUEUE,
          renderConcurrency: RENDER_CONCURRENCY,
        },
      })
    }

    // ---- list of persisted projects (recent-first) ----
    if (p === '/api/jobs' && req.method === 'GET') {
      let names
      try { names = await fsp.readdir(JOBS) } catch { return json(res, 200, { jobs: [] }) }
      const jobs = []
      for (const name of names) {
        if (/^_/.test(name) || !/^[a-f0-9-]{16,64}$/.test(name)) continue
        const job = loadJob(name)
        if (!job || !Array.isArray(job.versions) || !job.versions.length) continue
        let st
        try { st = await fsp.stat(path.join(JOBS, name)) } catch { continue }
        const v0 = job.versions[0]
        jobs.push({
          id: name,
          original: job.original || String(v0.name).replace(/^input\./, ''),
          versionCount: job.versions.length,
          base: job.base,
          mtime: st.mtimeMs,
          thumb: v0.thumb,
          duration: v0.meta?.duration ?? null,
        })
        if (jobs.length >= 200) break
      }
      jobs.sort((a, b) => b.mtime - a.mtime)
      return json(res, 200, { jobs: jobs.slice(0, 60), llm: getLlmHealth() })
    }

    // ---- asynchronous automatic-caption tasks -----------------------------
    const captionTaskMatch = p.match(/^\/api\/captions\/jobs\/([a-zA-Z0-9_-]{1,128})$/)
    if (p === '/api/captions/jobs' && req.method === 'POST') {
      const body = await readJson(req)
      const { id } = body
      if (!validJobId(id)) return json(res, 400, { error: { code: 'BAD_JOB_ID', message: 'Invalid job id.', retryable: false } })
      const job = getJob(id)
      if (!job) return json(res, 404, { error: { code: 'UNKNOWN_JOB', message: 'unknown job — upload a clip first', retryable: false } })
      const srcName = job.versions[job.base]?.name
      const src = path.join(JOBS, id, srcName || '')
      const meta = await probe(src)
      if (!meta.hasAudio) return json(res, 422, { error: { code: 'NO_AUDIO', message: 'This version has no audio track to transcribe.', retryable: false } })
      if (meta.hasVideo === false) return json(res, 422, { error: { code: 'AUDIO_ONLY', message: 'Captions can only be burned into a video version.', retryable: false } })
      const idempotencyKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '').trim()
      if (!idempotencyKey) return json(res, 400, { error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key is required.', retryable: false } })
      const task = await captionTasks.create(id, { idempotencyKey, instructions: body.instructions })
      return json(res, 202, task)
    }
    if (captionTaskMatch && (req.method === 'GET' || req.method === 'DELETE')) {
      const taskId = captionTaskMatch[1]
      const jobId = url.searchParams.get('id') || req.headers['x-job-id'] || ''
      if (!validJobId(jobId)) return json(res, 400, { error: { code: 'BAD_JOB_ID', message: 'A valid source job id is required.', retryable: false } })
      try {
        const task = req.method === 'DELETE'
          ? await captionTasks.cancel(jobId, taskId)
          : await captionTasks.get(jobId, taskId)
        if (!task) return json(res, 404, { error: { code: 'CAPTION_TASK_NOT_FOUND', message: 'Caption task not found.', retryable: true } })
        return json(res, 200, task)
      } catch (e) {
        return json(res, 409, { error: { code: 'CAPTION_TASK_STATE', message: e.message, retryable: false } })
      }
    }

    // ---- login (shared access token; only when AUTH_TOKEN is set) ----
    if (p === '/api/auth' && req.method === 'POST') {
      if (!AUTH_TOKEN) return json(res, 200, { ok: true, open: true })
      const { token } = await readJson(req)
      if (String(token || '').trim() !== AUTH_TOKEN) return json(res, 401, { error: 'wrong access token' })
      return send(res, 200, JSON.stringify({ ok: true }), {
        'content-type': 'application/json',
        'set-cookie': `auth=${encodeURIComponent(AUTH_TOKEN)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`,
      })
    }

    // ---- upload ----
    if (p === '/api/upload' && req.method === 'POST') {
      const ct = req.headers['content-type'] || ''
      const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
      if (!bm) return json(res, 400, { error: 'expected multipart/form-data' })
      const id = crypto.randomUUID()
      const dir = path.join(JOBS, id)
      await fsp.mkdir(dir, { recursive: true })
      const tmp = path.join(dir, 'upload.part')
      let parsed
      try {
        parsed = await parseMultipart(req, (bm[1] || bm[2]).trim(), tmp)
      } catch (e) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
        return json(res, /too large/i.test(e.message) ? 413 : 400, { error: e.message })
      }
      const { file } = parsed
      if (!file || !file.size) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
        return json(res, 400, { error: 'no file received' })
      }
      const ext = extOf(file.filename, file.mime)
      const kind = uploadKind(ext)
      if (!kind) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
        return json(res, 415, {
          error: {
            code: 'UPLOAD_TYPE_UNSUPPORTED',
            message: `Unsupported file type ".${ext}". Upload a video or audio file.`,
            retryable: false,
          },
        })
      }
      const fname = `input.${ext}`
      await fsp.rename(tmp, path.join(dir, fname))
      const meta = await probe(path.join(dir, fname))
      // A probe failure used to return optimistic defaults, which created jobs
      // that failed later inside FFmpeg. Reject unreadable media up front.
      if (meta.probeFailed || (kind === 'video' && !meta.hasVideo) || (kind === 'audio' && !meta.hasAudio)) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
        return json(res, 422, {
          error: {
            code: 'UPLOAD_MEDIA_INVALID',
            message: 'The uploaded file is not a readable video or audio file.',
            retryable: false,
          },
        })
      }
      // thumbnail for the first version (cheap, helps the version strip right away)
      const thumbOk = kind === 'video' ? await makeThumb(dir, path.join(dir, fname), `thumb-${fname}.jpg`) : false
      const job = {
        msgs: [],
        input: fname,
        original: file.filename,
        versions: [{
          name: fname,
          desc: 'original upload',
          thumb: thumbOk ? `/media/${id}/${encodeURIComponent(`thumb-${fname}.jpg`)}` : null,
          meta: { duration: meta.duration, width: meta.width, height: meta.height, hasVideo: meta.hasVideo, hasAudio: meta.hasAudio, fps: meta.fps },
        }],
        base: 0,
        next: 1,
      }
      history.set(id, job)
      await saveJob(job, id)
      console.log(`[ai-studio] upload ${id} ← ${file.filename} (${fmtMB(file.size)})`)
      return json(res, 200, { id, meta, url: `/media/${id}/${encodeURIComponent(fname)}`, original: file.filename })
    }

    // ---- chat / edit ----
    if (p === '/api/chat' && req.method === 'POST') {
      const { id, message } = await readJson(req)
      if (!validJobId(id)) return json(res, 400, { error: { code: 'BAD_JOB_ID', message: 'Invalid job id.', retryable: false } })
      const job = getJob(id)
      if (!job) return json(res, 404, { error: { code: 'UNKNOWN_JOB', message: 'unknown job — upload a clip first', retryable: false } })
      if (typeof message !== 'string' || !message.trim()) {
        return json(res, 400, { error: { code: 'BAD_REQUEST', message: 'A non-empty message is required.', retryable: false } })
      }
      const srcName = job.versions[job.base].name
      const src = path.join(JOBS, id, srcName)
      const meta = await probe(src)

      // capability tour — handled locally, no LLM round-trip needed
      if (/^(what can you|help|commands|abilities)/.test(message.toLowerCase().trim())) {
        const list = [
          'Ask me *anything* in your own words — commands or questions, in any language. Examples:',
          '',
          '✂️ Trim — “remove the first 3 seconds”, “keep only 0:05 to 0:10” (or drag the filmstrip handles!)',
          '⏩ Speed — “2x speed”, “slow motion”',
          '🔇 Audio — “mute it”, “make it louder 2x”, “give me just the audio”',
          '🔄 Frame — “mirror”, “rotate 90”, “upside down”',
          '📐 Aspect — “make it square”, “9:16 for tiktok”, “720p”',
          '💬 Text — “add text \'Good Vibes\' at the top”',
          ' 🗣 Captions — paste your script via the ✨ captions chip and I’ll time it to your speech',
          '🎞 GIF — “make a gif at 15 fps”',
          '⏪ FX — “reverse”, “boomerang”, “blur”, “black and white”, “vintage”',
          '🎨 Color — “brighter”, “more colorful”, “more contrast”',
          '🕐 Versions — click any version below the player to preview it; ★ pins it as the base',
          '🧪 More effects — “add a vignette”, “fade in 1s”, “remove the bass”…',
          '',
          'You can chain edits in one message — e.g. “cut the first 3s, make it square, add text HI at the top”.',
          'You can also just ask questions — “would this work as a TikTok?” and I’ll answer.',
          'Every finished edit ends with a short summary: captions, length, subtitle position and whether the audio was kept.',
        ]
        const reply = publicReply('Here\'s what I can do with your clip:\n' + list.join('\n'))
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null })
      }

      // 1) understand the request (LLM if configured, else local engine)
      // When the message smells like a suggestion/advice question AND we have
      // an LLM, sample frames so the model can actually see the clip.
      let frames = null
      if (VISION_RE.test(message) && (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)) {
        frames = await extractFrames(path.join(JOBS, id), src, srcName)
      }
      // pass job.msgs as-is: understandWithLLM appends the current user message
      // itself (passing concat here would send the message to the model twice)
      let result = await understandWithLLM(message, meta, job.msgs, frames)

      // LLM chose a conversational answer (question / advice / chit-chat)
      if (result && result.isChat) {
        const reply = publicReply(result.reply)
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null, engine: 'llm-chat' })
      }

      let unresolved = false
      if (!result) {
        result = understand(message, meta)
        if (!result.ops.length) unresolved = true
      }
      if (unresolved) {
        const reply = "I couldn't map that to an edit I know yet. Try rephrasing — e.g. \"remove the first 3 seconds\", \"make it square for tiktok\", \"2x speed\", \"add text 'Good vibes' at the top\", \"make it a gif\", \"mute it\" — or ask \"what can you do?\"" + llmFallbackNote()
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null })
      }

      // 2) build the ffmpeg pipeline
      if (!meta.hasAudio && result.ops.some((o) => ['audioOut', 'volume'].includes(o.kind))) {
        const reply = "This version has no audio track (it's a GIF or was muted), so there's nothing to extract or adjust there. Try a visual edit instead — or pin another version with ★."
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null })
      }
      // audio-only source (note: visual edits or mute here make ffmpeg pick
      // zero streams → "Output file does not contain any stream")
      const AUDIO_ONLY_OK = new Set(['trim', 'audioOut', 'volume', 'afilter'])
      if (meta.hasVideo === false && !(result.ops.length && result.ops.every((o) => AUDIO_ONLY_OK.has(o.kind)))) {
        const reply = "That version is audio-only (it's an exported mp3 or an audio upload), so visual edits can't run from here. Pin a video version with ★ and try again — or keep going with audio-only edits like \"louder\", \"extract the audio\" or \"trim\"."
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null })
      }
      makeTextOverlay(result.ops, meta, path.join(JOBS, id), meta.duration)
      const frag = build(result.ops, meta, FONT)

      // 3) enqueue the render — the client watches /api/render for progress
      const { rid } = await enqueueRender(job, id, srcName, frag, result, meta, message)
      const summary = result.summary || frag.desc.join(' + ')
      const queued = renderQueue.length
      const reply = publicReply(`${result.isLLM ? '🤖 (LLM) ' : '🛠 '}Rendering: ${summary} ⏳ (${queued ? `queued — ${queued} render${queued === 1 ? '' : 's'} ahead` : 'starting now'})` + (result.isLLM ? '' : llmFallbackNote()))
      const payload = {
        reply,
        summary,
        ops: frag.desc,
        commands: [],
        engine: result.isLLM ? 'llm' : 'local',
        renderId: rid,
      }
      const reg = renders.get(rid)
      return json(res, 200, reg ? maybeAttachTechnical(reg, payload) : payload)
    }

    // ---- render polling ----
    if (p === '/api/render' && req.method === 'GET') {
      const id = url.searchParams.get('id') || ''
      const rid = url.searchParams.get('rid') || ''
      if (!validJobId(id) || !validJobId(rid)) {
        return json(res, 400, { error: { code: 'BAD_REQUEST', message: 'Invalid render or job id.', retryable: false } })
      }
      const reg = renders.get(rid)
      if (!reg || reg.jobId !== id) return json(res, 404, { error: { code: 'RENDER_NOT_FOUND', message: 'Render not found (server restarted?) — send the edit again', retryable: true } })
      if (reg.status === 'queued') return json(res, 200, { status: 'queued', progress: 0, queuedAhead: Math.max(0, renderQueue.indexOf(rid)) })
      if (reg.status === 'running') return json(res, 200, { status: 'running', progress: reg.progress })
      const facts = renderFacts(reg)
      const payload = {
        status: reg.status,
        progress: reg.progress,
        reply: stripInternalDetails(reg.reply || ''),
        media: reg.media,
        summary: reg.summary,
        ops: reg.ops,
        // structured summary — the same numbers the chat reply is built from
        captions: facts.captions,
        subtitlePosition: facts.subtitlePosition,
        subtitlePositionLabel: facts.subtitlePositionLabel,
        outputDuration: facts.outputDuration,
        audioPreserved: facts.audioPreserved,
        audio: reg.facts?.audio || null,
        detection: facts.detection,
        verification: facts.verification,
        mode: facts.mode,
        success: facts.success,
        // kept for API compatibility; only populated in explicit debug mode
        commands: [],
      }
      return json(res, 200, maybeAttachTechnical(reg, payload))
    }

    if (p === '/api/job' && req.method === 'GET') {
      const id = url.searchParams.get('id') || ''
      if (!validJobId(id)) return json(res, 400, { error: { code: 'BAD_JOB_ID', message: 'Invalid job id.', retryable: false } })
      const job = getJob(id)
      if (!job) return json(res, 404, { error: { code: 'UNKNOWN_JOB', message: 'unknown job', retryable: false } })
      return json(res, 200, { versions: job.versions, base: job.base, msgs: job.msgs })
    }

    // pin a version as the edit base (rollback = point base at the past)
    if (p === '/api/version' && req.method === 'POST') {
      const { id, index } = await readJson(req)
      if (!validJobId(id)) return json(res, 400, { error: { code: 'BAD_JOB_ID', message: 'Invalid job id.', retryable: false } })
      const job = getJob(id)
      if (!job) return json(res, 404, { error: { code: 'UNKNOWN_JOB', message: 'unknown job', retryable: false } })
      const i = parseInt(index, 10)
      if (!Number.isInteger(i) || i < 0 || i >= job.versions.length) return json(res, 400, { error: 'bad version index' })
      job.base = i
      await saveJob(job, id)
      console.log(`[ai-studio] job ${id} base → v${i + 1} (${job.versions[i].name})`)
      return json(res, 200, { ok: true, base: i })
    }

    // delete a job and all its media
    if (p === '/api/job' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') || ''
      if (!validJobId(id)) return json(res, 400, { error: { code: 'BAD_JOB_ID', message: 'Invalid job id.', retryable: false } })
      history.delete(id)
      // fail any pending renders for this job
      for (const reg of renders.values()) {
        if (reg.jobId !== id || reg.status === 'done' || reg.status === 'failed') continue
        reg.status = 'failed'
        reg.reply = '⚠️ This job was deleted while the render was running.'
        try { reg.proc?.kill('SIGKILL') } catch { /* already gone */ }
      }
      try { await fsp.rm(path.join(JOBS, id), { recursive: true, force: true }) } catch { /* fine */ }
      console.log(`[ai-studio] deleted job ${id}`)
      return json(res, 200, { ok: true })
    }

    // ---- filmstrip (powers the visual trim picker) ----
    if (p === '/api/strip' && req.method === 'GET') {
      const id = url.searchParams.get('id') || ''
      if (!validJobId(id)) return json(res, 400, { error: { code: 'BAD_JOB_ID', message: 'Invalid job id.', retryable: false } })
      const job = getJob(id)
      if (!job) return json(res, 404, { error: { code: 'UNKNOWN_JOB', message: 'unknown job', retryable: false } })
      const vName = url.searchParams.get('v') && job.versions.some((v) => v.name === url.searchParams.get('v'))
        ? url.searchParams.get('v') : job.versions[job.base].name
      const src = path.join(JOBS, id, vName)
      let st
      try { st = await fsp.stat(src) } catch { return json(res, 404, { error: 'version file missing' }) }
      const meta = await probe(src)
      const dur = meta.duration
      if (!dur || dur < 0.3) return json(res, 400, { error: 'clip too short for a filmstrip' })
      const cacheName = `strip-${vName}.jpg`
      const cachePath = path.join(JOBS, id, cacheName)
      let have = true
      try { fs.accessSync(cachePath) } catch { have = false }
      if (!have) {
        const N = 12
        const fpsVal = Math.max(0.2, Math.min(N / dur, 30)).toFixed(4)
        const r = await run(FFMPEG, ['-y', '-hide_banner', '-i', src, '-vf', `fps=${fpsVal},scale=160:-2,tile=4x3`, '-frames:v', '1', cachePath], 90000)
        if (!r.ok) return json(res, 500, { error: 'filmstrip extraction failed' })
      }
      return json(res, 200, { url: `/media/${id}/${encodeURIComponent(cacheName)}`, duration: dur, version: vName })
    }

    // ---- tool dispatch (Android Skills) ------------------------------------
    if (p === '/api/tool' && req.method === 'POST') {
      const body = await readJson(req)
      const { id, tool } = body
      if (!validJobId(id)) return json(res, 400, { error: { code: 'BAD_JOB_ID', message: 'Invalid job id.', retryable: false } })
      if (tool !== 'detect_scenes') {
        return json(res, 400, {
          error: { code: 'TOOL_UNSUPPORTED', message: `Tool "${String(tool || '')}" is not supported.`, retryable: false },
        })
      }
      const job = getJob(id)
      if (!job) return json(res, 404, { error: { code: 'UNKNOWN_JOB', message: 'Unknown job.', retryable: false } })
      const srcName = job.versions[job.base].name
      const src = path.join(JOBS, id, srcName)
      const meta = await probe(src)
      if (!meta.hasVideo || meta.probeFailed) {
        return json(res, 422, {
          error: { code: 'TOOL_MEDIA_INVALID', message: 'Scene detection needs a readable video version.', retryable: false },
        })
      }
      try {
        const detected = await detectSceneCuts(src, body.args || {})
        return json(res, 200, {
          result: {
            scenes: detected.scenes.map((time) => ({ time })),
            threshold: detected.threshold,
            count: detected.scenes.length,
          },
        })
      } catch (e) {
        console.error('[ai-studio] scene detection failed:', e.message)
        return json(res, 500, {
          error: { code: 'TOOL_FAILED', message: 'Scene detection failed for this clip.', retryable: true },
        })
      }
    }

    // ---- captions: paste script → silence-timed burn-in, or auto-transcribe ----
    // Request fields (all optional, existing shape still works):
    //   position   one of POSITIONS (top_center … bottom_right)
    //   style      { fontSize, fontFamily, textColor, outlineWidth, background,
    //                backgroundOpacity, maxLines, safeMarginX, safeMarginY }
    //   mode       'add' (default) | 'replace' (obscure burned-in captions first)
    //   instructions  free-form text; an explicit position inside it wins
    if (p === '/api/captions' && req.method === 'POST') {
      const body = await readJson(req)
      const { id, text, auto, instructions, layer } = body
      if (!validJobId(id)) return json(res, 400, { error: { code: 'BAD_JOB_ID', message: 'Invalid job id.', retryable: false } })
      const job = getJob(id)
      if (!job) return json(res, 404, { error: { code: 'UNKNOWN_JOB', message: 'unknown job — upload a clip first', retryable: false } })
      const srcName = job.versions[job.base].name
      const src = path.join(JOBS, id, srcName)
      const meta = await probe(src)
      if (!meta.hasAudio) {
        const reply = "That version has no audio track, so I can't caption speech here. Pin a version with sound (★) or upload the clip with audio."
        job.msgs.push({ role: 'user', content: 'add captions' }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null })
      }
      if (meta.hasVideo === false) {
        const reply = "That version is audio-only, so there's nothing to burn captions onto. Pin the video version with ★ first."
        job.msgs.push({ role: 'user', content: 'add captions' }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null })
      }

      // ---- resolved caption layout (position + style + wrapping budget) ----
      const parsedInstructions = parseSubtitleInstructions(instructions)
      const layout = resolveCaptionLayout({
        instructions,
        position: body.position,
        style: body.style,
        layer,
      }, meta)
      if (layout.warnings.length) {
        console.log(`[ai-studio] captions ${id}: ${layout.warnings.join(' | ')}`)
      }
      // Add vs Replace: an explicit UI choice is honoured, but subtitle-specific
      // wording in the instructions can never be silently dropped.
      const fieldMode = normalizeMode(body.mode)
      const mode = parsedInstructions.explicitMode ? parsedInstructions.mode : (fieldMode || 'add')
      if (fieldMode && parsedInstructions.explicitMode && fieldMode !== parsedInstructions.mode) {
        layout.warnings.push(`request asked to ${fieldMode} while the instruction asked to ${parsedInstructions.mode} — following the instruction`)
      }

      let placed = null
      let captionSource = ''
      let userMsg = ''
      if (auto) {
        // ---- STT path: extract a small mono audio track, transcribe, burn ---
        const audioName = `stt-${srcName.replace(/\W+/g, '_')}.mp3`
        const audioPath = path.join(JOBS, id, audioName)
        let have = true
        try { fs.accessSync(audioPath) } catch { have = false }
        if (!have) {
          const r = await run(FFMPEG, ['-y', '-hide_banner', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-map', 'a:0', audioPath], 300000)
          if (!r.ok) {
            return json(res, 500, {
              error: { code: 'STT_AUDIO_EXTRACTION_FAILED', message: 'Could not extract the audio track for transcription.', retryable: true },
            })
          }
        }
        let stt
        try {
          stt = await transcribeAudio(audioPath, { maxBytes: 20 * 1024 * 1024 }, { instructions })
        } catch (e) {
          const status = e instanceof SttError ? e.status : 502
          const payload = sttErrorPayload(e)
          console.log(`[ai-studio] auto-captions ${id}: ${payload.error.code} (${payload.error.provider || 'no provider'})`)
          job.msgs.push({ role: 'user', content: 'auto-transcribe captions' }, { role: 'assistant', content: payload.reply })
          await saveJob(job, id)
          return json(res, status, payload)
        }
        placed = normalizeTranscriptCues(stt.cues, meta, {
          maxChars: layout.maxChars,
          maxLines: layout.maxLines,
        })
        if (!placed.length) {
          const empty = new SttError('STT_EMPTY_TRANSCRIPT',
            'The speech provider returned no usable caption cues for this clip.',
            { provider: stt.provider, model: stt.model })
          const payload = sttErrorPayload(empty)
          console.log(`[ai-studio] auto-captions ${id}: empty transcript from ${stt.provider}/${stt.model}`)
          job.msgs.push({ role: 'user', content: 'auto-transcribe captions' }, { role: 'assistant', content: payload.reply })
          await saveJob(job, id)
          return json(res, empty.status, payload)
        }
        console.log(`[ai-studio] auto-captions ${id}: ${placed.length} cue(s) from ${stt.provider}/${stt.model}`)
        userMsg = '🎙 auto-transcribe and caption the spoken words'
      } else {
        // ---- pasted-script path ---------------------------------------------
        const script = String(text || '').slice(0, 5000)
        const cues = buildCues(script, { maxChars: layout.maxChars, maxLines: layout.maxLines })
        if (!cues.length) return json(res, 400, { reply: 'Give me at least one line of script text to caption.' })
        const segs = await speechSegments(src, meta)
        placed = placeCues(cues, segs)
        if (!placed.length) return json(res, 400, { reply: 'No speech segments found — the clip may be all music/silence. Try a manual text overlay instead.' })
        userMsg = `add captions:\n${script.slice(0, 400)}${script.length > 400 ? '…' : ''}`
        captionSource = ` on ${segs.length} detected speech segment${segs.length === 1 ? '' : 's'}`
      }

      // ---- replace mode: detect + obscure existing burned-in subtitles -----
      let detection = null
      let obscure = null
      if (mode === 'replace') {
        detection = await detectBurnedInSubtitles(FFMPEG, src, meta, { samples: 24 })
        if (detection.found && detection.band) {
          obscure = buildObscureGraph(detection.band, meta)
          console.log(`[ai-studio] captions ${id}: burned-in band ${JSON.stringify(obscure.band)} confidence ${detection.confidence}`)
        } else {
          console.log(`[ai-studio] captions ${id}: no burned-in subtitles to obscure — ${detection.reason}`)
        }
      } else {
        detection = {
          found: false,
          skipped: true,
          reason: 'add mode never modifies existing video content, so burned-in text was left untouched',
        }
      }

      const caption = buildCaptionRender({
        placed,
        meta,
        dir: path.join(JOBS, id),
        layout,
        mode,
        detection,
        layer: layout.layer,
      })
      const { frag } = caption
      frag.facts = caption.facts
      frag.verify = caption.verify
      const captionCount = placed.length
      const summary = caption.summary

      const renderResult = { summary, ops: frag.desc }
      const render = await enqueueRender(job, id, srcName, frag, renderResult, meta, userMsg)
      const { rid } = render
      const positionText = caption.positionLabel
      const reply = publicReply(
        `💬 ${caption.obscure ? 'Replacing the old subtitles and placing' : 'Placing'} ${captionCount} caption${captionCount === 1 ? '' : 's'} at ${positionText}` +
        `${auto ? ' from the transcribed speech' : captionSource} — rendering ⏳`,
      )
      job.msgs.push({ role: 'user', content: userMsg }, { role: 'assistant', content: reply + ' (started)' })
      await saveJob(job, id)
      return json(res, 200, {
        reply,
        renderId: rid,
        summary,
        ops: frag.desc,
        commands: [],
        captions: captionCount,
        position: layout.position,
        positionLabel: positionText,
        alignment: layout.alignment,
        positionSource: layout.positionSource,
        mode,
        detection,
        style: {
          fontSize: layout.style.fontSize,
          fontFamily: resolveFontFamily(layout.style, placed.map((c) => c.text).join(' ')),
          maxLines: layout.style.maxLines,
          safeMarginX: layout.style.safeMarginX,
          safeMarginY: layout.style.safeMarginY,
        },
        warnings: layout.warnings,
      })
    }

    return send(res, 404, 'not found')
  } catch (e) {
    console.error(e)
    const status = Number(e.status) >= 400 && Number(e.status) < 600 ? Number(e.status) : 500
    const code = typeof e.code === 'string' && /^[A-Z0-9_]+$/.test(e.code) ? e.code : 'INTERNAL_ERROR'
    // Never leak internal paths/filter text to ordinary clients.
    const message = status < 500
      ? String(e.message || 'The request could not be completed.')
      : 'The server could not complete this request. Try again shortly.'
    try { json(res, status, { error: { code, message, retryable: status >= 500 || status === 429 } }) } catch { /* headers sent */ }
  }
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`\n  🎬 AI Clip Studio  →  http://localhost:${PORT}`)
  console.log(AUTH_TOKEN
    ? '[ai-studio] 🔒 access locked by AUTH_TOKEN — enter it in the browser to start'
    : '[ai-studio] 🔓 no AUTH_TOKEN set — open access (set AUTH_TOKEN in .env to lock)')
  console.log(`[ai-studio] job cleanup every 30 min, TTL ${Math.round(JOBS_TTL_MS / 3600000)}h | render concurrency: ${RENDER_CONCURRENCY}\n`)
})
setInterval(cleanupJobs, 30 * 60 * 1000).unref()
cleanupJobs()
rehydrateRenders()
