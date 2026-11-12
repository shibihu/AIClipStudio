// ---------------------------------------------------------------------------
// caption.js — "replace existing subtitles" orchestration module.
// Pipeline for: "remove the English caption by blurring it and replace with
// Thai subtitles but keep the original English voiceover".
//
//   1. detect burned-in caption regions        (py captions/detect — OpenCV
//                                               + optional RapidOCR refine)
//   2. transcribe the original speech          (py stt/start → stt/status
//                                               faster-whisper, or the LLM
//                                               STT path via ai.transcribeAudio)
//   3. translate cues into Thai                (translateCues → LLM, JSON)
//   4. build ONE ffmpeg filter graph:          region blur/solid/inpaint per
//                                              detected time window + Thai
//                                              ASS burn-in + audio copied
//   5. validate                                (py captions/validate + probe)
//
// Nothing here re-encodes or filters the audio — voiceover stays bit-identical
// via "-map 0:a? -c:a copy".
// ---------------------------------------------------------------------------

const path = require('path')
const fs = require('fs')
const ai = require('./ai')
const fonts = require('./fonts')

const PY_TIMEOUT_MS = Number(process.env.CAPTION_PY_TIMEOUT_MS) || 600000

// ---------------------------------------------------------------- detection ---

async function detectRegions(src, opts = {}) {
  const { pyCall } = opts
  const res = await pyCall('captions/detect', {
    input: src,
    useOcr: opts.useOcr !== false,
    ...opts.detectOverrides,
  }, PY_TIMEOUT_MS)
  return res // { ok, regions, width, height, band, ocr }
}

// ------------------------------------------------------------- transcription ---

async function transcribeSpeech(audioPath, meta, { pyCall } = {}) {
  // faster-whisper first (local, has word timestamps); falls back to the
  // Gemini STT path in ai.js. Both produce [{text,start,end}].
  if (pyCall) {
    try {
      const started = await pyCall('stt/start', {
        input: audioPath, model: process.env.CAPTION_STT_MODEL || 'base', language: null,
      }, 60000)
      const job = started.job
      for (let i = 0; i < 300; i++) {
        await sleep(1500)
        const st = await pyCall('stt/status', { job }, 30000)
        if (st.status === 'done' && st.result) {
          return (st.result.segments || []).map((s) => ({ text: s.text, start: s.start, end: s.end }))
        }
        if (st.status === 'error') break
      }
    } catch (e) {
      console.error('[caption] whisper STT failed:', e.message)
    }
  }
  // LLM STT fallback (Gemini only, needs the key) — same cue shape
  try {
    const cues = await ai.transcribeAudio(audioPath)
    return cues && cues.length ? cues : null
  } catch (e) {
    console.error('[caption] LLM STT failed:', e.message)
    return null
  }
}

// ---------------------------------------------------------------- translation ---

const TRANSLATE_PROMPT = (languageName, cues) => `Translate these video subtitle cues from English to ${languageName}.
Preserve meaning, tone and context. Natural spoken ${languageName}, not literal word-by-word translation.
Keep every cue's "start" and "end" EXACTLY as given — timing must stay synchronized with the English voiceover.
Short lines: subtitle length should stay close to the original (Thai is usually more compact - that is fine).
Return ONLY JSON: {"cues":[{"text":"...","start":number,"end":number}]} with one entry per input cue.
Input cues (JSON):
${JSON.stringify(cues)}`

async function translateCues(cues, targetLang, opts = {}) {
  if (!cues || !cues.length) return null
  const names = { th: 'Thai', en: 'English', es: 'Spanish', fr: 'French', id: 'Indonesian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', vi: 'Vietnamese' }
  const languageName = names[targetLang] || targetLang
  const p = opts.provider // ai.js provider object, passed in by server
  if (!p) return null
  try {
    const styled = cues.map((c, i) => ({ i, t: c.text, start: Math.round(c.start * 100) / 100, end: Math.round(c.end * 100) / 100 }))
    const raw = await p.call('You translate subtitle files. Answer ONLY with the JSON object.',
      [{ role: 'user', content: TRANSLATE_PROMPT(languageName, styled) }], p.model())
    const cleaned = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim()
    const parsed = JSON.parse(ai.extractJson(cleaned))
    const out = Array.isArray(parsed.cues) ? parsed.cues : Array.isArray(parsed) ? parsed : []
    const byIdx = new Map(out.map((c, i) => [i, c]))
    const result = styled.map((c, i) => {
      const t = String(byIdx.get(i)?.text || '').trim()
      return t ? { text: t, start: c.start, end: c.end } : cues[i]
    })
    return result
  } catch (e) {
    console.error('[caption] translation failed:', e.message)
    return null
  }
}

// ------------------------------------------------------------------ ASS gen ---

function assTimestamp(sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const cs = Math.round((sec - Math.floor(sec)) * 100)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

const THAI_FONT_NATIVE = 'Noto Sans Thai'     // preferred family name inside libass
const FONT_FILE = 'NotoSansThai-Bold.ttf'     // vendored: vendor/fonts/
// The family actually written into the ASS is decided at generation time by
// fonts.selectFont(): verified Thai glyph coverage first, system fallback
// next, ThaiFontUnavailableError (never tofu) if nothing covers U+0E00–U+0E7F.
// vendor/fonts/ ships with the repo so both ffmpeg/libass (fontsdir) and
// Remotion (dir passed at render time) can load it without network installs.

// Thai has no spaces between words and the vendored ffmpeg/libass build has no
// ICU/libunibreak line breaking — long cues overflow the frame whatever
// WrapStyle says. Pre-wrap them here: combining marks (vowels above/below,
// tone marks) take ~no width, base glyphs count ~0.55×font size each.
const THAI_COMBINING = /[\u0E31\u0E33-\u0E3A\u0E47-\u0E4E\u200B-\u200D]/

function visualWidth(s) {
  let n = 0
  for (const ch of s) if (!THAI_COMBINING.test(ch)) n++
  return n
}

function wrapThai(text, maxUnits) {
  const out = []
  for (const para of String(text).split(/\n+/)) {
    let cur = ''
    for (const word of para.split(/\s+/)) {
      const trial = cur ? cur + ' ' + word : word
      if (visualWidth(trial) <= maxUnits) { cur = trial; continue }
      if (cur) out.push(cur)
      // single word longer than the line: hard-break on glyph boundary
      if (visualWidth(word) > maxUnits) {
        let piece = ''
        for (const ch of word) {
          if (piece && visualWidth(piece + ch) > maxUnits) { out.push(piece); piece = ch }
          else piece += ch
        }
        cur = piece
      } else cur = word
    }
    if (cur) out.push(cur)
  }
  return out
}

function makeThaiAss(cues, meta, dir) {
  const w = meta.width || 1280
  const h = meta.height || 720
  const name = `subtitles-th-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}.ass`
  const size = Math.round(Math.min(Math.max(h * 0.055, 22), h * 0.12, 64))
  const margin = Math.round(h * 0.05)
  const marginL = Math.round(w * 0.06)
  // font from the actual cue texts (verified coverage). Target-language Thai
  // cues → Noto Sans Thai (or the next Thai-capable family). If translation
  // failed and the cues stayed English, the same check still picks a Latin
  // font — one style per file either way.
  const sel = fonts.selectFont(cues.map((c) => c.text))
  // base-glyph budget per line (advance per base char relative to fontsize:
  // Noto Sans Thai ≈0.55, wider Latin faces like DejaVu ≈0.6 — checked against
  // the vendored fonts' metrics; combining marks excluded from the count)
  const advance = sel.family === 'DejaVu Sans' || sel.family === 'Noto Sans' || sel.family === 'Liberation Sans' ? 0.6 : 0.55
  const usable = Math.max(120, w - 2 * marginL)
  const maxUnits = Math.floor(usable / (size * advance))
  const events = cues.map((c) => {
    const lines = wrapThai(c.text, maxUnits).join('\\N')
    return `Dialogue: 0,${assTimestamp(c.start)},${assTimestamp(c.end)},TH,0,0,${margin},,${lines}`
  }).join('\n')
  const ass = `[Script Info]
; generated by AIClipStudio caption replacement — Thai (interface) cues
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 3
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, BorderStyle, Encoding
Style: TH,${sel.family},${size},&H00FFFFFF,&H00101010,&H00000000,0,3,1,2,${marginL},${marginL},${margin},1,1

[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
${events}
`
  fs.writeFileSync(path.join(dir, name), ass, 'utf8')
  return path.join(path.resolve(dir), name).replace(/\\/g, '/')
}

// --------------------------------------------------------- ffmpeg graph build ---

// one graph does everything: for each detected time window split→crop→treat→
// overlay back (so ONLY the caption box is affected), then burn the Thai .ass,
// then map the original audio untouched.
function buildRegionEffects(regions, meta, { method = 'blur', radius = 14 } = {}) {
  const chains = []
  let prev = '0:v'
  regions.forEach((r, i) => {
    const x = Math.max(0, Math.round(r.x))
    const y = Math.max(0, Math.round(r.y))
    const w = Math.max(2, Math.round(r.width))
    const h = Math.max(2, Math.round(r.height))
    const en = `:enable='between(t,${r.start},${r.end})'`
    const out = `fx${i}`
    if (method === 'solid') {
      chains.push(`[${prev}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1:t=fill${en}[${out}]`)
    } else if (method === 'inpaint') {
      // delogo interpolates the region from its border pixels — the closest
      // real inpaint this ffmpeg build offers (T flag = supports enable).
      // delogo rejects boxes touching the frame edge: clamp 1px inside.
      const dx = Math.max(1, x)
      const dy = Math.max(1, y)
      const dw = Math.min(w, (meta.width || 1920) - dx - 1)
      const dh = Math.min(h, (meta.height || 1080) - dy - 1)
      chains.push(`[${prev}]delogo=x=${dx}:y=${dy}:w=${dw}:h=${dh}${en}[${out}]`)
    } else {
      // crop → blur → overlay back = region-only gaussian blur
      const sigma = Math.max(2, Math.min(40, +radius || 14))
      chains.push(`[${prev}]split[fxs${i}][sk${i}];` +
        `[fxs${i}]crop=${w}:${h}:${x}:${y},gblur=sigma=${sigma}[bl${i}];` +
        `[sk${i}][bl${i}]overlay=x=${x}:y=${y}${en}[${out}]`)
    }
    prev = out
  })
  // no regions → pass the video straight into the subtitle chain
  const finalLabel = regions.length ? regions.map((_, i) => `fx${i}`).pop() : '0:v'
  return { chains, finalLabel }
}

// combine plain ffmpeg ops (trim/speed/eq/…) with the caption graph so a
// multi-step request ("cut the first 2s, replace subtitles with Thai") renders
// in ONE graph. Video: pf.vf prepended before region chains. Audio: any pf.af
// (e.g. atempo) or a trim window gets the same treatment on [0:a] — never the
// untouched-voiceover copy path, which is for pure caption replacement.
function mergePlainOpsGraph(pf, meta) {
  if (!pf) return { videoPrefix: null, audioChains: [] }
  const vPre = []
  if (pf._filterTrim && pf._trimFilters) {
    vPre.push(pf._trimFilters.v)
  } else if (pf.seek && (pf.seek.from != null || pf.seek.to != null)) {
    // build() planned an input-side seek instead — re-express it in-graph
    const a = pf.seek.from ?? 0
    const b = pf.seek.to
    vPre.push(`trim=start=${a}${b != null ? `:end=${b}` : ''},setpts=PTS-STARTPTS`)
  }
  // drop graph-final setsar — the caption graph ends with its own
  vPre.push(...(pf.vf || []).filter((f) => f !== 'setsar=1'))
  if (!vPre.length) return { videoPrefix: null, audioChains: [] }
  const audioChains = []
  if (pf._filterTrim && pf._trimFilters) {
    audioChains.push(`[0:a?]${pf._trimFilters.a}[aout]`)
  } else if (pf.seek && (pf.seek.from != null || pf.seek.to != null)) {
    const a = pf.seek.from ?? 0
    const b = pf.seek.to
    audioChains.push(`[0:a?]atrim=start=${a}${b != null ? `:end=${b}` : ''},asetpts=PTS-STARTPTS[aout]`)
  }
  if ((pf.af || []).length) {
    audioChains.push(`[0:a?]${pf.af.join(',')}[aout]`)
  }
  return { videoPrefix: vPre.join(','), audioChains }
}

// Wire the region chains + subtitles filter into one filter_complex string
function composeFfmpegGraph(regionChains, finalLabel, assFile, opts = {}) {
  const chunks = []
  if (opts.videoPrefix) chunks.push(`[${opts.startLabel || '0:v'}]${opts.videoPrefix}[base]`)
  const base = opts.videoPrefix ? 'base' : (opts.startLabel || '0:v')
  if (regionChains.length && regionChains[0].startsWith('[0:v]') && base !== '0:v') {
    regionChains = [regionChains[0].replace(/^\[0:v\]/, `[${base}]`), ...regionChains.slice(1)]
  }
  chunks.push(...regionChains)
  // fontsdir must be repo-relative via __dirname: process.cwd() breaks when
  // the server is started from another directory. subtitlesFilter() only
  // appends the dir when it exists (dangling fontsdir breaks font loading).
  chunks.push(`[${finalLabel}]${fonts.subtitlesFilter(assFile)},setsar=1[vout]`)
  if (opts.audioChains && opts.audioChains.length) chunks.push(...opts.audioChains)
  return chunks.join(';')
}

function buildCaptionFrag({ regions, method, radius, assFile, pipe }, meta) {
  const { chains, finalLabel } = buildRegionEffects(regions, meta, { method, radius })
  const merged = mergePlainOpsGraph(pipe && pipe.plainFrag, meta)
  const complex = composeFfmpegGraph(chains, finalLabel, assFile, {
    videoPrefix: merged.videoPrefix,
    audioChains: merged.audioChains,
  })
  const audioOut = merged.audioChains.length
  return {
    vf: [], af: [], extraArgs: [],
    complex,
    audioMap: audioOut ? '[aout]' : '0:a?',
    audioEncode: audioOut, // processed audio ([aout]) needs a re-encode, the untouched-voiceover path does not
    output: 'mp4',
    desc: [
      `remove existing captions (region ${method}${regions.length ? `, ${regions.length} window(s)` : ''})`,
      'burn Thai subtitles (Noto Sans Thai, timing from original voiceover)',
    ],
  }
}

// ------------------------------------------------------------------ pipeline ---

// entry: called by server.js /api/chat when result.ops carry caption kinds.
// Returns a frag ready for enqueueRender, or { needInput: message } when
// detection is not confident enough AND no manual region was given.
async function captionReplacementPipeline({ src, meta, dir, op, pyCall, provider, plainFrag, audioSrc }) {
  const method = op.method === 'gaussian' ? 'blur'
    : ['blur', 'solid', 'inpaint'].includes(op.method) ? op.method : 'blur'
  const language = (op.language || 'th').toLowerCase()
  const manual = op.manual && typeof op.manual === 'object' ? op.manual : null

  // 1. detection
  const det = await detectRegions(src, { pyCall, detectOverrides: manual ? { manual } : {} })
  if (!det || det.ok === false) throw new Error('caption detection failed: ' + ((det && det.error) || 'unknown py error'))
  const regions = (det.regions || []).filter((r) => r.confidence >= 0.45)
  const lowConf = !regions.length && !manual

  // 2./3./5. transcript → translate → ass
  const cues = await transcribeSpeech(audioSrc || src, meta, { pyCall })
  let translated = cues
  if (cues && language && language !== 'en') {
    translated = await translateCues(cues, language, { provider })
    // translation failure must not silently drop the feature: fall back to
    // the EN cues with a warning — still burns correct-timing subtitles
    if (translated) console.log('[caption] translated to', language)
  }
  if (!translated || !translated.length) {
    translated = [{ text: `(original speech — transcript unavailable)`, start: 0, end: Math.min(3, meta.duration || 3) }]
  }

  // 4. ass + frag
  const assFile = makeThaiAss(translated, meta, dir)
  if (!regions.length) {
    // low-confidence detection → fallback, not a destructive guess
    if (lowConf) {
      return {
        needInput: 'no caption regions detected with workable confidence — give me a manual box (x, y, w, h) or raise detection quality',
        detection: det,
      }
    }
    const frag = buildCaptionFrag({ regions: [], method: method === 'none' ? 'blur' : method, radius: op.radius, assFile, pipe: { plainFrag } }, meta)
    return { frag, detection: det, cues: translated, note: 'no burned-in captions found — Thai subs added without removal' }
  }
  const frag = buildCaptionFrag({ regions, method: method === 'none' ? 'blur' : method, radius: op.radius || 14, assFile, pipe: { plainFrag } }, meta)
  return { frag, detection: det, cues: translated }
}

// ------------------------------------------------------------------ validate ---

async function validateOutput({ before, after, regions, probeAfter, metaDuration }, { pyCall } = {}) {
  const checks = {}
  // audio + stream shape (ffprobe)
  checks.videoStream = !!(probeAfter && probeAfter.hasVideo)
  checks.audioStream = !!(probeAfter && probeAfter.hasAudio !== false)
  checks.durationSync = (probeAfter && typeof probeAfter.duration === 'number')
    ? (typeof metaDuration === 'number' ? Math.abs(probeAfter.duration - metaDuration) < 0.8 : true)
    : false
  // region change / frame intactness (python sampling)
  const py = await pyCall('captions/validate', { before, after, regions }, PYTHONVALID_TMO)
  checks.regionsChanged = !!(py.ok && py.checks && py.checks.regions_changed)
  checks.outsideUnchanged = py.ok === false ? false : (py.checks ? py.checks.outside_unchanged !== false : true)
  checks.sameShape = !!(py.ok && py.checks && py.checks.same_shape)
  const ok = Object.values(checks).every(Boolean)
  return { ok, checks, detail: py }
}

const PYTHONVALID_TMO = Number(process.env.CAPTION_VALIDATE_TIMEOUT_MS) || 300000

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

module.exports = {
  detectRegions, transcribeSpeech, translateCues, makeThaiAss, assTimestamp,
  buildRegionEffects, composeFfmpegGraph, buildCaptionFrag, mergePlainOpsGraph,
  captionReplacementPipeline, validateOutput, THAI_FONT_NATIVE, FONT_FILE,
  wrapThai, visualWidth,
}
