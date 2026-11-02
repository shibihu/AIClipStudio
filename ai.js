// ---------------------------------------------------------------------------
// ai.js — the "AI brain": turns natural-language edit requests into ffmpeg ops
// Works fully offline (rule-based intent engine). If OPENAI_API_KEY or
// ANTHROPIC_API_KEY is set, it asks the LLM to translate the request into the
// same JSON op list, and falls back to the local engine on any error.
// ---------------------------------------------------------------------------

function num(str) {
  const m = String(str || '').toLowerCase().match(/(\d+(?:[.,]\d+)?)/)
  return m ? parseFloat(m[1].replace(',', '.')) : null
}

function even(n) {
  n = Math.round(n)
  return n % 2 ? n + 1 : n
}

function secs(str) {
  const s = String(str || '').trim().replace(/[.,;:!?]+$/, '').trim()
  const ts = s.match(/^(\d{1,2}):(\d{2})(?:[:.](\d{1,2}))?$/)
  if (ts) return (+ts[1]) * 60 + (+ts[2]) + (ts[3] ? +'0.' + ts[3] : 0)
  const plain = s.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)?$/)
  if (plain) return parseFloat(plain[1])
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*(?:s\b|sec|second|seconds)/)
  return m ? parseFloat(m[1].replace(',', '.')) : null
}

function atempoChain(rate) {
  const stages = []
  let r = rate
  while (r > 2.0) { stages.push(2.0); r /= 2.0 }
  while (r < 0.5) { stages.push(0.5); r /= 0.5 }
  stages.push(r)
  return stages
}

function drawtextEscape(text) {
  return String(text)
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\\\:')
    .replace(/'/g, "\\\\\\'")
    .replace(/%/g, '\\\\\\%')
    .replace(/"/g, '')
    .trim()
}

// ---------------------------------------------------------------------------

// Returns { ops:[...], unknown:{bool}, clarify:{bool}, summary:string }
function understand(message, meta) {
  const s = (message || '').toLowerCase().trim()
  if (!s) return { ops: [], unknown: true }
  const ops = []

  // ---- trim ----
  let trimmed = false
  const keepRng = s.match(/(?:only|keep|clip).{0,25}?(?:from|between)\s+([\d.,:]+)\s*(?:to|until|till|-|–)\s+([\d.,:]+)/)
    || s.match(/(?:trim|cut|clip)\s+(?:it\s+)?(?:to|from)\s+([\d.,:]+?)\s*(?:to|until|till|-|–)\s+([\d.,:]+)/)
  const firstCut = s.match(/(?:remove|delete|cut|trim|drop)\s+(?:the\s+)?first\s+(\d+(?:[.,]\d+)?)\s*(?:s\b|sec|secs|second)/)
  const lastCut = s.match(/(?:remove|delete|cut|trim|drop)\s+(?:the\s+)?last\s+(\d+(?:[.,]\d+)?)\s*(?:s\b|sec|secs|second)/)
  const firstHalf = s.match(/(?:remove|delete|cut|drop)\s+(?:the\s+)?(?:first|1st)\s+half/)
  const shorten = s.match(/(?:shorter|shorten).{0,30}?(\d+(?:[.,]\d+)?)\s*(?:s\b|sec|secs|second)/)

  if (keepRng) {
    const a = secs(keepRng[1]) ?? 0
    const b = secs(keepRng[2])
    ops.push({ kind: 'trim', label: `keep ${a}s → ${b == null ? 'end' : b + 's'}`, from: a, to: b })
    trimmed = true
  } else if (firstCut) {
    ops.push({ kind: 'trim', label: `cut the first ${firstCut[1]}s`, from: parseFloat(firstCut[1].replace(',', '.')) })
    trimmed = true
  } else if (lastCut && typeof meta.duration === 'number') {
    const d = parseFloat(lastCut[1].replace(',', '.'))
    ops.push({ kind: 'trim', label: `cut the last ${d}s`, to: Math.max(0.1, meta.duration - d) })
    trimmed = true
  } else if (firstHalf) {
    ops.push({ kind: 'trim', label: 'cut the first half', to: (meta.duration || 0) / 2 })
    trimmed = true
  } else if (shorten) {
    ops.push({ kind: 'trim', label: `keep only the first ${shorten[1]}s`, to: parseFloat(shorten[1].replace(',', '.')) })
    trimmed = true
  }

  // ---- speed ----
  const rateM = s.match(/(\d+(?:[.,]\d+)?)\s*(?:x|×|times)\b/) || s.match(/speed\s*(?:it\s*)?(?:up|down)?\s*(?:by\s*)?(\d+(?:[.,]\d+)?)/)
  if (rateM && /(speed|fast|x|×|times)/.test(s)) {
    const rate = parseFloat(rateM[1].replace(',', '.'))
    if (rate && rate > 1) {
      ops.push({ kind: 'speed', label: `${rate}× speed`, vf: `setpts=PTS/${rate}`, af: `atempo=${atempoChain(rate).join(',atempo=')}` })
    }
  } else if (/slow/.test(s)) {
    let rate = num(s.match(/(\d+(?:[.,]\d+)?)\s*(?:x|×|times)/)) || 0.5
    if (rate > 1) rate = 1 / rate
    ops.push({ kind: 'speed', label: `${rate}× slow motion`, vf: `setpts=PTS*${(1 / rate).toFixed(3)}`, af: `atempo=${atempoChain(rate).join(',atempo=')}` })
  }

  // ---- audio ----
  if (/(mute|no sound|remove (the )?audio|remove (the )?sound|delete (the )?audio|silence)/.test(s)) {
    ops.push({ kind: 'mute', label: 'remove audio track', bareArgs: ['-an'] })
  } else if (/(extract|keep|give|only|export).{0,15}(audio|sound)|as mp3|to mp3/.test(s)) {
    ops.push({ kind: 'audioOut', label: 'export audio as mp3', outKind: 'mp3' })
  } else if (/(louder|quieter|volume)/.test(s)) {
    let f = num(s.match(/(\d+(?:[.,]\d+)?)\s*(?:x|×|times)/)) || 1.5
    if (/(quieter|lower)/.test(s) && f > 1) f = 1 / f
    else if (/(quieter|lower)/.test(s)) f = 0.6
    ops.push({ kind: 'volume', label: `audio volume ${f < 1 ? 'down' : 'up'} (×${f})`, af: `volume=${f}` })
  }

  // ---- orientation ----
  if (/(mirror|flip horizontally)/.test(s)) ops.push({ kind: 'mirror', label: 'mirror (flip horizontally)', vf: 'hflip' })
  if (/(upside ?down|flip vertically)/.test(s)) ops.push({ kind: 'vflip', label: 'flip vertically', vf: 'vflip' })
  const rot = s.match(/rotate\s*(?:it\s*)?(?:by\s*)?(\d+)/)
  if (rot) {
    const deg = parseInt(rot[1], 10)
    if (deg === 90) ops.push({ kind: 'rotate', label: 'rotate 90° clockwise', vf: 'transpose=1' })
    else if (deg === 270 || deg === -90) ops.push({ kind: 'rotate', label: 'rotate 90° counter-clockwise', vf: 'transpose=2' })
    else if (deg === 180) ops.push({ kind: 'rotate', label: 'rotate 180°', vf: 'transpose=1,transpose=1' })
  } else if (/rotate/.test(s)) {
    if (/left|counter[- ]?clockwise|ccw/.test(s)) ops.push({ kind: 'rotate', label: 'rotate 90° counter-clockwise', vf: 'transpose=2' })
    else ops.push({ kind: 'rotate', label: 'rotate 90° clockwise', vf: 'transpose=1' })
  }

  // ---- crop / aspect ----
  const wantVertical = /(tiktok|short|reels|instagram|vertical)/.test(s)
  const arRaw = s.match(/\b(1:1|9:16|16:9|4:5|4:3|21:9)\b/) || (/(square)/.test(s) ? ['1:1'] : null)
  if (arRaw || wantVertical) {
    const arStr = arRaw ? (arRaw[1] || arRaw[0]) : '9:16'
    const ar = arStr.split(':').map((v) => parseInt(v, 10))
    ops.push({ kind: 'aspect', label: `crop to ${ar[0]}:${ar[1]} (center)`, rx: ar[0], ry: ar[1] })
  }

  // ---- scale ----
  const resM = s.match(/\b(1440|1080|720|480|360|240)p\b/)
  if (resM) ops.push({ kind: 'scale', label: `scale to ${resM[1]}p`, vf: `scale=-2:${resM[1]}` })
  else if (/(smaller|shrink|scale down|resize down)/.test(s)) ops.push({ kind: 'scale', label: 'scale down to 50%', vf: 'scale=iw/2:ih/2' })
  else if (/(bigger|larger|upscale)/.test(s)) ops.push({ kind: 'scale', label: 'upscale 2×', vf: 'scale=iw*2:ih*2' })

  // ---- gif ----
  if (/\bgif\b/.test(s)) {
    const fps = num(s.match(/(\d{1,2})\s*fps/)) || 12
    ops.push({ kind: 'gif', label: `convert to GIF @ ${fps}fps`, fps, width: 480, outKind: 'gif' })
  }

  // ---- reverse / boomerang ----
  if (/boomerang|forward and backward|back and forth/.test(s)) {
    ops.push({ kind: 'boomerang', label: 'boomerang (forward then reversed)' })
  } else if (/(reverse|backwards|backward)/.test(s)) {
    ops.push({ kind: 'reverse', label: 'play backwards', vf: 'reverse', af: 'areverse' })
  }

  // ---- fps ----
  const fpsM = s.match(/(\d{1,3})\s*(?:fps|frames per second)/)
  if (fpsM && !/\bgif\b/.test(s)) ops.push({ kind: 'fps', label: `${fpsM[1]} fps`, vf: `fps=${fpsM[1]}` })

  // ---- color / look ----
  if (/(black and white|b&w|\bb ?&\s?w\b|grayscale|greyscale|noir|monochrome)/.test(s)) ops.push({ kind: 'gray', label: 'grayscale (black & white)', vf: 'hue=s=0' })
  if (/(sepia|vintage|retro)/.test(s)) ops.push({ kind: 'sepia', label: 'sepia / vintage tone', vf: 'colorbalance=rs=0.3:rm=0.1:bs=-0.2:bm=0.05' })
  if (/(brighter|brighten)/.test(s)) ops.push({ kind: 'eq', label: 'brighter', vf: 'eq=brightness=0.08' })
  else if (/(darker|dim)/.test(s)) ops.push({ kind: 'eq', label: 'darker', vf: 'eq=brightness=-0.08' })
  if (/(more (color|vibrant|saturat)|colorful|punchier)/.test(s)) ops.push({ kind: 'eq', label: 'more saturation', vf: 'eq=saturation=1.6' })
  else if (/(less (vibrant|saturat)|desaturated|washed)/.test(s)) ops.push({ kind: 'eq', label: 'less saturation', vf: 'eq=saturation=0.5' })
  if (/(more contrast|contrastier)/.test(s)) ops.push({ kind: 'eq', label: 'more contrast', vf: 'eq=contrast=1.3' })

  // ---- blur ----
  const blurM = s.match(/blur(?:\s*(?:it|everything|the (?:whole )?video))?(?:\s*(?:by|of|radius)\s*(\d+))?/)
  if (blurM) ops.push({ kind: 'blur', label: `blur (radius ${blurM[1] || 4})`, vf: `boxblur=${Math.min(20, parseInt(blurM[1] || '4', 10))}` })

  // ---- text overlay ----
  // ---- text overlay ----
  if (/(text|title|caption|watermark|subtitle|write|overlay)/.test(s)) {
    const orig = (message || '').trim()
    const quoted = orig.match(/["'“]([^"'”]{1,80})["'”]/)
    const m = quoted || s.match(/(?:text|title|caption|watermark)\s+(?:saying|that says|:)?\s*([a-z0-9][a-z0-9 .!?,-]{2,60})/)
    let raw = (m ? m[1] : '').trim()
    // strip position / size phrases captured as part of the text
    raw = raw.replace(/\s+(?:at|in)\s+(the\s+)?(top|upper|center|middle|bottom|lower)(\s+(part|area|corner))?(?:\s+of\s+(the\s+)?(screen|video|frame|clip|it))?\s*$/, '')
      .replace(/\s+(?:font|with|and)\b.*$/, '')
      .replace(/\s+$/, '')
    if (raw && raw.length > 1 && !/^(?:text|title|caption|watermark)$/.test(raw)) {
      let pos = 'center'
      if (/(top|upper)/.test(s)) pos = 'top'
      if (/(bottom|lower)/.test(s)) pos = 'bottom'
      let size = 40
      if (/huge|giant/.test(s)) size = 72
      else if (/\b(?:big|large)\b/.test(s)) size = 52
      else if (/(small|tiny)/.test(s)) size = 26
      const sm = s.match(/(\d{2,3})\s*(?:px|pt|point|font)/)
      if (sm) size = parseInt(sm[1], 10)
      ops.push({ kind: 'text', label: `overlay text "${raw.slice(0, 36)}" (${pos})`, text: raw, pos, size, color: 'white' })
    }
  }

  const knownOp = ops.length > 0
  return { ops, unknown: !knownOp, summary: ops.map((o) => o.label).join(' + ') }
}

// ---------------------------------------------------------------------------
// build — op list → ffmpeg argument fragments
// Returns { vf:[], af:[], extraArgs:[], complex:string|null, output:'mp4'|'gif'|'mp3', desc:[] }
// ---------------------------------------------------------------------------

function build(ops, meta, fontFile) {
  const w = meta.width || 1280
  const h = meta.height || 720
  const out = { vf: [], af: [], extraArgs: [], complex: null, output: 'mp4', desc: [] }
  // gif / boomerang own the whole filter graph — other visual filters can't combine
  const complexOver = ops.some((o) => o.kind === 'gif' || o.kind === 'boomerang')

  for (const op of ops) {
    if (complexOver && !['gif', 'boomerang', 'trim', 'mute', 'audioOut'].includes(op.kind)) continue
    out.desc.push(op.label)
    switch (op.kind) {
      case 'trim':
        // when combined with other visual filters, trim inside the graph so
        // the cut happens on the original timeline and filters apply after
        if (ops.some((o) => o !== op && (o.vf || o.kind === 'gif' || o.kind === 'boomerang'))) {
          if (!out._filterTrim) {
            out._filterTrim = true
            const a = op.from ?? 0
            const b = op.to
            const vtrim = `trim=start=${a}${b != null ? `:end=${b}` : ''},setpts=PTS-STARTPTS`
            out._trimFilters = { v: vtrim, a: `atrim=start=${a}${b != null ? `:end=${b}` : ''},asetpts=PTS-STARTPTS` }
          }
        } else {
          if (op.from != null) out.extraArgs.push('-ss', String(op.from))
          if (op.to != null) out.extraArgs.push('-to', String(op.to))
          if (op.to == null && op.from == null) out.extraArgs.push('-to', '5')
        }
        break
      case 'mute':
        out.extraArgs.push('-an')
        break
      case 'audioOut':
        out.output = 'mp3'
        break
      case 'rotate':
        out.vf.push(op.vf)
        break
      case 'aspect': {
        const ta = op.rx / op.ry
        let cw, ch
        if (w / h > ta) { ch = h; cw = even(h * ta) } else { cw = w; ch = even(w / ta) }
        out.vf.push(`crop=${cw}:${ch}:${Math.round((w - cw) / 2)}:${Math.round((h - ch) / 2)}`)
        if (out.output === 'mp4') {
          // rotated vertical videos: keep SAR correct after crop
          out.vf.push('setsar=1')
        }
        break
      }
      case 'gif':
        out.output = 'gif'
        out.complex = `[0:v]fps=${op.fps},scale=${op.width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`
        break
      case 'boomerang':
        out.complex = '[0:v]split[r][r2];[r]setsar=1[f];[r2]reverse,setsar=1[rv];[f][rv]concat=n=2:v=1:a=0'
        out.af = []
        out.extraArgs.push('-an')
        break
      case 'text': {
        // handled by makeTextOverlay (writes an .ass file); expect op.vf set
        if (op.vf) out.vf.push(op.vf)
        break
      }
      default:
        if (op.vf) out.vf.push(op.vf)
        if (op.af) out.af.push(op.af)
    }
  }

  if (out._filterTrim) {
    out.vf.unshift(out._trimFilters.v)
    if (out.output === 'mp4') out.af.unshift(out._trimFilters.a)
  }

  if (out.output === 'mp3') {
    // audio extraction: drop video filters
    out.vf = []
    out.complex = null
  }
  return out
}

// ---------------------------------------------------------------------------
// makeTextOverlay — write a styled .ass overlay per text op and swap the op
// into a `subtitles=<path>` video filter. Used because some ffmpeg builds
// (e.g. static ARM builds) lack drawtext but include libass.
// ---------------------------------------------------------------------------

function assTimestamp(sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const cs = Math.round((sec - Math.floor(sec)) * 100)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function makeTextOverlay(ops, meta, dir, duration) {
  const w = meta.width || 1280
  const h = meta.height || 720
  const align = { top: 8, center: 5, bottom: 2 }
  let i = 0
  for (const op of ops) {
    if (op.kind !== 'text') continue
    const size = Math.min(Math.max(18, op.size || 40), h * 0.9)
    const pos = op.pos || 'center'
    const name = `overlay-${++i}.ass`
    const end = (pos === 'center') ? 36000 : (duration || 36000) // top/bottom: as long as possible pairs with trim
    const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, BorderStyle, Encoding
Style: A,DejaVu Sans,${Math.round(size)},&H00FFFFFF,&H00101010,&H64000000,1,3,1,${align[pos]},${Math.round(w * 0.06)},${Math.round(w * 0.06)},${Math.round(h * 0.07)},1,1

[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,${assTimestamp(end)},A,0,0,0,,${String(op.text).replace(/\n/g, '\\N')}
`
    try {
      fs.writeFileSync(path.join(dir, name), ass)
      op.vf = `subtitles='${path.join(path.resolve(dir), name).replace(/\\/g, '/')}'`
    } catch (e) {
      console.error('[ai] ass overlay failed:', e.message)
      op.kind = null
    }
  }
  return ops.filter(Boolean)
}

// ---------------------------------------------------------------------------

const path = require('path')
const fs = require('fs')

const SYSTEM_PROMPT = `You are the AI assistant of "AI Clip Studio", a video editing web app. The user's messages are free-form: accept ANY request they type, in their own words and any language — both edit commands and questions.
Reply with ONLY JSON: {"ops":[...],"summary":"one friendly sentence"}.

Two cases:
1) The user asks for an edit → fill "ops" with a list of ffmpeg operations and make "summary" a short sentence describing what you did.
2) The user asks anything that is NOT an edit (questions about the clip like "how long is it", advice like "what edits would suit a tiktok", greetings, chit-chat, follow-up questions, anything else) → reply with a single op: {"kind":"chat","reply":"..."} where "reply" is a helpful conversational answer that uses the video metadata (duration, dimensions, audio, fps), e.g. suggest fitting edits. Never hallucinate edits you cannot express with the ops below.

Allowed edit operation kinds and their fields:
{"kind":"trim","from":seconds|null,"to":seconds|null}
{"kind":"speed","rate":number}
{"kind":"mute"}
{"kind":"volume","factor":number}
{"kind":"audioOut"}
{"kind":"mirror"} {"kind":"vflip"} {"kind":"rotate","deg":90|180|270}
{"kind":"aspect","rx":int,"ry":int}
{"kind":"scale","height":int}
{"kind":"text","text":"...","pos":"top|center|bottom","size":int,"color":"white"}
{"kind":"gif","fps":int,"width":int} {"kind":"reverse"} {"kind":"boomerang"}
{"kind":"fps","value":int} {"kind":"gray"} {"kind":"sepia"}
{"kind":"eq","brightness":-0.1..0.1|null,"saturation":0..2|null,"contrast":0.5..2|null}
{"kind":"blur","radius":int}
For ANY other visual or audio effect express it with a generic filter op so arbitrary user requests still work:
{"kind":"filter","vf":"<single ffmpeg video filter expression>","label":"short description"} — e.g. "eq=hue=0.2" for a hue shift, "vignette", "fade=t=in:st=0:d=1", "colorlevels=rimin=0.1", "curves=vintage", "chromashift", "tweak=hs=20", "hue=s=1.3", "crops" only via trim/aspect. The expression must be ONE filter or comma-joined filters, using only ffmpeg syntax (no quotes, no backslashes, no file paths).
{"kind":"afilter","af":"<single ffmpeg audio filter expression>","label":"short description"} — e.g. "bass=g=8", "aecho=0.8:0.7:60:0.5", "highpass=f=200", "compand". Same syntax restrictions.
Do not use file-based filters (drawtext with fontfile, subtitles, movie, amovie, opencl, overlay with images) — text overlays are handled by the built-in text op. Prefer the specific ops above when they fit; use filter/afilter only for effects they don't cover. You may chain multiple edits in one message.`

const FILTER_SAFE = /^[A-Za-z0-9 _=:/.,()+?*%!-]{0,500}$/
const FILTER_BLOCKED = /\b(file|protocol|opencl|movie|amovie|subtitles|drawtext|overlay|lavfi|protected|stdin|stdout)\b/i

function safeFilter(s) {
  if (typeof s !== 'string') return null
  s = s.trim()
  if (!s || s.length > 500) return null
  if (/[\\'"`$&|;<>{\r\n]/.test(s)) return null
  if (FILTER_SAFE.test(s) === false || FILTER_BLOCKED.test(s)) return null
  return s
}

const ALLOWED_KINDS = new Set(['trim', 'speed', 'mute', 'volume', 'audioOut', 'mirror', 'vflip', 'rotate', 'aspect', 'scale', 'text', 'gif', 'reverse', 'boomerang', 'fps', 'gray', 'sepia', 'eq', 'blur', 'filter', 'afilter', 'chat'])

const PROVIDERS = [
  {
    name: 'gemini',
    key: () => process.env.GEMINI_API_KEY,
    model: () => process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    _raw: async function (system, msgs, model) {
      const sys = { role: 'user', parts: [{ text: system }] }
      const toParts = (m) => ({ role: m.role, parts: [{ text: m.content }] })
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.key())}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: sys,
          contents: [...msgs.map(toParts), { parts: [{ text: 'Remember: answer ONLY with the JSON object.' }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
        }),
      })
      if (!r.ok) throw new Error(`gemini http ${r.status}: ${(await r.text()).slice(0, 300)}`)
      const j = await r.json()
      return j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || null
    },
    async call(system, msgs, model) {
      let last
      for (let i = 0; i < 3; i++) {
        try { return await this._raw(system, msgs, model) } catch (e) {
          if (!/http (429|5\d\d)/.test(e.message)) throw e
          last = e
          await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)))
        }
      }
      throw last
    },
  },
  {
    name: 'openai',
    key: () => process.env.OPENAI_API_KEY,
    model: () => process.env.OPENAI_MODEL || 'gpt-4o-mini',
    async call(system, msgs, model) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key()}` },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, ...msgs, { role: 'user', content: 'Remember: answer ONLY with the JSON object.' }],
        }),
      })
      if (!r.ok) throw new Error(`openai http ${r.status}`)
      const j = await r.json()
      return j.choices?.[0]?.message?.content || null
    },
  },
  {
    name: 'anthropic',
    key: () => process.env.ANTHROPIC_API_KEY,
    model: () => process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022',
    async call(system, msgs, model) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.key(), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 2048, system, messages: msgs }),
      })
      if (!r.ok) throw new Error(`anthropic http ${r.status}`)
      const j = await r.json()
      return j.content?.[0]?.text || null
    },
  },
]

function normalizeOps(parsed, mediaInfo) {
  const ops = (parsed.ops || []).filter((o) => o && ALLOWED_KINDS.has(o.kind))
  const chatOps = ops.filter((o) => o.kind === 'chat')
  if (chatOps.length && !ops.some((o) => o.kind !== 'chat')) {
    const reply = String(chatOps[0].reply || '').trim()
    if (reply) return { isChat: true, reply }
    return null
  }
  const usable = ops.filter((o) => o.kind !== 'chat').slice(0, 6)
  if (!usable.length) return null
  usable.forEach((o) => {
    const label = o.label || o.kind
    if (o.kind === 'rotate') {
      o.vf = o.deg === 90 ? 'transpose=1' : o.deg === 270 ? 'transpose=2' : 'transpose=1,transpose=1'
      o.label = `rotate ${o.deg}°`
    } else if (o.kind === 'speed' && o.rate > 1) {
      o.vf = `setpts=PTS/${o.rate}`
      o.af = `atempo=${atempoChain(o.rate).join(',atempo=')}`
      o.label = `${o.rate}× speed`
    } else if (o.kind === 'speed' && o.rate && o.rate < 1) {
      o.vf = `setpts=PTS/${o.rate}`
      o.af = `atempo=${atempoChain(o.rate).join(',atempo=')}`
      o.label = `${o.rate}× slow motion`
    } else if (o.kind === 'scale' && o.height) {
      o.vf = `scale=-2:${o.height}`
      o.label = `scale to ${o.height}p`
    } else if (o.kind === 'mute') { o.bareArgs = ['-an']; o.label = 'remove audio' }
    else if (o.kind === 'mirror') o.label = 'mirror'
    else if (o.kind === 'vflip') o.label = 'flip vertically'
    else if (o.kind === 'gray') { o.vf = 'hue=s=0'; o.label = 'black & white' }
    else if (o.kind === 'blur') { o.vf = `boxblur=${o.radius || 4}`; o.label = `blur ${o.radius || 4}` }
    else if (o.kind === 'gif') { o.outKind = 'gif'; o.fps = o.fps || 12; o.width = o.width || 480; o.label = `GIF @ ${o.fps}fps` }
    else if (o.kind === 'audioOut') { o.outKind = 'mp3'; o.label = 'export audio mp3' }
    else if (o.kind === 'text') { o.pos = ['top', 'center', 'bottom'].includes(o.pos) ? o.pos : 'center'; o.text = String(o.text || '').slice(0, 120); o.size = Math.min(Math.max(12, +o.size || 40), 200); o.label = `text "${(o.text || '').slice(0, 30)}" (${o.pos})` }
    else if (o.kind === 'trim') { o.from = o.from != null ? Math.max(0, +o.from || 0) : null; o.to = o.to != null && typeof mediaInfo.duration === 'number' ? Math.min(mediaInfo.duration, Math.max(0.1, +o.to || 0)) : (o.to != null ? Math.max(0.1, +o.to || 0) : null); o.label = o.label || `trim ${(o.from ?? 0)}s → ${o.to == null ? 'end' : o.to + 's'}` }
    else if (o.kind === 'volume') { o.label = `volume ${o.factor > 1 ? 'up' : 'down'}`; if (o.factor) o.af = `volume=${o.factor}` }
    else if (o.kind === 'fps') { o.label = `${o.value} fps`; if (o.value) o.vf = `fps=${o.value}` }
    else if (o.kind === 'eq') {
      const parts = []
      if (o.brightness) parts.push(`brightness=${o.brightness}`)
      if (o.saturation) parts.push(`saturation=${o.saturation}`)
      if (o.contrast) parts.push(`contrast=${o.contrast}`)
      if (parts.length) { o.vf = `eq=${parts.join(':')}`; o.label = o.label || 'color grade' } else { o.vf = null; o.kind = null }
    } else if (o.kind === 'filter') {
      const f = safeFilter(o.vf || o.value || o.filter)
      if (f) { o.vf = f; o.kind = 'filter'; o.label = o.label || f.split('=')[0] } else o.kind = null
    } else if (o.kind === 'afilter') {
      const f = safeFilter(o.af || o.value || o.filter)
      if (f) { o.af = f; o.kind = 'afilter'; o.label = o.label || f.split('=')[0] } else o.kind = null
    }
    if (o.kind === null) o._drop = true
    if (o.kind && !o.label) o.label = label
  })
  const final = usable.filter((o) => !o._drop)
  if (!final.length) return null
  return { ops: final, summary: parsed.summary || final.map((o) => o.label).join(' + '), isLLM: true }
}

async function understandWithLLM(message, meta, history) {
  const videoInfo = `Video is ${meta.duration}s, ${meta.width}x${meta.height}, ${meta.hasAudio ? 'has audio' : 'no audio'}, ${meta.fps || '?'}fps.`
  const system = SYSTEM_PROMPT + ' ' + videoInfo
  const msgs = [...history.slice(-8), { role: 'user', content: message }]
  for (const p of PROVIDERS) {
    if (!p.key()) continue
    try {
      const raw = await p.call(system, msgs, p.model())
      if (!raw) continue
      const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim()
      const parsed = JSON.parse(cleaned)
      const nx = normalizeOps(parsed, meta)
      if (nx) {
        if (nx.isChat) return { isChat: true, reply: nx.reply, isLLM: true, summary: '' }
        return nx
      }
      // model answered JSON but no usable ops — treat summary as a chat reply
      if (parsed && parsed.summary && !Array.isArray(parsed.ops)) {
        return { isChat: true, reply: String(parsed.summary), isLLM: true, summary: '' }
      }
    } catch (e) {
      console.error(`[ai] LLM provider "${p.name}" failed:`, e.message)
    }
  }
  return null
}

module.exports = { understand, understandWithLLM, build, makeTextOverlay }
