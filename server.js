// ---------------------------------------------------------------------------
// server.js — AI Clip Studio: zero-dependency Node.js video-editing web app
//   • upload a clip (any ffmpeg-readable format)
//   • chat with the AI about the edits you want — ANY free-form request
//     ("cut the first 3s, make it square", "why not add a caption?") —
//     the AI (Gemini/OpenAI/Anthropic via env keys, else local engine) turns
//     your words into an ffmpeg pipeline and renders it, and answers
//     non-edit questions conversationally.
// Used ffmpeg binary: ./vendor/ffmpeg if present, else whatever is on PATH.
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
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { understand, understandWithLLM, build, makeTextOverlay } = require('./ai')

const ROOT = __dirname
const PUBLIC = path.join(ROOT, 'public')
const JOBS = path.join(ROOT, 'jobs')
const MAX_UPLOAD = 1024 * 1024 * 1024 // 1 GB

fs.mkdirSync(JOBS, { recursive: true })

// --- locate ffmpeg/ffprobe --------------------------------------------------
let FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg')
let FFPROBE = path.join(ROOT, 'vendor', 'ffprobe')
try {
  fs.accessSync(FFMPEG, fs.constants.X_OK)
  fs.accessSync(FFPROBE, fs.constants.X_OK)
} catch {
  FFMPEG = 'ffmpeg'
  FFPROBE = 'ffprobe'
}

function findFont() {
  const candidates = [
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
console.log(`[ai-studio] ffmpeg: ${FFMPEG}${FONT ? ` | font: ${FONT}` : ' | font: none (text overlays need fontconfig/default font)'}`)

// --- helpers -----------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.gif': 'image/gif',
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

// minimal multipart/form-data parser (buffered; fine for ≤ ~1 GB local use)
function parseMultipart(req, boundary) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      chunks.push(c); size += c.length
      if (size > MAX_UPLOAD) { reject(new Error('File too large (max 1 GB)')); req.destroy() }
    })
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      const delim = Buffer.from(`--${boundary}`)
      const fields = {}
      let file = null
      let idx = buf.indexOf(delim)
      while (idx !== -1) {
        const next = buf.indexOf(delim, idx + delim.length)
        if (next === -1) break
        // part = everything between end of delimiter line and next delimiter
        let start = buf.indexOf('\r\n', idx) + 2
        const headEnd = buf.indexOf('\r\n\r\n', start)
        if (headEnd === -1 || headEnd > next) { idx = next; continue }
        const head = buf.slice(start, headEnd).toString('utf8')
        const body = buf.slice(headEnd + 4, next - 2) // strip trailing \r\n
        const nameM = head.match(/name="([^"]*)"/)
        const fileM = head.match(/filename="([^"]*)"/)
        const ctype = (head.match(/content-type:\s*([^\r\n]+)/i) || [])[1]
        if (nameM) {
          if (fileM && fileM[1]) file = { filename: fileM[1], mime: (ctype || 'application/octet-stream').trim(), data: body }
          else fields[nameM[1]] = body.toString('utf8')
        }
        idx = next
      }
      resolve({ fields, file })
    })
    req.on('error', reject)
  })
}

function extOf(filename, mime) {
  const m = (filename || '').match(/\.([a-z0-9]{2,5})$/i)
  if (m) return m[1].toLowerCase()
  const map = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }
  return map[mime] || 'bin'
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
  if (!j) return { duration: null, width: null, height: null, hasAudio: true, fps: 30 }
  const v = (j.streams || []).find((s) => s.codec_type === 'video')
  const a = (j.streams || []).find((s) => s.codec_type === 'audio')
  const meta = {
    duration: j.format ? Math.round(parseFloat(j.format.duration) * 100) / 100 : null,
    width: v?.width || null,
    height: v?.height || null,
    hasAudio: !!a,
    fps: v && v.avg_frame_rate && v.avg_frame_rate.includes('/') ? Math.round((v.avg_frame_rate.split('/').reduce((a2, b) => a2 / b)) * 100) / 100 : 30,
    format: j.format?.format_name || 'unknown',
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

// --- job state (persisted to jobs/<id>/job.json so restarts keep history) -----
function loadJob(id) {
  try { return JSON.parse(fs.readFileSync(path.join(JOBS, id, 'job.json'), 'utf8')) } catch { return null }
}
const history = new Map() // id → { msgs, input, versions, next }

// --- request router ------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname

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

    // media files
    const mediaM = p.match(/^\/media\/([a-f0-9-]+)\/([\w.-]+)$/)
    if (req.method === 'GET' && mediaM) {
      const abs = path.join(JOBS, mediaM[1], mediaM[2])
      if (!abs.startsWith(JOBS)) return send(res, 403, 'forbidden')
      try {
        const st = await fsp.stat(abs)
        const data = await fsp.readFile(abs)
        return send(res, 200, data, {
          'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-length': st.size,
        })
      } catch {
        return send(res, 404, 'not found')
      }
    }

    if (p === '/api/health') return json(res, 200, { ok: true, ffmpeg: FFMPEG, aiKey: !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) })

    // ---- upload ----
    if (p === '/api/upload' && req.method === 'POST') {
      const ct = req.headers['content-type'] || ''
      const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
      if (!bm) return json(res, 400, { error: 'expected multipart/form-data' })
      const { file } = await parseMultipart(req, bm[1] || bm[2])
      if (!file || !file.data.length) return json(res, 400, { error: 'no file received' })
      const id = crypto.randomUUID()
      const dir = path.join(JOBS, id)
      await fsp.mkdir(dir, { recursive: true })
      const ext = extOf(file.filename, file.mime)
      const fname = `input.${ext}`
      await fsp.writeFile(path.join(dir, fname), file.data)
      const meta = await probe(path.join(dir, fname))
      const job = { msgs: [], input: fname, versions: [fname], next: 1 }
      history.set(id, job)
      await fsp.writeFile(path.join(dir, 'job.json'), JSON.stringify(job))
      return json(res, 200, { id, meta, url: `/media/${id}/${encodeURIComponent(fname)}`, original: file.filename })
    }

    // ---- chat / edit ----
    if (p === '/api/chat' && req.method === 'POST') {
      const { id, message } = await readJson(req)
      const job = history.get(id) || loadJob(id)
      if (job) history.set(id, job)
      if (!job) return json(res, 404, { error: 'unknown job — upload a clip first' })
      const src = path.join(JOBS, id, job.versions[job.versions.length - 1])
      const meta = await probe(src)

      // capability tour — handled locally, no LLM round-trip needed
      if (/^(what can you|help|commands|abilities)/.test(message.toLowerCase().trim())) {
        const list = [
          'Ask me *anything* in your own words — commands or questions, in any language. Examples:',
          '',
          '✂️ Trim — “remove the first 3 seconds”, “keep only 0:05 to 0:10”',
          '⏩ Speed — “2x speed”, “slow motion”',
          '🔇 Audio — “mute it”, “make it louder 2x”, “give me just the audio”',
          '🔄 Frame — “mirror”, “rotate 90”, “upside down”',
          '📐 Aspect — “make it square”, “9:16 for tiktok”, “720p”',
          '💬 Text — “add text \'Good Vibes\' at the top”',
          '🎞 GIF — “make a gif at 15 fps”',
          '⏪ FX — “reverse”, “boomerang”, “blur”, “black and white”, “vintage”',
          '🎨 Color — “brighter”, “more colorful”, “more contrast”',
          '🧪 Anything else ffmpeg can do — “add a vignette”, “car radio style animation”, “fade in 1s”, “remove the bass”…',
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
      let result = await understandWithLLM(message, meta, job.msgs.concat([{ role: 'user', content: message }]))

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
        const reply = "I couldn't map that to an edit I know yet. Try rephrasing — e.g. \"remove the first 3 seconds\", \"make it square for tiktok\", \"2x speed\", \"add text 'Good vibes' at the top\", \"make it a gif\", \"mute it\" — or ask \"what can you do?\""
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null })
      }

      // 2) build the ffmpeg pipeline
      if (!meta.hasAudio && result.ops.some((o) => ['audioOut', 'volume'].includes(o.kind))) {
        const reply = "This version has no audio track (it's a GIF or was muted), so there's nothing to extract or adjust there. Try a visual edit instead — or mention which version to use."
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [], media: null })
      }
      makeTextOverlay(result.ops, meta, path.join(JOBS, id), meta.duration)
      const frag = build(result.ops, meta, FONT)
      const outName = `out-${job.next++}.${frag.output}`
      const outPath = path.join(JOBS, id, outName)

      const args = ['-y', '-hide_banner']
      args.push('-i', src)
      if (frag.complex) args.push('-filter_complex', frag.complex)
      else {
        if (frag.vf.length) args.push('-vf', frag.vf.join(','))
        if (frag.af.length) args.push('-af', frag.af.join(','))
      }
      if (frag.output === 'mp4') {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-movflags', '+faststart', '-pix_fmt', 'yuv420p')
        if (frag.af.length) args.push('-c:a', 'aac', '-b:a', '160k')
        else if (meta.hasAudio && !frag.extraArgs.includes('-an')) args.push('-c:a', 'copy')
      }
      if (frag.output === 'mp3') args.push('-vn')
      args.push(...frag.extraArgs, outPath)

      const cmdDisplay = `ffmpeg ${args.map((a) => (/[\s'"]/.test(a) && a !== outPath && !a.startsWith('-') ? `"${a}"` : a)).join(' ')}`

      // 3) render
      const r = await run(FFMPEG, args)
      if (!r.ok) {
        const reply = `⚠️ The edit failed while rendering:\n\n${r.error}\n\nAsk me differently and I'll retry.`
        job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
        return json(res, 200, { reply, commands: [cmdDisplay], media: null, error: true })
      }

      // 4) respond
      const outMeta = await probe(outPath)
      const summary = result.summary || frag.desc.join(' + ')
      const reply = `${result.isLLM ? '🤖 (LLM)' : '✅'} Done — ${summary}.${outMeta.duration ? ` New length: ${outMeta.duration}s.` : ''} I ran:\n\n\`${cmdDisplay}\`\n\nWhat's next?`
      job.msgs.push({ role: 'user', content: message }, { role: 'assistant', content: reply })
      job.versions.push(outName)
      await fsp.writeFile(path.join(JOBS, id, 'job.json'), JSON.stringify(job))
      return json(res, 200, {
        reply,
        summary,
        ops: frag.desc,
        commands: [cmdDisplay],
        engine: result.isLLM ? 'llm' : 'local',
        media: { url: `/media/${id}/${encodeURIComponent(outName)}`, ...outMeta, name: outName },
      })
    }

    if (p === '/api/job' && req.method === 'GET') {
      const id = url.searchParams.get('id') || ''
      const job = history.get(id) || loadJob(id)
      if (!job) return json(res, 404, { error: 'unknown job' })
      return json(res, 200, { versions: job.versions, msgs: job.msgs })
    }

    return send(res, 404, 'not found')
  } catch (e) {
    console.error(e)
    json(res, 500, { error: e.message || 'internal error' })
  }
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`\n  🎬 AI Clip Studio  →  http://localhost:${PORT}\n`)
})
