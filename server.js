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
// Handles CRLF, a UTF-8 BOM, `export KEY=...`, quoted values and trailing
// `# comments` — a stray quote or comment used to silently corrupt the key.
{
  const envPath = __dirname + '/.env'
  try {
    const raw = require('fs').readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '')
    for (let line of raw.split(/\r?\n/)) {
      line = line.trim()
      if (!line || line.startsWith('#')) continue
      line = line.replace(/^export\s+/, '')
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!m) continue
      let val = m[2].trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      } else {
        val = val.replace(/\s+#.*$/, '').trim()
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val
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
const { execFile, spawn, execFileSync } = require('child_process')
const {
  understand, understandWithLLM, build, makeTextOverlay, makeCaptionAss,
  buildCues, placeCues, transcribeAudio, normalizeTranscriptCues, getLlmHealth, getLlmInfo,
} = require('./ai')
const ai = require('./ai') // named above; used by the caption pipeline (provider handoff)
const timeline = require('./timeline')
const tools = require('./tools')
const captions = require('./caption') // "replace existing subtitles" orchestration
const skillsModule = require('./skills') // Native Android Skills API contract

const ROOT = __dirname
const PUBLIC = path.join(ROOT, 'public')
const JOBS = path.join(ROOT, 'jobs')
// caption detection / whisper transcription / validation budget per chat op
const PY_CAPTION_TMO = Number(process.env.CAPTION_PY_TIMEOUT_MS) || 600000
const MAX_UPLOAD = 1024 * 1024 * 1024 // 1 GB
const RENDER_CONCURRENCY = 1 // serialize renders: one ffmpeg at a time

fs.mkdirSync(JOBS, { recursive: true })

// --- locate ffmpeg/ffprobe --------------------------------------------------
// Binaries are vendored per-arch: ffmpeg-amd64 (Render x64) / ffmpeg-arm64.
// Falls back to a plain vendor/ffmpeg, then to whatever is on PATH.
const ARCH = process.arch === 'x64' ? 'amd64' : process.arch
let FFMPEG = path.join(ROOT, 'vendor', `ffmpeg-${ARCH}`)
let FFPROBE = path.join(ROOT, 'vendor', `ffprobe-${ARCH}`)
try {
  fs.accessSync(FFMPEG, fs.constants.X_OK)
  fs.accessSync(FFPROBE, fs.constants.X_OK)
} catch {
  FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg')
  FFPROBE = path.join(ROOT, 'vendor', 'ffprobe')
  try {
    fs.accessSync(FFMPEG, fs.constants.X_OK)
    fs.accessSync(FFPROBE, fs.constants.X_OK)
  } catch {
    FFMPEG = 'ffmpeg'
    FFPROBE = 'ffprobe'
  }
}

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
const fonts = require('./fonts')

let FFMPEG_OK = null
execFile(FFMPEG, ['-version'], { timeout: 15000 }, (err, stdout) => {
  FFMPEG_OK = !err
  console.log(err ? `[ai-studio] ffmpeg check FAILED: ${err.message}` : `[ai-studio] ffmpeg OK — ${String(stdout).split('\n')[0]}`)
})
console.log(`[ai-studio] ffmpeg: ${FFMPEG}${FONT ? ` | font: ${FONT}` : ' | font: none (text overlays need fontconfig/default font)'}`)
const FONT_DIAG = fonts.fontDiagnostics()
console.log(`[ai-studio] fonts: thai=${FONT_DIAG.thai.family || 'MISSING'} (${FONT_DIAG.thai.source || FONT_DIAG.thai.error})` +
  ` | latin=${FONT_DIAG.latin.family || 'MISSING'} (${FONT_DIAG.latin.source})` +
  ` | fontconfig=${FONT_DIAG.fontconfigAvailable ? 'yes' : 'no'} | vendored=${FONT_DIAG.vendorFontsExist ? FONT_DIAG.vendorFontsDir : 'no'}`)

// --- python processing service (moviepy / opencv / pillow / librosa / whisper /
// opentimelineio / lottie). Spawned once on boot; every capability degrades
// independently — /api/health reports what the python side actually offers. ---
const PY_PORT = Number(process.env.PY_SERVICE_PORT) || 8611
const pyCache = new Map() // module gate — prevents double-spawn on overlapping calls
let pySpawned = false

function pyCall(ep, payload = {}, timeoutMs = 300000) {
  return fetch(`http://127.0.0.1:${PY_PORT}/${ep}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
    .then(async (r) => {
      let j = null
      try { j = await r.json() } catch { throw new Error(`python service '${ep}' returned http ${r.status}`) }
      if (!j.ok) throw new Error(j.error || `python service '${ep}' failed`)
      return j
    })
    .catch((e) => {
      throw new Error(`python service unavailable: ${e.message}`)
    })
}

function pyInterpreter() {
  // probe candidates and pick the one that actually has the deps: the system
  // interpreter often lacks opencv/moviepy while the repo .venv has them (and
  // vice versa on Termux, where manylinux wheels only install system-wide)
  const cands = []
  if (process.env.PYTHON) cands.push(process.env.PYTHON)
  const venv = path.join(ROOT, '.venv', 'bin', 'python')
  if (fs.existsSync(venv)) cands.push(venv)
  if (fs.existsSync('/usr/bin/python3')) cands.push('/usr/bin/python3')
  cands.push('python3')
  for (const bin of cands) {
    try {
      execFileSync(bin, ['-c', 'import common, cv2, moviepy, audio_ops, vision_ops'],
        { timeout: 30000, cwd: path.join(ROOT, 'py') })
      return bin
    } catch { /* next candidate */ }
  }
  return process.env.PYTHON || (fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3')
}

function startPythonService() {
  if (pySpawned || process.env.PY_SERVICE_DISABLED === '1') return
  pySpawned = true
  const bin = pyInterpreter()
  const child = spawn(bin, [path.join(ROOT, 'py', 'service.py')], {
    env: { ...process.env, PY_SERVICE_PORT: String(PY_PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  child.on('error', (e) => console.warn(`[ai-studio] python service failed to start (${e.message}) ` +
    '— moviepy/opencv/librosa/whisper/otio features are degraded this run'))
  child.on('exit', (code) => {
    if (code && code !== 0) console.warn(`[ai-studio] python service exited (code ${code})`)
  })
}

// quick availability probe used by /api/health and the capability tour
async function pyHealth() {
  try {
    const j = await pyCall('health', {}, 2000)
    return { up: true, modules: j.modules || {} }
  } catch (e) {
    return { up: false, error: e.message }
  }
}

// make it obvious at boot whether the AI brain (LLM key) is actually wired up
const AI_INFO = getLlmInfo()
if (AI_INFO) {
  console.log(`[ai-studio] AI brain: ${AI_INFO.provider} (${AI_INFO.model})${AI_INFO.vision ? ' + vision' : ''}`)
} else {
  console.warn('[ai-studio] ⚠ no LLM key found — free-form requests will use the limited offline engine. Put GEMINI_API_KEY (or OPENAI_API_KEY / OPENROUTER_API_KEY / GROQ_API_KEY / OPENCODE_API_KEY / ANTHROPIC_API_KEY) in .env or the environment.')
}

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
  if (!j) return { duration: null, width: null, height: null, hasVideo: true, hasAudio: true, fps: 30 }
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
  }
  return meta
}

// --- timeline bootstrap: every job gets a timeline mirroring its base version.
// runTool() keeps it authoritative; ffmpeg+Remotion renders materialize it. ---
function buildInitialTimeline(job, jobId) {
  const v0 = job.versions[0]
  const dur = Math.max(0.5, v0.meta?.duration || 1)
  const tl = timeline.newTimeline({
    id: jobId,
    fps: v0.meta?.fps || 30,
    width: v0.meta?.width || null,
    height: v0.meta?.height || null,
    name: job.original || v0.name.replace(/^input\./, ''),
  })
  const kind = v0.meta?.hasVideo === false ? 'audio' : 'video'
  const tr = timeline.newTrack(kind, kind === 'video' ? 'V1' : 'A1', 0)
  tl.tracks = [tr]
  try {
    timeline.addClip(tl, {
      trackId: tr.id,
      asset: v0.name,
      kind,
      name: 'source',
      duration: dur,
      sourceDuration: dur,
      fromVersion: v0.name,
    }, null)
  } catch { /* never block an upload on timeline bootstrap */ }
  return tl
}

function toTimelineNote(job) {
  if (!job.timeline) return ''
  const d = timeline.timelineDuration(job.timeline)
  const nClips = job.timeline.tracks.reduce((a, t) => a + t.clips.length, 0)
  return `\n\n🎞 Timeline now: ${nClips} clip${nClips === 1 ? '' : 's'}, ${d}s. Run \`render_timeline\` to materialize it into MP4.`
}

// --- structured AI tool execution --------------------------------------------
// POST /api/tool {id, tool, args} runs one tool from tools.js against
// job.timeline. Non-rendering tools mutate only the timeline (saved
// immediately); render_timeline registers as a new version on settle.
async function runTool(jobId, name, args) {
  const job = getJob(jobId)
  if (!job) throw Object.assign(new Error('unknown job — upload a clip first'), { status: 404 })
  const tool = tools.getTool(name)
  if (!tool) throw Object.assign(
    new Error(`unknown tool '${name}' — see GET /api/tools`), { status: 400 })
  if (!job.timeline) job.timeline = buildInitialTimeline(job, jobId)
  const baseName = job.versions[job.base].name
  const baseMeta = job.versions[job.base].meta || {}
  const ctx = {
    tl: job.timeline,
    dir: path.join(JOBS, jobId),
    meta: {
      versionName: baseName,
      duration: baseMeta.duration || 0,
      width: baseMeta.width || 0,
      height: baseMeta.height || 0,
      hasAudio: baseMeta.hasAudio !== false,
      hasVideo: baseMeta.hasVideo !== false,
    },
    py: (ep, payload, tmo) => pyCall(ep, payload, tmo || 300000),
    changed: false,
  }
  const result = await tool.fn(ctx, args || {})
  if (ctx.changed) await saveJob(job, jobId)
  if (result && result.rendered) {
    // render_timeline just wrote a new file into the job dir — enroll it as a
    // version (same reconciliation the ffmpeg external-render path uses)
    setTimeout(() => {
      const j2 = getJob(jobId)
      if (j2) syncExternalRenders(j2, jobId)
    }, 500)
  }
  return { tool: name, result, timeline: timeline.summarize(job.timeline) }
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

// --- external render sync ------------------------------------------------------
// "External" runs (the same ffmpeg commands shown in chat, executed in a
// terminal) drop outputs into jobs/<id>/ like every render, but only
// startRender() ever appended to job.versions — so the website kept showing the
// old version count. This reconciliation enrolls any new media file as a
// version: probes it, generates a thumbnail, advances job.next so later in-app
// renders can't collide with out-N names, and keeps base on the newest video.
const MEDIA_EXT = /\.(mp4|mov|webm|mkv|m4v|mp3|wav|m4a|aac|ogg|flac|gif)$/i
const syncing = new Set() // jobId → one reconciliation at a time
async function syncExternalRenders(job, id) {
  if (syncing.has(id)) return
  syncing.add(id)
  try {
    const dir = path.join(JOBS, id)
    let dirMtime
    try { dirMtime = (await fsp.stat(dir)).mtimeMs } catch { return }
    if (dirMtime === job.syncedDirMtime) return // folder unchanged since last sync
    const entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile())
    // outputs owned by renders still queued/running (or waiting rehydrate after
    // a restart) belong to startRender — enrolling them here would double-register
    const inFlight = new Set()
    for (const reg of renders.values()) if (reg.jobId === id && reg.status !== 'done' && reg.status !== 'failed') inFlight.add(reg.outName)
    try {
      const pend = JSON.parse(await fsp.readFile(path.join(dir, 'pending.json'), 'utf8'))
      if (pend && pend.outName) inFlight.add(String(pend.outName))
    } catch { /* no waiting render */ }
    const known = new Set(job.versions.map((v) => v.name))
    let added = 0
    for (const e of entries) {
      if (!MEDIA_EXT.test(e.name) || known.has(e.name)) continue
      if (/^input\./i.test(e.name) || inFlight.has(e.name)) continue // original upload / mid-render output
      if (/^stt-/i.test(e.name)) continue // caption-pipeline STT side track, not a version
      const abs = path.join(dir, e.name)
      const meta = await probe(abs)
      const thumbName = `thumb-${e.name}.jpg`
      const thumbOk = await makeThumb(dir, abs, thumbName)
      job.versions.push({
        name: e.name,
        desc: 'external ffmpeg render',
        thumb: thumbOk ? `/media/${id}/${encodeURIComponent(thumbName)}` : null,
        meta: { duration: meta.duration, width: meta.width, height: meta.height, hasVideo: meta.hasVideo, hasAudio: meta.hasAudio, fps: meta.fps },
      })
      const n = e.name.match(/^out-(\d+)\./)
      if (n) job.next = Math.max(job.next || 1, +n[1] + 1)
      added++
      console.log(`[ai-studio] synced external render ${id}/${e.name} → v${job.versions.length}`)
    }
    if (added) {
      // mirror startRender: edit base stays on the newest VIDEO version
      const last = job.versions[job.versions.length - 1]
      if (last && last.meta?.hasVideo !== false) job.base = job.versions.length - 1
      sseBroadcast('versions', { jobId: id, added })
    }
    // dir mtime moves when thumbnails/job.json get written — re-stat to record
    // the settled value, then persist so unchanged folders skip this entirely
    job.syncedDirMtime = (await fsp.stat(dir)).mtimeMs
    await saveJob(job, id)
  } catch (e) {
    console.error(`[ai-studio] external render sync failed for job ${id}: ${e.message}`)
  } finally {
    syncing.delete(id)
  }
}

// --- async render pipeline ----------------------------------------------------
// Renders are enqueued with progress; one ffmpeg runs at a time, the rest queue.
// The chat endpoint answers immediately; the client polls /api/render?id&rid.

const renders = new Map()      // rid → registry entry
const renderQueue = []         // rids waiting while another render runs
let activeRuns = 0

// --- live events (SSE) ---------------------------------------------------------
// Open tabs subscribe to /api/render-events: render status/progress and version
// list changes push out here, so the UI reacts without any polling.
const sseClients = new Set()
function sseBroadcast(evName, data) {
  if (!sseClients.size) return
  const chunk = `event: ${evName}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try { res.write(chunk) } catch { sseClients.delete(res) }
  }
}

// user message → done/failed replies are appended to the chat history when the
// render settles, so /api/job stays consistent with what was actually made.
// A pending.json marker survives server restarts: rehydrateRenders() re-queues
// the interrupted render on boot (or reports it as failed if the source is gone).
async function enqueueRender(job, jobId, srcName, frag, result, meta, userMsg) {
  const src = path.join(JOBS, jobId, srcName)
  const outName = `out-${job.next++}.${frag.output}`
  const outPath = path.join(JOBS, jobId, outName)

  const args = ['-y', '-hide_banner', '-progress', 'pipe:1', '-nostats']
  if (frag.seek && (frag.seek.from != null || frag.seek.to != null)) {
    // fast-seek: -ss before -i stays frame-accurate for re-encode output
    if (frag.seek.from != null) args.push('-ss', String(frag.seek.from))
    args.push('-i', src)
    if (frag.seek.to != null) args.push('-t', String(Math.max(0.05, frag.seek.to - (frag.seek.from || 0))))
  } else {
    args.push('-i', src)
  }
  // overlay/b-roll inputs appended after the main input's options; each becomes
  // input index 1..n referenced by the composed filter graph
  for (const rel of frag.overlayInputs || []) args.push('-i', path.join(JOBS, jobId, rel))
  if (frag.complex) {
    args.push('-filter_complex', frag.complex)
    // caption pipeline ends in a labeled [vout]; explicit maps select it plus
    // the untouched original audio ("-map 0:a? -c:a copy" — never re-encodes
    // or filters speech when the user keeps the voiceover)
    if (frag.audioMap) args.push('-map', '[vout]', '-map', frag.audioMap)
  } else {
    if (frag.vf.length) args.push('-vf', frag.vf.join(','))
    if (frag.af.length) args.push('-af', frag.af.join(','))
  }
  if (frag.output === 'mp4') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-movflags', '+faststart', '-pix_fmt', 'yuv420p')
    if (frag.audioEncode) args.push('-c:a', 'aac', '-b:a', '160k')
    else if (frag.af.length) args.push('-c:a', 'aac', '-b:a', '160k')
    else if (meta.hasAudio && !frag.extraArgs.includes('-an')) args.push('-c:a', 'copy')
  }
  if (frag.output === 'mp3') args.push('-vn')
  args.push(...frag.extraArgs, outPath)

  const cmdDisplay = `ffmpeg ${args.map((a) => (/[\s'"]/.test(a) && a !== outPath && !a.startsWith('-') ? `"${a}"` : a)).join(' ')}`

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
  }
  renders.set(rid, reg)
  renderQueue.push(rid)
  sseBroadcast('render', { jobId, rid, status: 'queued', progress: 0, queuedAhead: Math.max(0, renderQueue.length - 1) })
  try {
    await fsp.writeFile(path.join(JOBS, jobId, 'pending.json'), JSON.stringify({
      rid, srcName, args, cmdDisplay, outPath, outName,
      summary: reg.summary, ops: reg.ops, userMsg, fromIndex: job.base,
      expected, createdAt: Date.now(),
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
  sseBroadcast('render', { jobId: reg.jobId, rid: reg.rid, status: 'running', progress: 0 })
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
    // hard stop at 15 min — must KILL ffmpeg too, or a hung burn-in keeps the
    // decoder/encoder (and the render slot) alive forever after we resolve
    const watchdog = setTimeout(() => {
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
      // coarsed progress ticks over SSE (10% buckets — avoids event spam)
      const tier = Math.floor(reg.progress / 10)
      if (reg.lastPctSent !== tier) {
        reg.lastPctSent = tier
        sseBroadcast('render', { jobId: reg.jobId, rid: reg.rid, status: 'running', progress: reg.progress | 0 })
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

  // Subtitle-pipeline failure diagnosis: turn libass/ffmpeg stderr into an
  // actionable hint instead of a bare exit code.
  function classifyRenderFailure(tail) {
    const t = String(tail || '')
    if (/fontselect|Fontconfig error|failed to find any fallback|font provider|Cannot find font/i.test(t)) {
      return 'Font problem: libass could not resolve the subtitle font. Check /api/health → fonts, install Noto Sans Thai (see fonts.js INSTALL_HINTS), then retry.'
    }
    if (/ass_read|Could not.*\.ass|Error parsing.*ass|Invalid.*ass\b|Error initializing filter subtitles/i.test(t)) {
      return 'The generated ASS subtitle file is invalid — the ASS generator, not ffmpeg, is at fault.'
    }
    if (/No such file or directory|Unable to open/i.test(t)) {
      return /subtitles|\.ass/i.test(t)
        ? 'A subtitle file referenced by the render is missing (deleted temp .ass?). Re-run the edit; generation and burn happen in one pass.'
        : 'A file referenced by the render is missing.'
    }
    if (/Error initializing filter|Error while initializing filter|Invalid argument/i.test(t)) {
      return 'FFmpeg rejected part of the filter graph.'
    }
    return null
  }

  const fail = (reg, errTail) => {
    const hint = classifyRenderFailure(errTail)
    reg.status = 'failed'
    reg.reply = `⚠️ The edit failed while rendering:\n\n${errTail || 'unknown ffmpeg error'}\n\nAsk me differently and I'll retry.` +
      (hint ? `\n\nℹ️ ${hint}` : '')
    sseBroadcast('render', { jobId: reg.jobId, rid: reg.rid, status: 'failed', progress: reg.progress })
  }
  fsp.rm(path.join(JOBS, reg.jobId, 'pending.json'), { force: true }).catch(() => {})
  if (code === 0) {
    const outMeta = await probe(reg.outPath)
    const thumbName = `thumb-${reg.outName}.jpg`
    const thumbOk = await makeThumb(path.join(JOBS, reg.jobId), reg.outPath, thumbName)
    reg.media = { url: `/media/${reg.jobId}/${encodeURIComponent(reg.outName)}`, ...outMeta, name: reg.outName }
    reg.thumb = thumbOk ? `/media/${reg.jobId}/${encodeURIComponent(thumbName)}` : null
    reg.progress = 100
    reg.status = 'done'
    sseBroadcast('render', { jobId: reg.jobId, rid: reg.rid, status: 'done', progress: 100 })

    const job = getJob(reg.jobId)
    if (job) {
      const vN = job.versions.length + 1
      reg.reply =
        `${reg.fromIndex === job.versions.length - 1 ? '✅' : '✅ (from v' + (reg.fromIndex + 1) + ')'} Done — ${reg.summary}.` +
        `${outMeta.duration ? ` New length: ${outMeta.duration}s.` : ''} I ran:\n\n\`${reg.cmdDisplay}\`\n\nWhat's next?`
      job.versions.push({ name: reg.outName, desc: reg.summary, thumb: reg.thumb, meta: { duration: outMeta.duration, width: outMeta.width, height: outMeta.height, hasVideo: outMeta.hasVideo, hasAudio: outMeta.hasAudio, fps: outMeta.fps } })
      // audio-only outputs (exported mp3) become a version, but the edit base
      // must stay on video — editing "from" an mp3 is what caused
      // "Output file does not contain any stream" render failures
      if (outMeta.hasVideo !== false) job.base = job.versions.length - 1
      job.msgs.push({ role: 'user', content: reg.userMsg }, { role: 'assistant', content: reg.reply })
      await saveJob(job, reg.jobId)
      console.log(`[ai-studio] render ${reg.jobId}/${reg.outName} done → v${vN}`)
    }
  } else {
    await fsp.rm(reg.outPath, { force: true }).catch(() => {})
    fail(reg, errTail)
    const job = getJob(reg.jobId)
    if (job) {
      job.msgs.push({ role: 'user', content: reg.userMsg }, { role: 'assistant', content: reg.reply })
      await saveJob(job, reg.jobId)
    }
    console.log(`[ai-studio] render ${reg.jobId}/${reg.outName} FAILED:\n${errTail}`)
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
      renders.set(pend.rid, {
        rid: pend.rid, jobId: id, status: 'queued', progress: 0,
        srcName: pend.srcName, args: pend.args, cmdDisplay: pend.cmdDisplay,
        outPath: pend.outPath, outName: pend.outName,
        summary: pend.summary || '', ops: pend.ops || [],
        userMsg: pend.userMsg, fromIndex: pend.fromIndex ?? null,
        expected: pend.expected || 0, proc: null, media: null, thumb: null, reply: null,
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
  if (!h.aiKey) {
    return '\n\nℹ️ No AI key is configured, so this was handled by the built-in offline engine (limited). Add GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, OPENCODE_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) to .env or the environment and restart to unlock free-form editing.'
  }
  if (h.reachable === true) return ''
  if (!h.lastErrorAt) {
    return '\n\nℹ️ The AI key is set but the model has not answered yet — the offline engine handled this. Check the server log for the LLM error.'
  }
  if (now - h.lastErrorAt > 2 * 60 * 1000) return ''
  const detail = h.lastError ? ` (${String(h.lastError).slice(0, 200)})` : ''
  return `\n\nℹ️ The AI service call failed${detail}. This answer came from the built-in offline engine, so more exotic requests may not be understood. Check the configured key and its model override, then restart.`
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
        ok: true, ffmpeg: FFMPEG, ffmpegOk: FFMPEG_OK,
        aiKey: getLlmHealth().aiKey,
        ai: getLlmInfo(),
        llm: getLlmHealth(),
        auth: !!AUTH_TOKEN,
        renders: { active: activeRuns, queued: renderQueue.length, concurrency: RENDER_CONCURRENCY },
        // recomputed per request: after installing a font, health reflects it
        // without a server restart (fc-list itself stays memoized)
        fonts: await Promise.resolve(fonts.fontDiagnostics()),
        python: await pyHealth(),
        // Native Android (FirstMobileApp) Skill API contract — both behaviors
        // are implemented server-side (skills.js + ai.js planner context).
        capabilities: skillsModule.HEALTH_CAPABILITIES,
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
        if (!job) continue
        await syncExternalRenders(job, name) // pick up ffmpeg runs done outside the app
        if (!Array.isArray(job.versions) || !job.versions.length) continue
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
      const fname = `input.${ext}`
      await fsp.rename(tmp, path.join(dir, fname))
      const meta = await probe(path.join(dir, fname))
      // thumbnail for the first version (cheap, helps the version strip right away)
      const thumbOk = await makeThumb(dir, path.join(dir, fname), `thumb-${fname}.jpg`)
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
      job.timeline = buildInitialTimeline(job, id)
      await saveJob(job, id)
      console.log(`[ai-studio] upload ${id} ← ${file.filename} (${fmtMB(file.size)})`)
      return json(res, 200, { id, meta, url: `/media/${id}/${encodeURIComponent(fname)}`, original: file.filename, timeline: timeline.summarize(job.timeline) })
    }

    // ---- overlay: composite an image/clip on top of the current base version ----
    // multipart (file + from/to/x/y/scale fields); id comes from ?id= because
    // the multipart parser needs the destination before fields arrive
    if (p === '/api/overlay' && req.method === 'POST') {
      const ct = req.headers['content-type'] || ''
      const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
      if (!bm) return json(res, 400, { error: 'expected multipart/form-data' })
      const id = url.searchParams.get('id') || ''
      if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return json(res, 400, { error: 'bad job id' })
      const dir = path.join(JOBS, id)
      const job = getJob(id)
      if (!job) return json(res, 404, { error: 'unknown job — upload a clip first' })
      const tmp = path.join(dir, 'overlay.part')
      let parsed
      try {
        parsed = await parseMultipart(req, (bm[1] || bm[2]).trim(), tmp)
      } catch (e) {
        return json(res, /too large/i.test(e.message) ? 413 : 400, { error: e.message })
      }
      const { file, fields } = parsed
      if (!file || !file.size) return json(res, 400, { error: 'no file received' })
      const srcName = job.versions[job.base].name
      const src = path.join(dir, srcName)
      const meta = await probe(src)
      if (meta.hasVideo === false) {
        return json(res, 400, { error: 'This version is audio-only, so there is nothing to overlay visually. Pin a video version (★) first.' })
      }
      const ext = extOf(file.filename, file.mime)
      const fname = `overlay-${Date.now().toString(36)}.${ext}`
      await fsp.rename(tmp, path.join(dir, fname))
      const from = parseFloat(fields.from)
      const to = parseFloat(fields.to)
      const overlay = {
        file: fname,
        x: fields.x || '(W-w)/2',
        y: fields.y || '(H-h)/2',
        scale: parseInt(fields.scale, 10) || null,
        from: Number.isFinite(from) && from > 0 ? from : null,
        to: Number.isFinite(to) && to > 0 ? to : null,
      }
      const ops = [{ kind: 'overlay', file: fname, label: `overlay ${file.filename}` }]
      const frag = build(ops, meta, FONT, [overlay])
      const summary = `Overlay ${file.filename}${overlay.from != null ? ` starting at ${Math.round(overlay.from * 100) / 100}s` : ''}`
      const userMsg = `🖼 Add overlay ${file.filename}`
      const { rid } = await enqueueRender(job, id, srcName, frag, { ops, summary }, meta, userMsg)
      const reply = `🖼 Overlaid <b>${file.filename}</b> on the base clip${overlay.from != null ? ' (timed start)' : ''} — rendering ⏳`
      job.msgs.push({ role: 'user', content: userMsg }, { role: 'assistant', content: reply + ' (started)' })
      await saveJob(job, id)
      return json(res, 200, { reply, renderId: rid, summary, ops: frag.desc, commands: [] })
    }

    // ---- chat / edit ----
    if (p === '/api/chat' && req.method === 'POST') {
      const { id, message, skills = [], context = [] } = await readJson(req)
      // Native Android Skills API: validate optional `skills` (allowlist) and
      // `context` (bounded user/assistant turns) before anything else —
      // invalid payloads get a hard 400 instead of being silently ignored.
      const skillsErr = skillsModule.validateSkillList(skills)
      if (skillsErr) return json(res, 400, { error: skillsErr })
      const contextErr = skillsModule.validateConversationContext(context)
      if (contextErr) return json(res, 400, { error: contextErr })
      const job = getJob(id)
      if (!job) return json(res, 404, { error: 'unknown job — upload a clip first' })
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
          '🖼 Overlays — the 🖼 Add overlay button puts an image or clip on top (timed = whole length or a range)',
          ' 🗣 Captions — paste your script via the ✨ captions chip and I’ll time it to your speech',
          '🎞 GIF — “make a gif at 15 fps”',
          '⏪ FX — “reverse”, “boomerang”, “blur”, “black and white”, “vintage”',
          '🎨 Color — “brighter”, “more colorful”, “more contrast”',
          '🕐 Versions — click any version below the player to preview it; ★ pins it as the base',
          '🧪 Anything else ffmpeg can do — “add a vignette”, “fade in 1s”, “remove the bass”…',
          '',
          'You can chain edits in one message — e.g. “cut the first 3s, make it square, add text HI at the top”.',
          'You can also just ask questions — “would this work as a TikTok?” and I’ll answer.',
          'Each reply shows the real ffmpeg command it ran.',
        ]
        const reply = 'Here\'s what I can do with your clip:\n' + list.join('\n')
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null })
      }

      // 1) understand the request (LLM if configured, else local engine)
      // When the message smells like a suggestion/advice question AND we have
      // an LLM, sample frames so the model can actually see the clip.
      let frames = null
      if (VISION_RE.test(message) && AI_INFO?.vision) {
        frames = await extractFrames(path.join(JOBS, id), src, srcName)
      }
      // pass job.msgs as-is: understandWithLLM appends the current user message
      // itself (passing concat here would send the message to the model twice).
      // Android may supply bounded context turns; those replace the stored
      // history for this planner call (skills.js bounds them to 12 × 2000).
      const history = context.length ? context : job.msgs
      // planner-side workspace snapshot: the real timeline state the Skills
      // operate on (markers/clips), capped so the system prompt stays bounded
      const timelineContext = job.timeline ? {
        markers: (job.timeline.markers || []).slice(-40),
        tracks: (job.timeline.tracks || []).map((track) => ({
          kind: track.kind,
          name: track.name,
          clips: (track.clips || []).slice(0, 40).map((clip) => ({
            name: clip.name,
            kind: clip.kind,
            timelineStart: clip.timelineStart,
            duration: clip.duration,
          })),
        })),
      } : null
      const workspaceContext = timelineContext
        ? `Current timeline context (JSON): ${JSON.stringify(timelineContext).slice(0, 6000)}`
        : ''
      let result = await understandWithLLM(message, meta, history, frames, skills, workspaceContext)

      // LLM chose a conversational answer (question / advice / chit-chat)
      if (result && result.isChat) {
        const reply = result.reply
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null, engine: 'llm-chat' })
      }

      let unresolved = false
      if (!result) {
        result = understand(message, meta)
        if (!result.ops.length) unresolved = true
      }
      if (unresolved) {
        const reply = "I couldn't turn that into an edit yet. Try phrasing it as an action — e.g. \"remove the first 3 seconds\", \"make it square for tiktok\", \"2x speed\", \"add text 'Good vibes' at the top\", \"make it a gif\", \"mute it\" — or ask \"what can you do?\"" + llmFallbackNote()
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null })
      }

      // ---- structured tool calls (timeline + python engine) -----------------
      // The LLM (or API client) may answer with {"kind":"tool","name",...}
      // ops alongside the classic ffmpeg ops; tools mutate job.timeline or run
      // python analysis. Serial execution keeps ordering deterministic.
      const toolOps = result.ops.filter((o) => o.kind === 'tool')
      const mediaOps = result.ops.filter((o) => o.kind !== 'tool')
      const toolOutcomes = []
      const toolFails = []
      for (const op of toolOps.slice(0, 8)) {
        try {
          const r = await runTool(id, op.name || op.tool, op.args || {})
          toolOutcomes.push({ tool: op.name || op.tool, result: r.result })
        } catch (e) {
          toolFails.push(`${op.name || op.tool}: ${e.message}`.slice(0, 300))
        }
      }
      if (!mediaOps.length) {
        if (!toolOutcomes.length && toolFails.length) {
          const reply = '⚠️ The tool call failed: ' + toolFails.join('; ')
          job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
          return json(res, 200, { reply, commands: [], media: null })
        }
        let reply = toolOutcomes.map((o) => `🧰 ${o.tool} — ok`).join('\n')
        if (toolFails.length) reply += `\n⚠️ Some calls failed: ${toolFails.join('; ')}`
        reply += toTimelineNote(job)
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null, timeline: timeline.summarize(job.timeline) })
      }
      if (toolFails.length) {
        console.warn(`[ai-studio] chat tool failures (continuing with media ops): ${toolFails.join('; ')}`)
      }
      result.ops = mediaOps

      // ---- caption replacement pipeline ("replace existing subtitles &c") ---
      // These kinds cannot run through the plain build() path: detection, STT,
      // translation and the region-treat+ASS graph happen here, then the frag
      // is enqueued like any other edit. Remaining ordinary ops (trim, speed…)
      // keep their existing path.
      const CAPTION_KINDS = new Set(['remove_existing_captions', 'blur_caption_regions', 'replace_existing_subtitles', 'add_translated_subtitles', 'detect_caption_regions', 'validate_caption_replacement', 'preserve_original_audio'])
      const capOps = result.ops.filter((o) => CAPTION_KINDS.has(o.kind))
      const plainOps = result.ops.filter((o) => !CAPTION_KINDS.has(o.kind))
      result.ops = plainOps.length ? plainOps : capOps.length ? [] : result.ops
      if (capOps.length) {
        // add_translated_subtitles alone (no removal) → same pipeline, no region effects
        const replaceOp = capOps.find((o) => o.kind === 'replace_existing_subtitles') || capOps.find((o) => o.kind === 'remove_existing_captions' || o.kind === 'blur_caption_regions')
        const translateOnly = !replaceOp && capOps.some((o) => o.kind === 'add_translated_subtitles')
        if (replaceOp || translateOnly) {
          const op = replaceOp || { kind: 'replace_existing_subtitles', method: 'none', language: (capOps.find((o) => o.kind === 'add_translated_subtitles') || {}).language || 'th', radius: 14, manual: null }
          if (!replaceOp) {
            // translation-only: keep OPINION 'none' recorded but no remove stage
            op.kind = 'replace_existing_subtitles'
            op.method = 'none'
            op.translatedOnly = true
          }
          try {
            // ordinary ops that must combine with the caption graph (trim,
            // speed, eq…) become part of ONE filter graph; complex-only combos
            // (gif/boomerang/preset canvas) would fight the labeled [vout] —
            // explicit refusal instead of silently dropping their edit
            let plainFrag = null
            if (plainOps.length) {
              makeTextOverlay(plainOps, meta, path.join(JOBS, id), meta.duration)
              plainFrag = build(plainOps, meta, FONT)
              if (plainFrag.complex) {
                const reply = '🧩 That combination needs two separate renders — first run the caption replacement, then ask for the other edit (its graph owns the whole frame). Nothing was dropped; run them one at a time.'
                job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
                await saveJob(job, id)
                return json(res, 200, { reply, commands: [], media: null })
              }
            }
            // whisper/LLM STT gets a small mono side-track; detection uses the
            // untouched video. Reuse the cached extraction from /api/captions.
            const audioName = `stt-${srcName.replace(/\W+/g, '_').replace(/_+$/, '')}.mp3`
            const audioPath = path.join(JOBS, id, audioName)
            let haveAudio = true
            try { fs.accessSync(audioPath) } catch { haveAudio = false }
            if (!haveAudio) {
              const r = await run(FFMPEG, ['-y', '-hide_banner', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-map', 'a:0', audioPath], 300000)
              if (!r.ok) console.warn('[ai-studio] caption STT audio extraction failed, whisper will try the video directly')
            }
            const pipeline = await captions.captionReplacementPipeline({
              src, meta, dir: path.join(JOBS, id), op, plainFrag,
              audioSrc: haveAudio ? audioPath : src,
              pyCall: (ep, payload, tmo) => pyCall(ep, payload, tmo || PY_CAPTION_TMO),
              provider: ai.getLlmProvider(),
            })
            if (pipeline.needInput) {
              const reply = `🫥 ${pipeline.needInput}\n\nSay it like "blur the captions near the bottom" and if detection is unsure, give me a box — e.g. "the caption area is x 120, y 620, w 1040, h 90".`
              job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
              await saveJob(job, id)
              return json(res, 200, { reply, commands: [], media: null })
            }
            const frag = pipeline.frag
            const { rid } = await enqueueRender(job, id, srcName, frag, result, meta, message)
            const summary = `${op.translatedOnly ? 'added translated subtitles' : op.label}`
            const reply = `🈶 ${op.translatedOnly ? 'Adding' : 'Replacing with'} ${(op.language || 'th') === 'th' ? 'Thai' : op.language} subtitles — original voiceover copied untouched ⏳` +
              (pipeline.detection && pipeline.detection.regions && pipeline.detection.regions.length
                ? ` (${pipeline.detection.regions.length} caption window(s) detected)` : '')
              + (pipeline.note ? `\nℹ️ ${pipeline.note}` : '')
            job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: `${reply} (started)` })
            await saveJob(job, id)
            return json(res, 200, {
              reply, summary, ops: frag.desc, commands: [renders.get(rid).cmdDisplay],
              engine: result.isLLM ? 'llm' : 'local', renderId: rid,
            })
          } catch (e) {
            const reply = '⚠️ Caption replacement failed: ' + String(e.message || e).slice(0, 300)
            job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
            await saveJob(job, id)
            return json(res, 200, { reply, commands: [], media: null })
          }
        }
        // standalone detect/validate/preserve ops without a render — answer with data
        const detectOp = capOps.find((o) => o.kind === 'detect_caption_regions')
        if (detectOp) {
          try {
            const det = await captions.detectRegions(src, { pyCall: (ep2, p2, t2) => pyCall(ep2, p2, t2 || PY_CAPTION_TMO) })
            const lines = (det.regions || []).slice(0, 12).map((r) =>
              `• ${r.start}s → ${r.end}s — box x=${r.x} y=${r.y} w=${r.width} h=${r.height} (confidence ${r.confidence})`)
            const reply = `🔍 Caption detection on the current version — ${det.count || 0} region(s):\n${lines.join('\n') || '(no burned-in captions found in the usual bands)'}\nOCR: ${det.ocr && det.ocr.available ? 'enabled' : 'not installed (pip install rapidocr-onnxruntime for high-confidence text reading)'}` + toTimelineNote(job)
            job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
            await saveJob(job, id)
            return json(res, 200, { reply, commands: [], media: null, detection: det.regions && det.regions.slice(0, 20) })
          } catch (e) {
            const reply = '⚠️ caption detection failed: ' + String(e.message || e).slice(0, 200)
            job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
            await saveJob(job, id)
            return json(res, 200, { reply, commands: [], media: null })
          }
        }
        // preserve_original_audio only → nothing destructive to run; acknowledge
        if (!plainOps.length && capOps.every((o) => o.kind === 'preserve_original_audio' || o.kind === 'validate_caption_replacement')) {
          const reply = '✅ Constraint noted: the original voiceover is always copied through ("-map 0:a? -c:a copy") on caption renders — no TTS, no filters, no re-timing. Tell me the edit to run it with.'
          job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
          await saveJob(job, id)
          return json(res, 200, { reply, commands: [], media: null })
        }
      }
      result.ops = plainOps
      if (!result.ops.length) {
        const reply = "I couldn't turn that into an edit yet. Try phrasing it as an action — e.g. \"remove the first 3 seconds\", \"make it square for tiktok\", \"2x speed\", \"add text 'Good vibes' at the top\", \"make it a gif\", \"mute it\" — or ask \"what can you do?\"" + llmFallbackNote()
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null })
      }

      // 2) build the ffmpeg pipeline
      if (!meta.hasAudio && mediaOps.some((o) => ['audioOut', 'volume'].includes(o.kind))) {
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
      const reply = `${result.isLLM ? '🤖 (LLM) ' : '🛠 '}Rendering: ${summary} ⏳ (${queued ? `queued — ${queued} render${queued === 1 ? '' : 's'} ahead` : 'starting now'})` + (result.isLLM ? '' : llmFallbackNote())
      return json(res, 200, {
        reply,
        summary,
        ops: frag.desc,
        commands: [renders.get(rid).cmdDisplay],
        engine: result.isLLM ? 'llm' : 'local',
        renderId: rid,
      })
    }

    // ---- render polling ----
    // live push channel: render progress + external-render syncs (SSE)
    if (p === '/api/render-events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write('retry: 3000\n\n')
      sseClients.add(res)
      res.on('close', () => sseClients.delete(res))
      return
    }

    if (p === '/api/render' && req.method === 'GET') {
      const id = url.searchParams.get('id') || ''
      const rid = url.searchParams.get('rid') || ''
      const reg = renders.get(rid)
      if (!reg || reg.jobId !== id) return json(res, 404, { error: 'render not found (server restarted?) — send the edit again' })
      if (reg.status === 'queued') return json(res, 200, { status: 'queued', progress: 0, queuedAhead: Math.max(0, renderQueue.indexOf(rid)) })
      if (reg.status === 'running') return json(res, 200, { status: 'running', progress: reg.progress })
      return json(res, 200, {
        status: reg.status, progress: reg.progress, reply: reg.reply,
        media: reg.media, summary: reg.summary, ops: reg.ops, commands: [reg.cmdDisplay],
      })
    }

    if (p === '/api/job' && req.method === 'GET') {
      const id = url.searchParams.get('id') || ''
      const job = getJob(id)
      if (!job) return json(res, 404, { error: 'unknown job' })
      await syncExternalRenders(job, id) // pick up ffmpeg runs done outside the app
      return json(res, 200, { versions: job.versions, base: job.base, msgs: job.msgs })
    }

    // pin a version as the edit base (rollback = point base at the past)
    if (p === '/api/version' && req.method === 'POST') {
      const { id, index } = await readJson(req)
      const job = getJob(id)
      if (!job) return json(res, 404, { error: 'unknown job' })
      const i = parseInt(index, 10)
      if (!Number.isInteger(i) || i < 0 || i >= job.versions.length) return json(res, 400, { error: 'bad version index' })
      job.base = i
      await saveJob(job, id)
      console.log(`[ai-studio] job ${id} base → v${i + 1} (${job.versions[i].name})`)
      return json(res, 200, { ok: true, base: i })
    }

    // delete a version and its media (v0, the original upload, can never go)
    if (p === '/api/version' && req.method === 'DELETE') {
      const { id, index } = await readJson(req)
      const job = getJob(id)
      if (!job) return json(res, 404, { error: 'unknown job' })
      const i = parseInt(index, 10)
      if (!Number.isInteger(i) || i <= 0 || i >= job.versions.length) return json(res, 400, { error: 'bad version index' })
      const v = job.versions[i]
      const dir = path.join(JOBS, id)
      // any render still queued/running from this version failed the moment
      // the file is removed — fail it now so the chat shows why
      for (const reg of renders.values()) {
        if (reg.jobId !== id || reg.status === 'done' || reg.status === 'failed') continue
        if (reg.srcName === v.name) {
          reg.status = 'failed'
          reg.reply = '⚠️ The render was cancelled: the version it was editing from got deleted.'
          try { reg.proc?.kill('SIGKILL') } catch { /* already gone */ }
        }
      }
      job.versions.splice(i, 1)
      // base moves down if it came after the deleted slot, and re-pins to the
      // last version in any edge case where it would point past the end
      if (job.base >= i) job.base = Math.max(0, job.base - 1)
      if (job.base > job.versions.length - 1) job.base = job.versions.length - 1
      await saveJob(job, id)
      // media cleanup: output file, its thumbnail, per-version frame cache
      const frames = path.join(dir, `frames-${v.name.replace(/\W+/g, '_').replace(/_+$/, '')}`)
      await fsp.rm(path.join(dir, v.name), { force: true }).catch(() => {})
      await fsp.rm(path.join(dir, `thumb-${v.name}.jpg`), { force: true }).catch(() => {})
      await fsp.rm(frames, { recursive: true, force: true }).catch(() => {})
      console.log(`[ai-studio] job ${id} deleted v${i + 1} (${v.name})`)
      return json(res, 200, { ok: true })
    }

    // delete a job and all its media
    if (p === '/api/job' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') || ''
      if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return json(res, 400, { error: 'bad job id' })
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
      const job = getJob(id)
      if (!job) return json(res, 404, { error: 'unknown job' })
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

    // ---- captions: paste script → silence-timed burn-in, or auto-transcribe ----
    if (p === '/api/captions' && req.method === 'POST') {
      const { id, text, auto, skill, instructions = '' } = await readJson(req)
      // Native Android Skills API: the optional stable `automatic_subtitles`
      // Skill id and bounded language/style `instructions` (≤1000 chars) ride
      // along; existing website bodies (no new fields) stay unchanged.
      const capErr = skillsModule.validateCaptionInput(skill, instructions)
      if (capErr) return json(res, 400, { error: capErr })
      const job = getJob(id)
      if (!job) return json(res, 404, { error: 'unknown job — upload a clip first' })
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

      let placed = null
      let summary = ''
      let userMsg = ''
      let captionSource = ''
      if (auto) {
        // ---- STT path: extract a small mono audio track, transcribe, burn ---
        const audioName = `stt-${srcName.replace(/\W+/g, '_')}.mp3`
        const audioPath = path.join(JOBS, id, audioName)
        let have = true
        try { fs.accessSync(audioPath) } catch { have = false }
        if (!have) {
          const r = await run(FFMPEG, ['-y', '-hide_banner', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-map', 'a:0', audioPath], 300000)
          if (!r.ok) return json(res, 500, { error: 'audio extraction failed' })
        }
        // instructions (≤1000 chars, validated above) reach the real Gemini
        // transcription prompt; cue JSON shape and timestamps stay intact
        const raw = await transcribeAudio(audioPath, { instructions })
        placed = raw && raw.length ? normalizeTranscriptCues(raw, meta) : null
        if (!placed || !placed.length) {
          console.log(`[ai-studio] auto-captions ${id}: STT returned ${raw ? raw.length : 'no'} cue(s) — falling back to manual script`)
          const reply = "I couldn't auto-transcribe this clip (the LLM isn't reachable, or there's no clear speech). You can paste your script instead — ✨ pasted captions are timed with silence detection and need no cloud."
          job.msgs.push({ role: 'user', content: 'auto-transcribe captions' }, { role: 'assistant', content: reply })
          await saveJob(job, id)
          return json(res, 200, { reply, commands: [], media: null })
        }
        summary = `burned in ${placed.length} auto-transcribed caption${placed.length === 1 ? '' : 's'}`
        userMsg = `🎙 auto-transcribe and caption the spoken words${instructions.trim() ? `\nInstructions: ${instructions.trim()}` : ''}`
      } else {
        // ---- pasted-script path (unchanged behaviour) -------------------------
        const script = String(text || '').slice(0, 5000)
        const cues = buildCues(script)
        if (!cues.length) return json(res, 400, { reply: 'Give me at least one line of script text to caption.' })
        const segs = await speechSegments(src, meta)
        placed = placeCues(cues, segs)
        if (!placed.length) return json(res, 400, { reply: 'No speech segments found — the clip may be all music/silence. Try a manual text overlay instead.' })
        summary = `burned in ${placed.length} caption lines`
        userMsg = `add captions:\n${script.slice(0, 400)}${script.length > 400 ? '…' : ''}`
        captionSource = ` on ${segs.length} detected speech segment${segs.length === 1 ? '' : 's'}`
      }
      let vf
      try {
        // throws ThaiFontUnavailableError when the cues need Thai and no
        // Thai-capable font is installed — a clean reply, not tofu and not a
        // half-written response
        vf = makeCaptionAss(placed, meta, path.join(JOBS, id))
      } catch (e) {
        const reply = '⚠️ Could not pick a subtitle font: ' + String(e.message || e).split('\n')[0].slice(0, 300)
        job.msgs.push({ role: 'user', content: userMsg || 'add captions' }, { role: 'assistant', content: reply })
        await saveJob(job, id)
        return json(res, 200, { reply, commands: [], media: null })
      }
      const frag = { vf: [vf], af: [], extraArgs: [], complex: null, output: 'mp4', desc: [summary] }
      const render = await enqueueRender(job, id, srcName, frag, { summary, ops: frag.desc }, meta, userMsg)
      const { rid } = render
      const reply = `💬 Placing ${placed.length} caption line${placed.length === 1 ? '' : 's'}${auto ? ' from the transcribed speech' : captionSource} — rendering ⏳`
      job.msgs.push({ role: 'user', content: userMsg }, { role: 'assistant', content: reply + ' (started)' })
      await saveJob(job, id)
      return json(res, 200, { reply, renderId: rid, summary, ops: frag.desc, commands: [] })
    }

    // ---- structured AI tools ---------------------------------------------
    if (p === '/api/tools' && req.method === 'GET') {
      return json(res, 200, { tools: tools.CATALOG.map((t) => ({ name: t.name, group: t.group, summary: t.summary, args: t.args })) })
    }
    if (p === '/api/tool' && req.method === 'POST') {
      const { id, tool, args = {} } = await readJson(req)
      try {
        const r = await runTool(id, tool, args)
        return json(res, 200, r)
      } catch (e) {
        return json(res, e.status || 500, { error: e.message })
      }
    }

    // ---- timeline: read, replace, OTIO export -----------------------------
    if (p === '/api/timeline' && req.method === 'GET') {
      const id = url.searchParams.get('id') || ''
      const job = getJob(id)
      if (!job) return json(res, 404, { error: 'unknown job' })
      if (!job.timeline) job.timeline = buildInitialTimeline(job, id)
      if (url.searchParams.get('format') === 'otio') {
        try {
          const r = await pyCall('timeline/to_otio', { timeline: timeline.sanitize(job.timeline) }, 30000)
          return json(res, 200, { ok: true, otio: JSON.parse(r.otio) })
        } catch (e) {
          return json(res, 503, { error: e.message })
        }
      }
      return json(res, 200, { timeline: timeline.summarize(job.timeline) })
    }
    if (p === '/api/timeline' && req.method === 'POST') {
      const { id, timeline: tlIn, otio } = await readJson(req)
      const job = getJob(id)
      if (!job) return json(res, 404, { error: 'unknown job' })
      if (otio) {
        if (typeof otio !== 'string' || !(otio.trim().startsWith('{') || otio.trim().startsWith('['))) {
          return json(res, 400, { error: 'otio must be inline .otio JSON (files are not accepted via HTTP for safety)' })
        }
        const r = await pyCall('timeline/from_otio', { otio }, 30000).catch((e) => ({ error: e.message, ok: false }))
        if (!r.ok) return json(res, 503, { error: r.error })
        job.timeline = timeline.sanitize(r.timeline)
      } else {
        try { job.timeline = timeline.sanitize(tlIn) } catch (e) { return json(res, 400, { error: e.message }) }
      }
      await saveJob(job, id)
      return json(res, 200, { ok: true, timeline: timeline.summarize(job.timeline) })
    }

    // ---- python STT status proxy (job lives inside the python service) ----
    if (p === '/api/py/stt/status' && req.method === 'GET') {
      const jid = url.searchParams.get('job') || ''
      try {
        const r = await pyCall('stt/status', { job: jid }, 30000)
        return json(res, 200, r)
      } catch (e) {
        return json(res, 503, { error: e.message })
      }
    }

    return send(res, 404, 'not found')
  } catch (e) {
    console.error(e)
    try { json(res, 500, { error: e.message || 'internal error' }) } catch { /* headers sent */ }
  }
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`\n  🎬 AI Clip Studio  →  http://localhost:${PORT}`)
  console.log(AUTH_TOKEN
    ? '[ai-studio] 🔒 access locked by AUTH_TOKEN — enter it in the browser to start'
    : '[ai-studio] 🔓 no AUTH_TOKEN set — open access (set AUTH_TOKEN in .env to lock)')
  console.log(`[ai-studio] job cleanup every 30 min, TTL ${Math.round(JOBS_TTL_MS / 3600000)}h | render concurrency: ${RENDER_CONCURRENCY}\n`)
  startPythonService()
})
setInterval(cleanupJobs, 30 * 60 * 1000).unref()
cleanupJobs()
rehydrateRenders()

// periodic sweep: ffmpeg runs made outside the app (e.g. pasted into a terminal)
// register as versions without waiting for the next /api read
async function sweepExternalRenders() {
  let names
  try { names = await fsp.readdir(JOBS) } catch { return }
  for (const id of names) {
    if (/^_/.test(id) || !/^[a-f0-9-]{16,64}$/.test(id)) continue
    const job = getJob(id)
    if (job) await syncExternalRenders(job, id)
  }
}
setInterval(sweepExternalRenders, 15 * 1000).unref()
sweepExternalRenders() // also enrolls outputs already orphaned in the jobs folder
