// ---------------------------------------------------------------------------
// subtitle-layout.js — ONE layout engine for every caption/subtitle burn-in.
//
// The old generators (ai.makeCaptionAss, caption.makeThaiAss) each measured
// text differently and relied on libass wrapping. Thai has no spaces, so long
// cues overflowed the frame, and the two paths disagreed about margins, font
// size and line count. This module is the single source of truth:
//
//   frame → safe area → adaptive font size → line wrapping → vertical block
//
// Rules (all configurable, defaults match the native preview):
//   • 5% horizontal and vertical safe area
//   • max subtitle width = 90% of the video width
//   • default max 2 lines (an emergency cap is used only for extreme cues)
//   • Thai-aware word wrapping via Intl.Segmenter, with a cluster-safe
//     hard-break fallback so a combining mark never starts a line
//   • one ASS event per cue; timestamps are copied byte-for-byte
// ---------------------------------------------------------------------------

'use strict'

const THAI_RE = /[\u0E00-\u0E7F]/
const THAI_MARK_RE = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u200B-\u200D\uFE00-\uFE0F]/
const THAI_LEADING_RE = /[\u0E40-\u0E44]/
const THAI_BASE_RE = /[\u0E01-\u0E2E]/

const CLOSING_PUNCT_RE = /^[.,!?;:%)}\]…ๆฯ]+$/u
const OPENING_PUNCT_RE = /^[(\[{]+$/u
const THAI_MARK_ONLY_RE = /^[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]+$/u

const DEFAULT_CONFIG = Object.freeze({
  safeAreaX: 0.05,          // each side, fraction of frame width
  safeAreaTop: 0.05,        // fraction of frame height
  safeAreaBottom: 0.05,     // fraction of frame height
  maxWidthRatio: 0.90,      // never wider than 90% of the frame
  maxLines: 2,              // normal limit
  emergencyMaxLines: 4,     // last-resort limit for extremely long cues
  lineHeightRatio: 1.24,    // ASS/libass line advance relative to font size
  preferredFontRatio: 0.060,// of the short frame side
  minFontRatio: 0.022,      // adaptive shrink floor, of the short frame side
  absoluteMinFontSize: 8,   // px; only used by the extreme fallback
  maxFontSize: 64,          // px; preserves the existing typography ceiling
  widthSafetyFactor: 1.06,  // conservative glyph advance margin
  outline: 3,               // ASS outline size (also reserved in block height)
})

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function resolveFrame(meta = {}) {
  let width = Math.round(numberOr(meta.width, 0))
  let height = Math.round(numberOr(meta.height, 0))
  if (width <= 0 || height <= 0) {
    width = 1280
    height = 720
  }
  width = clamp(width, 16, 16384)
  height = clamp(height, 16, 16384)
  return { width, height, aspect: width / height }
}

function resolveConfig(meta = {}, opts = {}) {
  const supplied = (meta && typeof meta.subtitleLayout === 'object') ? meta.subtitleLayout : {}
  const c = { ...DEFAULT_CONFIG, ...supplied, ...opts }
  const out = {
    safeAreaX: clamp(numberOr(c.safeAreaX, DEFAULT_CONFIG.safeAreaX), 0, 0.4),
    safeAreaTop: clamp(numberOr(c.safeAreaTop, DEFAULT_CONFIG.safeAreaTop), 0, 0.4),
    safeAreaBottom: clamp(numberOr(c.safeAreaBottom, DEFAULT_CONFIG.safeAreaBottom), 0, 0.4),
    maxWidthRatio: clamp(numberOr(c.maxWidthRatio, DEFAULT_CONFIG.maxWidthRatio), 0.2, 1),
    maxLines: clamp(Math.round(numberOr(c.maxLines, DEFAULT_CONFIG.maxLines)), 1, 8),
    emergencyMaxLines: clamp(Math.round(numberOr(c.emergencyMaxLines, DEFAULT_CONFIG.emergencyMaxLines)), 1, 12),
    lineHeightRatio: clamp(numberOr(c.lineHeightRatio, DEFAULT_CONFIG.lineHeightRatio), 1.0, 2.0),
    preferredFontRatio: clamp(numberOr(c.preferredFontRatio, DEFAULT_CONFIG.preferredFontRatio), 0.02, 0.2),
    minFontRatio: clamp(numberOr(c.minFontRatio, DEFAULT_CONFIG.minFontRatio), 0.008, 0.1),
    absoluteMinFontSize: clamp(Math.round(numberOr(c.absoluteMinFontSize, DEFAULT_CONFIG.absoluteMinFontSize)), 4, 32),
    maxFontSize: clamp(Math.round(numberOr(c.maxFontSize, DEFAULT_CONFIG.maxFontSize)), 12, 256),
    widthSafetyFactor: clamp(numberOr(c.widthSafetyFactor, DEFAULT_CONFIG.widthSafetyFactor), 1, 1.5),
    outline: clamp(Math.round(numberOr(c.outline, DEFAULT_CONFIG.outline)), 0, 12),
  }
  out.emergencyMaxLines = Math.max(out.emergencyMaxLines, out.maxLines)
  return out
}

// ----------------------------------------------------------- glyph metrics ---

function isThaiMark(cp) {
  return (cp >= 0x0E31 && cp <= 0x0E3A) ||
    (cp >= 0x0E47 && cp <= 0x0E4E) ||
    (cp >= 0x200B && cp <= 0x200D) ||
    (cp >= 0xFE00 && cp <= 0xFE0F)
}

function isThaiLeading(cp) {
  return cp >= 0x0E40 && cp <= 0x0E44
}

function isThaiBase(cp) {
  return (cp >= 0x0E01 && cp <= 0x0E2E) || cp === 0x0E30 || cp === 0x0E32 ||
    cp === 0x0E33 || (cp >= 0x0E40 && cp <= 0x0E44)
}

// Advance width in em units. Deliberately conservative: the goal is that the
// real libass/Compose advance is never wider than the budget we plan with.
function charAdvance(cp) {
  if (isThaiMark(cp)) return 0
  if (cp === 0x20 || cp === 0x09) return 0.28
  if (cp === 0xA0) return 0.28
  if (cp >= 0x0E00 && cp <= 0x0E7F) return 0.56
  if (cp >= 0x30 && cp <= 0x39) return 0.56
  if (cp >= 0x41 && cp <= 0x5A) {
    if (cp === 0x49) return 0.32 // I
    if (cp === 0x4D || cp === 0x57) return 0.88 // M W
    return 0.64
  }
  if (cp >= 0x61 && cp <= 0x7A) {
    if ('iljtfr'.includes(String.fromCharCode(cp))) return 0.32
    if (cp === 0x6D || cp === 0x77) return 0.86 // m w
    return 0.54
  }
  if (cp === 0x25) return 0.72 // %
  if (cp === 0x26 || cp === 0x40) return 0.78 // & @
  if (cp === 0x2E || cp === 0x2C || cp === 0x3A || cp === 0x3B ||
      cp === 0x21 || cp === 0x27 || cp === 0x22) return 0.30
  if (cp === 0x28 || cp === 0x29 || cp === 0x5B || cp === 0x5D ||
      cp === 0x7B || cp === 0x7D || cp === 0x2D || cp === 0x2F) return 0.36
  if (cp >= 0x1F000 && cp <= 0x1FAFF) return 1.08
  if (cp >= 0x2600 && cp <= 0x27BF) return 1.00
  if (cp >= 0x1100 && cp <= 0x11FF) return 1.0
  if ((cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFF00 && cp <= 0xFFEF)) return 1.0
  return 0.58
}

function familyMetricFactor(family) {
  const f = String(family || '')
  if (/Thai/i.test(f)) return 1.0
  if (/DejaVu|Liberation|Noto Sans$/i.test(f)) return 1.06
  return 1.03
}

// UTF-16 code-point iteration, then grapheme-ish clusters for Thai:
// a leading vowel owns the following base, and every combining mark stays with
// the cluster before it. This is what prevents "่" from starting a line.
function codePoints(text) {
  const out = []
  for (const ch of String(text)) out.push(ch.codePointAt(0))
  return out
}

function graphemes(text) {
  const s = String(text)
  try {
    const seg = new Intl.Segmenter('th', { granularity: 'grapheme' })
    const out = []
    for (const part of seg.segment(s)) out.push(part.segment)
    return out
  } catch {
    return Array.from(s)
  }
}

function firstCodePoint(s) {
  return s.codePointAt(0)
}

function splitClusters(text) {
  const gs = graphemes(text)
  const out = []
  let pendingLeading = ''
  for (const g of gs) {
    if (!g) continue
    const first = firstCodePoint(g)
    if (isThaiLeading(first) && g.length === String.fromCodePoint(first).length) {
      if (pendingLeading) out.push(pendingLeading)
      pendingLeading = g
      continue
    }
    if (pendingLeading) {
      out.push(pendingLeading + g)
      pendingLeading = ''
      continue
    }
    if (isThaiMark(first) && out.length) {
      out[out.length - 1] += g
      continue
    }
    out.push(g)
  }
  if (pendingLeading) out.push(pendingLeading)
  return out
}

function clusterAdvance(cluster, family) {
  let em = 0
  for (const cp of codePoints(cluster)) em += charAdvance(cp)
  return em * familyMetricFactor(family)
}

function measureText(text, fontSize, family) {
  let em = 0
  for (const cluster of splitClusters(String(text || ''))) {
    em += clusterAdvance(cluster, family)
  }
  return em * Math.max(1, Number(fontSize) || 1)
}

function visualWidth(s) {
  let n = 0
  for (const cluster of splitClusters(String(s || ''))) {
    if (!isThaiMark(firstCodePoint(cluster))) n++
  }
  return n
}

// Backward-compatible helper used by older callers/tests. The ASS path uses
// the full layout engine below, not this character-count approximation.
function wrapThai(text, maxUnits) {
  const limit = Math.max(1, Math.round(Number(maxUnits) || 1))
  const out = []
  for (const para of String(text || '').split(/\n+/)) {
    let cur = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const trial = cur ? cur + ' ' + word : word
      if (visualWidth(trial) <= limit) { cur = trial; continue }
      if (cur) out.push(cur)
      if (visualWidth(word) > limit) {
        let piece = ''
        for (const cluster of splitClusters(word)) {
          if (piece && visualWidth(piece + cluster) > limit) {
            out.push(piece)
            piece = cluster
          } else {
            piece += cluster
          }
        }
        cur = piece
      } else {
        cur = word
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

// ------------------------------------------------------------- tokenisation ---

function wordSegments(text) {
  try {
    const seg = new Intl.Segmenter('th', { granularity: 'word' })
    const out = []
    for (const part of seg.segment(String(text))) out.push(part.segment)
    return out
  } catch {
    return String(text).split(/(\s+)/).filter((s) => s !== '')
  }
}

function tokenizeParagraph(paragraph) {
  const tokens = []
  let pendingSpace = false
  let prefix = ''
  for (const segment of wordSegments(paragraph)) {
    if (!segment) continue
    if (/^\s+$/u.test(segment)) {
      if (tokens.length) pendingSpace = true
      continue
    }
    if (THAI_MARK_ONLY_RE.test(segment) && tokens.length) {
      // Attach standalone combining marks to the preceding word; a line must
      // never begin with an orphaned Thai vowel or tone mark.
      const parent = tokens[tokens.length - 1]
      parent.text += (pendingSpace ? ' ' : '') + prefix + segment
      prefix = ''
      pendingSpace = false
      continue
    }
    if (CLOSING_PUNCT_RE.test(segment) && tokens.length) {
      tokens[tokens.length - 1].text += prefix + segment
      prefix = ''
      pendingSpace = false
      continue
    }
    if (OPENING_PUNCT_RE.test(segment)) {
      prefix += segment
      continue
    }
    tokens.push({
      text: prefix + segment,
      spaceBefore: pendingSpace && tokens.length > 0,
    })
    prefix = ''
    pendingSpace = false
  }
  if (prefix) {
    if (tokens.length) tokens[tokens.length - 1].text += prefix
    else tokens.push({ text: prefix, spaceBefore: false })
  }
  return tokens
}

function textParagraphs(text) {
  return String(text == null ? '' : text)
    .replace(/\\N/g, '\n')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((p) => p.trim())
    .filter((p, i, all) => p.length > 0 || (i > 0 && i < all.length - 1))
}

// Split a single word that is wider than one line at cluster boundaries only.
function splitWordToPieces(text, spaceBefore, fontSize, maxWidth, family) {
  const pieces = []
  let current = ''
  let currentWidth = 0
  let first = true
  for (const cluster of splitClusters(text)) {
    const width = clusterAdvance(cluster, family) * fontSize
    if (current && currentWidth + width > maxWidth) {
      pieces.push({ text: current, width: currentWidth, spaceBefore: first ? spaceBefore : false })
      first = false
      current = cluster
      currentWidth = width
    } else {
      current += cluster
      currentWidth += width
    }
  }
  if (current) pieces.push({ text: current, width: currentWidth, spaceBefore: first ? spaceBefore : false })
  return pieces
}

function buildPieces(paragraph, fontSize, maxWidth, family) {
  const pieces = []
  for (const token of tokenizeParagraph(paragraph)) {
    const width = measureText(token.text, fontSize, family)
    if (width <= maxWidth) {
      pieces.push({ text: token.text, width, spaceBefore: token.spaceBefore })
    } else {
      pieces.push(...splitWordToPieces(token.text, token.spaceBefore, fontSize, maxWidth, family))
    }
  }
  return pieces
}

// --------------------------------------------------------------- line break ---

function pieceLineWidth(pieces, start, end, spaceWidth) {
  let width = 0
  for (let k = start; k < end; k++) {
    width += pieces[k].width
    if (k > start && pieces[k].spaceBefore) width += spaceWidth
  }
  return width
}

// Dynamic-programming line breaker: minimises squared raggedness, never
// exceeds maxWidth, and returns the fewest lines that fit (1..maxLines).
function wrapPieces(pieces, maxWidth, maxLines, spaceWidth) {
  const n = pieces.length
  if (!n) return { lines: [''], widths: [0] }
  const prev = new Float64Array(n + 1).fill(Infinity)
  prev[0] = 0
  const backs = new Array(maxLines + 1)
  for (let line = 1; line <= maxLines; line++) {
    const cur = new Float64Array(n + 1).fill(Infinity)
    const back = new Int32Array(n + 1).fill(-1)
    for (let i = 1; i <= n; i++) {
      let width = 0
      for (let j = i - 1; j >= 0; j--) {
        width += pieces[j].width
        if (j < i - 1 && pieces[j + 1].spaceBefore) width += spaceWidth
        if (width > maxWidth) break
        if (prev[j] === Infinity) continue
        const slack = maxWidth - width
        const cost = prev[j] + slack * slack
        if (cost < cur[i]) {
          cur[i] = cost
          back[i] = j
        }
      }
    }
    backs[line] = back
    prev.set(cur)
    if (cur[n] !== Infinity) {
      const lines = []
      const widths = []
      let idx = n
      for (let l = line; l >= 1; l--) {
        const start = backs[l][idx]
        if (start < 0) return null
        lines.unshift(pieces.slice(start, idx).map((p, k) => (k > 0 && p.spaceBefore ? ' ' : '') + p.text).join(''))
        widths.unshift(pieceLineWidth(pieces, start, idx, spaceWidth))
        idx = start
      }
      return { lines, widths }
    }
  }
  return null
}

// --------------------------------------------------------------- public API ---

function fontSizeBounds(frame, config) {
  const shortSide = Math.min(frame.width, frame.height)
  const preferred = clamp(Math.round(shortSide * config.preferredFontRatio), 12, config.maxFontSize)
  const min = Math.max(config.absoluteMinFontSize,
    clamp(Math.round(shortSide * config.minFontRatio), config.absoluteMinFontSize, preferred))
  return { preferred, min }
}

function verticalMetrics(frame, config, fontSize, lineCount) {
  const topSafe = Math.max(1, Math.round(frame.height * config.safeAreaTop))
  const bottomSafe = Math.max(1, Math.round(frame.height * config.safeAreaBottom))
  const lineHeight = Math.max(1, Math.round(fontSize * config.lineHeightRatio))
  const blockHeight = lineCount * lineHeight + 2 * config.outline
  // Reserve one outline at the bottom so the stroke/shadow can never enter the
  // safe margin, and one at the top (the other outline is already in the
  // block height). This keeps the *visible* block inside the safe area.
  const available = Math.max(1, frame.height - topSafe - bottomSafe - config.outline)
  const capacity = Math.max(1, Math.floor(available / lineHeight))
  const blockBottom = frame.height - bottomSafe - config.outline
  const blockTop = blockBottom - blockHeight
  return {
    topSafe, bottomSafe, lineHeight, blockHeight, available, capacity,
    blockBottom, blockTop,
    fits: blockHeight <= available,
  }
}

function wrapCueAtSize(text, frame, config, family, fontSize, lineCap) {
  const paragraphs = textParagraphs(text)
  if (!paragraphs.length) paragraphs.push('')
  const widest = Math.max(1, Math.round(frame.width * (config.safeAreaX * 2)))
  const marginX = Math.max(1, Math.round(widest / 2))
  const maxWidth = Math.max(1, Math.min(frame.width - 2 * marginX, frame.width * config.maxWidthRatio))
  // Plan against a slightly narrower budget than the hard safe width so real
  // libass advances can never cross it.
  const budget = maxWidth / config.widthSafetyFactor
  const spaceWidth = charAdvance(0x20) * familyMetricFactor(family) * fontSize
  const allLines = []
  const allWidths = []
  for (const paragraph of paragraphs) {
    const pieces = buildPieces(paragraph, fontSize, budget, family)
    const wrapped = wrapPieces(pieces, budget, lineCap, spaceWidth)
    if (!wrapped) return null
    allLines.push(...wrapped.lines)
    allWidths.push(...wrapped.widths)
  }
  const vm = verticalMetrics(frame, config, fontSize, allLines.length)
  if (!vm.fits) return null
  return {
    lines: allLines,
    widths: allWidths,
    maxWidth,
    marginX,
    vertical: vm,
  }
}

function layoutCue(text, meta = {}, opts = {}) {
  const frame = resolveFrame(meta)
  const config = resolveConfig(meta, opts)
  const family = opts.family || 'sans'
  const { preferred, min } = fontSizeBounds(frame, config)
  const paragraphs = textParagraphs(text)
  const baseLineCap = Math.max(config.maxLines, paragraphs.length)

  let chosen = null
  let emergency = false

  // 1. Normal typography: largest size that fits the configured line limit.
  for (let size = preferred; size >= min; size--) {
    const wrapped = wrapCueAtSize(text, frame, config, family, size, baseLineCap)
    if (wrapped && wrapped.lines.length <= baseLineCap) {
      chosen = { size, ...wrapped }
      break
    }
  }

  // 2. Extreme cue: shrink below the normal floor and allow a few extra lines.
  if (!chosen) {
    emergency = true
    for (let size = min; size >= config.absoluteMinFontSize; size--) {
      const vm = verticalMetrics(frame, config, size, 1)
      const cap = Math.max(baseLineCap, Math.min(vm.capacity, config.emergencyMaxLines))
      const wrapped = wrapCueAtSize(text, frame, config, family, size, cap)
      if (wrapped && wrapped.lines.length <= cap) {
        chosen = { size, ...wrapped }
        break
      }
    }
  }

  // 3. Absolute last resort: use every line that physically fits the safe box.
  //    Width and height stay inside the frame; only the line count grows.
  if (!chosen) {
    emergency = true
    const size = config.absoluteMinFontSize
    const vm = verticalMetrics(frame, config, size, 1)
    // A pathological cue may need many very small lines. Grow the line budget
    // in two steps so normal extreme cues stay fast and only truly enormous
    // text pays for the full vertical capacity.
    for (const cap of [Math.min(vm.capacity, 64), vm.capacity]) {
      const lineCap = Math.max(baseLineCap, cap)
      const wrapped = wrapCueAtSize(text, frame, config, family, size, lineCap)
      if (wrapped && wrapped.lines.length <= lineCap) {
        chosen = { size, ...wrapped }
        break
      }
    }
  }

  if (!chosen) {
    // Should be unreachable for sane frames (a single glyph is narrower than
    // 90% of any frame). Fail loudly rather than emit an overflowing ASS file.
    throw new Error(`subtitle layout failed for ${frame.width}x${frame.height}: cue cannot fit the safe area`)
  }

  const maxLineWidth = chosen.widths.length ? Math.max(...chosen.widths) : 0
  return {
    text: String(text == null ? '' : text),
    frame,
    config,
    family,
    fontSize: chosen.size,
    lines: chosen.lines,
    lineWidths: chosen.widths,
    maxLineWidth,
    availableWidth: chosen.maxWidth,
    marginX: chosen.marginX,
    lineHeight: chosen.vertical.lineHeight,
    blockHeight: chosen.vertical.blockHeight,
    blockTop: chosen.vertical.blockTop,
    blockBottom: chosen.vertical.blockBottom,
    topSafe: chosen.vertical.topSafe,
    bottomSafe: chosen.vertical.bottomSafe,
    lineCount: chosen.lines.length,
    emergency,
    fits: maxLineWidth <= chosen.maxWidth + 0.5 &&
      chosen.vertical.blockTop >= chosen.vertical.topSafe - 0.5 &&
      chosen.vertical.blockBottom <= frame.height - chosen.vertical.bottomSafe + 0.5,
  }
}

function layoutTrack(cues, meta = {}, opts = {}) {
  const frame = resolveFrame(meta)
  const config = resolveConfig(meta, opts)
  const family = opts.family || 'sans'
  const { preferred } = fontSizeBounds(frame, config)
  const layouts = (Array.isArray(cues) ? cues : []).map((cue) =>
    layoutCue(cue && cue.text != null ? cue.text : '', frame, { ...config, family }))
  return { frame, config, family, preferredFontSize: preferred, layouts }
}

// ------------------------------------------------------------------ ASS out ---

function assTimestamp(sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const cs = Math.round((sec - Math.floor(sec)) * 100)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function escapeAss(text) {
  // Braces start override blocks in ASS; backslashes can become escape tags.
  // Keep the subtitle text literal so user-supplied captions cannot inject
  // positioning or colour commands into the generated file.
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
}

function buildAssTrack(cues, meta = {}, opts = {}) {
  const track = layoutTrack(cues, meta, opts)
  const styleName = opts.styleName || 'A'
  const style = {
    bold: opts.bold == null ? 1 : opts.bold ? 1 : 0,
    outline: opts.outline == null ? track.config.outline : opts.outline,
    shadow: opts.shadow == null ? 1 : opts.shadow,
    primaryColour: opts.primaryColour || '&H00FFFFFF',
    outlineColour: opts.outlineColour || '&H00101010',
    backColour: opts.backColour || '&H64000000',
    encoding: opts.encoding == null ? 1 : opts.encoding,
  }
  // Base style uses the largest adaptive size so per-cue shrink is an override.
  const styleSize = Math.max(...track.layouts.map((l) => l.fontSize), 1)
  const marginL = track.layouts.length ? track.layouts[0].marginX : Math.round(track.frame.width * track.config.safeAreaX)
  const marginV = (track.layouts.length ? track.layouts[0].bottomSafe
    : Math.round(track.frame.height * track.config.safeAreaBottom)) + track.config.outline
  const events = (Array.isArray(cues) ? cues : []).map((cue, i) => {
    const l = track.layouts[i]
    const fontOverride = l.fontSize !== styleSize ? `{\\fs${l.fontSize}}` : ''
    const text = l.lines.map(escapeAss).join('\\N')
    return `Dialogue: 0,${assTimestamp(cue.start || 0)},${assTimestamp(cue.end || 0)},${styleName},0,0,0,,${fontOverride}${text}`
  }).join('\n')
  const ass = `[Script Info]
; generated by AIClipStudio subtitle-layout — adaptive safe-area layout
ScriptType: v4.00+
PlayResX: ${track.frame.width}
PlayResY: ${track.frame.height}
WrapStyle: 3
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, BorderStyle, Encoding
Style: ${styleName},${track.family},${styleSize},${style.primaryColour},${style.outlineColour},${style.backColour},${style.bold},${style.outline},${style.shadow},2,${marginL},${marginL},${marginV},1,${style.encoding}

[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
${events}
`
  return { ass, track, styleSize, marginL, marginV }
}

module.exports = {
  DEFAULT_CONFIG, resolveFrame, resolveConfig, fontSizeBounds,
  splitClusters, measureText, visualWidth, wrapThai,
  layoutCue, layoutTrack, buildAssTrack, assTimestamp, escapeAss,
  THAI_RE, THAI_MARK_RE, THAI_LEADING_RE, THAI_BASE_RE,
}
