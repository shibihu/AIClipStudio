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

const path = require('path')
const fs = require('fs')

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
  // "shorten to 10s" names a target length; "5 seconds shorter" / "shorter by 5s"
  // name a delta to subtract from the current duration
  const shortenTo = s.match(/(?:short(?:er)?|shorten|shrink)\b.{0,30}\bto\b\s+(\d+(?:[.,]\d+)?)\s*(?:s\b|sec|secs|seconds?)?/)
  const shortenBy = s.match(/(?:short(?:er)?|shorten|shrink)\b.{0,15}\bby\s+(\d+(?:[.,]\d+)?)\s*(?:s\b|sec|secs|seconds?)?/)
  const shortenMinus = s.match(/(\d+(?:[.,]\d+)?)\s*(?:s\b|sec|secs|seconds?)?\s*short(?:er)?\b/)
  // legacy fallback: "shorten 10s" style (assumed to mean a target length)
  const shorten = s.match(/(?:short(?:er)?|shorten)\b.{0,30}?(\d+(?:[.,]\d+)?)\s*(?:s\b|sec|secs|second)/)

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
  } else if (shortenTo) {
    ops.push({ kind: 'trim', label: `keep only the first ${shortenTo[1]}s`, to: parseFloat(shortenTo[1].replace(',', '.')) })
    trimmed = true
  } else if ((shortenBy || shortenMinus) && typeof meta.duration === 'number') {
    const d = parseFloat((shortenBy ? shortenBy[1] : shortenMinus[1]).replace(',', '.'))
    ops.push({ kind: 'trim', label: `make it ${d}s shorter`, to: Math.max(0.1, meta.duration - d) })
    trimmed = true
  } else if (shorten) {
    ops.push({ kind: 'trim', label: `keep only the first ${shorten[1]}s`, to: parseFloat(shorten[1].replace(',', '.')) })
    trimmed = true
  }

  // ---- speed ----
  // "louder 2x"/"volume 2x" are audio intents — don't let the bare "2x" grab them.
  // Slow intent wins over a bare "Nx" fast path, otherwise "slower 2x" would
  // speed the clip up instead of slowing it down.
  const audioIntent = /(louder|quieter|volume|audio|sound)/.test(s)
  const slowIntent = /\bslow/.test(s)
  const rateM = audioIntent && !slowIntent ? null
    : s.match(/(\d+(?:[.,]\d+)?)\s*(?:x|×|times)\b/) || s.match(/speed\s*(?:it\s*)?(?:up|down)?\s*(?:by\s*)?(\d+(?:[.,]\d+)?)/)
  if (slowIntent) {
    const slowM = audioIntent ? null : s.match(/(\d+(?:[.,]\d+)?)\s*(?:x|×|times)/)
    const explicitRate = slowM ? parseFloat(slowM[1].replace(',', '.')) : null
    const isExplicit = explicitRate && explicitRate !== 1
    const rate = isExplicit ? 1 / explicitRate : 0.5
    // "2x slower" is easier to read than "0.5× slow motion"
    const label = isExplicit ? `${explicitRate}× slower` : `${rate}× slow motion`
    ops.push({ kind: 'speed', label, vf: `setpts=PTS*${(1 / rate).toFixed(3)}`, af: `atempo=${atempoChain(rate).join(',atempo=')}` })
  } else if (rateM && /(speed|fast|slow|x|×|times)/.test(s)) {
    const rate = parseFloat(rateM[1].replace(',', '.'))
    if (rate && rate > 1) {
      ops.push({ kind: 'speed', label: `${rate}× speed`, vf: `setpts=PTS/${rate}`, af: `atempo=${atempoChain(rate).join(',atempo=')}` })
    }
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
  // word boundaries: "make it shorter" must NOT match "short" (→ 9:16 crop)
  const wantVertical = /\b(?:tiktok|shorts?|reels?|instagram|vertical)\b/.test(s)
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
        } else if (!out.seek) {
          // input-side fast seek: `-ss` before `-i` re-encodes accurately
          // but skips decoding everything before the cut point
          out.seek = { from: op.from ?? null, to: op.to ?? null }
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
    // audio extraction: drop video filters; -an would leave zero streams
    // (mute + "export audio" must still produce a valid mp3)
    out.vf = []
    out.complex = null
    out.extraArgs = out.extraArgs.filter((a) => a !== '-an')
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
    // unique name per file: two concurrent edits on the same job must not
    // overwrite each other's overlay
    const name = `overlay-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}-${++i}.ass`
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
// makeCaptionAss — timed multi-cue `.ass` caption burn-in. The server places
// cues on detected speech segments (silencedetect), here we just render them.
// Returns the `subtitles=<path>` video filter expression.
// ---------------------------------------------------------------------------

function makeCaptionAss(cues, meta, dir) {
  const w = meta.width || 1280
  const h = meta.height || 720
  const name = `captions-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}.ass`
  const size = Math.round(Math.min(Math.max(h * 0.055, 20), h * 0.12, 64))
  const margin = Math.round(h * 0.07)
  const events = cues.map((c) =>
    `Dialogue: 0,${assTimestamp(c.start)},${assTimestamp(c.end)},A,0,0,${Math.round(h * 0.06)},,${String(c.text).replace(/\n/g, '\\N')}`
  ).join('\n')
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, BorderStyle, Encoding
Style: A,DejaVu Sans,${size},&H00FFFFFF,&H00101010,&H64000000,1,3,1,2,${Math.round(w * 0.05)},${Math.round(w * 0.05)},${margin},1,1

[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
${events}
`
  fs.writeFileSync(path.join(dir, name), ass)
  return `subtitles='${path.join(path.resolve(dir), name).replace(/\\/g, '/')}'`
}

// ---------------------------------------------------------------------------

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
Do not use file-based filters (drawtext with fontfile, subtitles, movie, amovie, opencl, overlay with images) — text overlays are handled by the built-in text op. Prefer the specific ops above when they fit; use filter/afilter only for effects they don't cover. You may chain multiple edits in one message.
When images are attached to the user's message they are frames sampled across the clip in order (first image = start of the clip, last = end). Use them to understand what actually happens in the video: for suggestions ("what edits would suit this?"), reference specific things you can see (subject, scene changes, framing, lighting, text already on screen). Never describe moments you cannot see in the frames or infer from metadata. When the user asks for the most engaging part, pick the segment(s), and prefer concrete ops (e.g. a trim keeping the liveliest frames) over vague advice.`

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

// --- LLM providers -------------------------------------------------------------
// Message `content` may be a plain string OR an array of typed parts for
// multi-modal (vision) requests:
//   { type:'text',  text }            — plain text
//   { type:'image', mime, data }      — base64 image (mime e.g. 'image/jpeg')
// Every provider unifies: (a) part conversion, (b) JSON-output instruction,
// (c) retry with exponential backoff on 429/5xx, (d) health reporting used by
// /api/health so the UI can show an "LLM unreachable" badge.

// per-request HTTP budget for LLM calls: a hung/stalled connection (bad route,
// IPv6 blackhole, proxy issues) fails in this window instead of Node fetch's
// ~5min default — 45s is enough for text+vision JSON answers. Override via env.
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 45000

const llmHealth = {
  reachable: null,            // null = never called; true = last call ok
  lastError: null,            // last error message
  lastErrorAt: 0,             // Date.now() of last failure
  lastOkAt: 0,                // Date.now() of last success
  provider: null,
}

function getLlmHealth() { return { ...llmHealth, aiKey: !!activeProvider() } }

function activeProvider() {
  for (const p of PROVIDERS) if (p.key()) return p
  return null
}

function noteLlmOk(provider) {
  llmHealth.reachable = true
  llmHealth.lastError = null
  llmHealth.lastOkAt = Date.now()
  llmHealth.provider = provider
}

function noteLlmError(provider, e) {
  llmHealth.reachable = false
  llmHealth.lastError = `${provider}: ${String(e.message || e).slice(0, 240)}`
  llmHealth.lastErrorAt = Date.now()
}

// retry transient failures (429 rate-limit / 5xx server errors) with backoff.
// 2 attempts × short backoff keeps the worst case per model ≈ 2 × LLM_TIMEOUT_MS;
// the Gemini provider already rotates to a fallback model after each throw.
async function withRetry(fn, { attempts = 2, baseMs = 1000 } = {}) {
  let last
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (e) {
      if (!/http (429|5\d\d)/.test(e.message)) throw e
      last = e
      await new Promise((ok) => setTimeout(ok, baseMs * (i + 1)))
    }
  }
  throw last
}

// typed content → provider-specific message bodies
function toGemini(content) {
  return { role: 'user', parts: partsOf(content).map((p) => p.type === 'image'
    ? { inline_data: { mime_type: p.mime, data: p.data } }
    : { text: p.text }) }
}

function partsOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return (content || []).map((p) => (p.type === 'image' ? { type: 'image', mime: p.mime, data: p.data } : { type: 'text', text: p.text }))
}

// gemini-2.5-flash was retired for new API keys; use the rolling "latest"
// aliases + a lighter fallback when the primary model is overloaded (503)
const GEMINI_PRIMARY = process.env.GEMINI_MODEL || 'gemini-flash-latest'
const GEMINI_FALLBACK = process.env.GEMINI_FALLBACK || 'gemini-flash-lite-latest'
const geminiModels = () => (GEMINI_PRIMARY === GEMINI_FALLBACK ? [GEMINI_PRIMARY] : [GEMINI_PRIMARY, GEMINI_FALLBACK])

const PROVIDERS = [
  {
    name: 'gemini',
    key: () => process.env.GEMINI_API_KEY,
    model: () => GEMINI_PRIMARY,
    async call(system, msgs, model) {
      let last
      for (const m of geminiModels()) {
        try {
          return await withRetry(async () => {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(this.key())}`, {
              method: 'POST',
              signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                systemInstruction: { role: 'user', parts: [{ text: system }] },
                contents: [...msgs.map((m2) => toGemini(m2.content)), { role: 'user', parts: [{ text: 'Remember: answer ONLY with the JSON object.' }] }],
                generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
              }),
            })
            if (!r.ok) throw new Error(`gemini http ${r.status}: ${(await r.text()).slice(0, 300)}`)
            const j = await r.json()
            return j.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || null
          })
        } catch (e) { last = e }
      }
      throw last
    },
  },
  {
    name: 'openai',
    key: () => process.env.OPENAI_API_KEY,
    model: () => process.env.OPENAI_MODEL || 'gpt-4o-mini',
    async call(system, msgs, model) {
      return withRetry(async () => {
        const toMsg = (m) => {
          const parts = partsOf(m.content).map((p) => p.type === 'image'
            ? { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } }
            : { type: 'text', text: p.text })
          return { role: m.role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts }
        }
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key()}` },
          body: JSON.stringify({
            model,
            response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: system }, ...msgs.map(toMsg), { role: 'user', content: 'Remember: answer ONLY with the JSON object.' }],
          }),
        })
        if (!r.ok) throw new Error(`openai http ${r.status}`)
        const j = await r.json()
        return j.choices?.[0]?.message?.content || null
      })
    },
  },
  {
    name: 'anthropic',
    key: () => process.env.ANTHROPIC_API_KEY,
    model: () => process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022',
    async call(system, msgs, model) {
      return withRetry(async () => {
        const toMsg = (m) => {
          const parts = partsOf(m.content).map((p) => p.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
            : { type: 'text', text: p.text })
          return { role: m.role, content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts }
        }
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
          headers: { 'content-type': 'application/json', 'x-api-key': this.key(), 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, max_tokens: 2048, system, messages: msgs.map(toMsg) }),
        })
        if (!r.ok) throw new Error(`anthropic http ${r.status}`)
        const j = await r.json()
        return j.content?.[0]?.text || null
      })
    },
  },
]

// an LLM op is rejected early when required fields are missing/implausible —
// otherwise it can pass through as a silent no-op ("Rendering: speed ⏳")
function validOp(o, hasAudio) {
  const F = (x) => Number.isFinite(+x)
  switch (o.kind) {
    case 'speed': return F(o.rate) && +o.rate > 0 && +o.rate !== 1 && +o.rate < 100
    case 'volume': return F(o.factor) && +o.factor > 0 && +o.factor !== 1 && +o.factor <= 100
    case 'fps': return F(o.value) && +o.value > 0 && +o.value <= 240
    case 'rotate': return [90, 180, 270, -90, -180, -270].includes(Math.round(+o.deg || 0))
    case 'scale': return F(o.height) && +o.height > 0 && +o.height <= 8640
    case 'aspect': return F(o.rx) && F(o.ry) && +o.rx > 0 && +o.ry > 0
    case 'text': return String(o.text || '').trim().length > 0
    case 'gif': return o.fps == null || +o.fps > 0 // clamped further in the loop
    case 'afilter': return hasAudio // nothing to filter on a muted/video-only clip
    default: return true // trim/mute/eq/filter/etc. are validated (or dropped) in the loop below
  }
}

function normalizeOps(parsed, mediaInfo) {
  const hasAudio = mediaInfo && mediaInfo.hasAudio !== false
  const ops = (parsed.ops || []).filter((o) => o && ALLOWED_KINDS.has(o.kind) && validOp(o, hasAudio))
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
      let d = Math.round(+o.deg || 0)
      if (d < 0) d += 360
      o.vf = d === 90 ? 'transpose=1' : d === 270 ? 'transpose=2' : 'transpose=1,transpose=1'
      o.label = `rotate ${d}°`
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
    else if (o.kind === 'blur') { const r = Math.max(1, Math.min(20, Math.round(+o.radius) || 4)); o.vf = `boxblur=${r}`; o.label = `blur ${r}` }
    else if (o.kind === 'gif') { o.outKind = 'gif'; o.fps = Math.max(1, Math.min(60, Math.round(+o.fps) || 12)); o.width = Math.max(32, Math.min(1280, Math.round(+o.width) || 480)); o.label = `GIF @ ${o.fps}fps` }
    else if (o.kind === 'audioOut') { o.outKind = 'mp3'; o.label = 'export audio mp3' }
    else if (o.kind === 'text') { o.pos = ['top', 'center', 'bottom'].includes(o.pos) ? o.pos : 'center'; o.text = String(o.text || '').trim().slice(0, 120); o.size = Math.min(Math.max(12, +o.size || 40), 200); o.label = `text "${(o.text || '').slice(0, 30)}" (${o.pos})` }
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

async function understandWithLLM(message, meta, history, frames) {
  const videoInfo =
    `Video is ${meta.duration}s, ${meta.width}x${meta.height}, ${meta.hasAudio ? 'has audio' : 'no audio'}, ${meta.fps || '?'}fps.` +
    (frames?.length ? ` ${frames.length} sample frames are attached (in clip order).` : '')
  const system = SYSTEM_PROMPT + ' ' + videoInfo
  const msgs = [...history.slice(-8), { role: 'user', content: message }]
  const p = activeProvider()
  if (!p) return null
  // attach vision frames to the final user message when provided
  if (Array.isArray(frames) && frames.length && typeof p.call !== 'undefined') {
    const parts = frames.map((f) => ({ type: 'image', mime: f.mime || 'image/jpeg', data: f.data }))
    parts.push({ type: 'text', text: 'These images are the sample frames (in clip order). Use them if relevant.' })
    msgs[msgs.length - 1] = { role: 'user', content: typeof msgs[msgs.length - 1].content === 'string'
      ? partsOfLast(message, parts)
      : msgs[msgs.length - 1].content.concat(parts) }
  }
  try {
    const raw = await p.call(system, msgs, p.model())
    noteLlmOk(p.name)
    if (!raw) return null
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim()
    const parsed = JSON.parse(extractJson(cleaned))
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
    noteLlmError(p.name, e)
  }
  return null
}

// build a text+images content array; put the question text first, images after
function partsOfLast(message, imageParts) {
  return [{ type: 'text', text: message }, ...imageParts]
}

// tolerate stray prose around the JSON object the model may emit
function extractJson(s) {
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  return a !== -1 && b !== -1 && b > a ? s.slice(a, b + 1) : s
}

// ---------------------------------------------------------------------------
// captions — pure cue math lives here (unit-testable); ffmpeg speech detection
// (silencedetect) stays in server.js. Two caption sources:
//   • pasted script  → buildCues(text) → server spreads them over speech segs
//   • STT transcript → transcribeAudio() → normalizeTranscriptCues(cues, meta)
// ---------------------------------------------------------------------------

function buildCues(text) {
  const cues = []
  const wrap = (s, max) => {
    const words = s.split(/\s+/)
    const out = []
    let cur = ''
    for (const w of words) {
      if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w } else cur = (cur ? cur + ' ' : '') + w
    }
    if (cur) out.push(cur)
    return out
  }
  for (let line of String(text || '').split(/\r?\n+/)) {
    line = line.trim()
    if (!line) continue
    cues.push(...wrap(line, 48))
  }
  return cues.slice(0, 80)
}

// spread cues across segments proportionaly to each segment's length
function placeCues(cues, segs) {
  const placed = []
  const total = segs.reduce((a, s) => a + (s[1] - s[0]), 0) || 1
  let ci = 0
  for (let i = 0; i < segs.length && ci < cues.length; i++) {
    const [a, b] = segs[i]
    let n = Math.max(1, Math.round(((b - a) / total) * cues.length))
    if (i === segs.length - 1) n = cues.length - ci // last segment takes the rest
    n = Math.max(1, Math.min(cues.length - ci, n))
    const d = (b - a) / n
    for (let k = 0; k < n && ci < cues.length; k++) {
      placed.push({ text: cues[ci++], start: a + k * d, end: a + (k + 1) * d })
    }
  }
  return placed
}

// --- speech-to-text captions (Gemini inline audio) -----------------------------
// Sends a small mono audio track to the configured LLM and asks for timestamped
// caption cues. Returns [{text, start, end}] or null (no key / any failure).
// The caller must have produced an ffmpeg-readable mpeg audio file first.

const STT_PROMPT = `You are a captioning engine. Transcribe ALL spoken words in this audio.
Return ONLY JSON (no markdown, no commentary): {"cues":[{"text":"...","start":0.0,"end":1.2}]}
Rules:
- start/end are numbers in seconds, relative to the audio start.
- One cue per natural caption: break at sentence ends or natural pauses, max ~12 words per cue.
- text contains only the spoken words (no speaker labels, no timestamps inside the text).
- Keep the original language. If there is no speech, return {"cues":[]}.`

async function transcribeAudio(audioPath, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const p = activeProvider()
  if (!p || p.name !== 'gemini') return null
  try {
    const buf = await fs.promises.readFile(audioPath)
    if (buf.length > maxBytes) { console.error('[ai] STT: audio too large', buf.length); return null }
    let raw = null
    let lastErr = null
    for (const model of geminiModels()) {
      try {
        raw = await withRetry(async () => {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(p.key())}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { role: 'user', parts: [{ text: 'You transcribe audio and answer ONLY with the JSON object.' }] },
              contents: [{
                role: 'user',
                parts: [
                  { inline_data: { mime_type: 'audio/mpeg', data: buf.toString('base64') } },
                  { text: STT_PROMPT },
                ],
              }],
              generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
            }),
          })
          if (!r.ok) throw new Error(`gemini http ${r.status}: ${(await r.text()).slice(0, 300)}`)
          const j = await r.json()
          return j.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('') || null
        })
        if (raw) break
      } catch (e) { lastErr = e }
    }
    if (!raw && lastErr) throw lastErr
    noteLlmOk(p.name)
    if (!raw) return null
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim()
    const parsed = JSON.parse(extractJson(cleaned))
    const cues = Array.isArray(parsed.cues) ? parsed.cues : Array.isArray(parsed) ? parsed : []
    const out = []
    for (const c of cues) {
      const text = String(c?.text || '').replace(/\s+/g, ' ').trim()
      const start = +c?.start, end = +c?.end
      if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
        out.push({ text, start: Math.max(0, start), end })
      }
    }
    return out
  } catch (e) {
    console.error('[ai] STT transcription failed:', e.message)
    noteLlmError(p.name, e)
    return null
  }
}

// turn raw STT cues into render-ready cue list:
//  • validate/clip timestamps to media duration, drop zero-length cues, sort
//  • wrap long lines into ≤ maxChars chunks spread evenly over the cue window
function normalizeTranscriptCues(cues, meta, { maxChars = 48, maxCues = 120 } = {}) {
  const dur = typeof meta?.duration === 'number' && meta.duration > 0 ? meta.duration : null
  const valid = (Array.isArray(cues) ? cues : [])
    .map((c) => ({
      text: String(c?.text || '').replace(/\s+/g, ' ').trim(),
      start: Math.max(0, +c?.start || 0),
      end: Math.max(0, +c?.end || 0),
    }))
    .filter((c) => c.text && c.end > c.start + 0.15 && (dur == null || c.start < dur))
    .map((c) => ({ text: c.text, start: c.start, end: dur != null ? Math.min(c.end, dur) : c.end }))
    .sort((a, b) => a.start - b.start)

  const out = []
  for (const c of valid) {
    const words = c.text.split(' ')
    const lines = []
    let cur = ''
    for (const w of words) {
      if (cur && (cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w } else cur = cur ? cur + ' ' + w : w
    }
    if (cur) lines.push(cur)
    const d = (c.end - c.start) / lines.length
    lines.forEach((text, i) => {
      if (out.length < maxCues) out.push({ text, start: +((c.start + i * d)).toFixed(2), end: +((c.start + (i + 1) * d)).toFixed(2) })
    })
    if (out.length >= maxCues) break
  }
  return out
}

module.exports = {
  understand, understandWithLLM, build, makeTextOverlay, makeCaptionAss,
  buildCues, placeCues, transcribeAudio, normalizeTranscriptCues,
  getLlmHealth, extractJson, safeFilter, normalizeOps,
}
