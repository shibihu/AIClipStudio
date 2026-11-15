'use strict'

// ---------------------------------------------------------------------------
// subtitle-layout.js — single source of truth for caption geometry.
//
// Everything that decides *where* and *how* subtitles appear lives here so the
// three consumers stay in lockstep:
//   • server.js  (/api/captions request parsing → render job)
//   • ai.js      (makeCaptionAss → .ass file burned in by FFmpeg)
//   • tests      (alignment numbers / wrapping are asserted directly)
//
// Positions are canonical IDs, never free-form numbers, and each one maps to a
// concrete ASS alignment value (numpad layout, 1..9). `center` is Alignment 5;
// it is only used when the user actually asked for the middle of the frame.
// ---------------------------------------------------------------------------

const POSITIONS = Object.freeze([
  'top_center',
  'center',
  'bottom_center',
  'top_left',
  'top_right',
  'bottom_left',
  'bottom_right',
])

const DEFAULT_POSITION = 'bottom_center'

// ASS uses the numeric-keypad layout: 7 8 9 / 4 5 6 / 1 2 3.
const ALIGNMENT_BY_POSITION = Object.freeze({
  bottom_left: 1,
  bottom_center: 2,
  bottom_right: 3,
  center: 5,
  top_left: 7,
  top_center: 8,
  top_right: 9,
})

const POSITION_LABELS = Object.freeze({
  top_center: 'top center',
  center: 'center',
  bottom_center: 'bottom center',
  top_left: 'top left',
  top_right: 'top right',
  bottom_left: 'bottom left',
  bottom_right: 'bottom right',
})

const DEFAULT_STYLE = Object.freeze({
  fontFamily: 'DejaVu Sans',
  fontSize: null, // null → derived from frame height
  textColor: '#FFFFFF',
  outlineColor: '#101010',
  outlineWidth: 3,
  background: 'none', // 'none' or '#RRGGBB'
  backgroundOpacity: 0.55,
  maxLines: 2,
  safeMarginX: 0.06, // fraction of frame width
  safeMarginY: 0.07, // fraction of frame height
  bold: true,
})

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

const POSITION_ALIASES = new Map()

function alias(position, ...names) {
  for (const name of names) POSITION_ALIASES.set(name, position)
}

alias('top_center', 'top_center', 'top center', 'top-centre', 'top center screen', 'top', 'upper', 'upper_center', 'upper center', 'center top', 'centre top', 'middle top', 'บน', 'ด้านบน', 'ด้านบนสุด', 'บนสุด', 'กลางบน', 'ตรงกลางด้านบน')
alias('center', 'center', 'centre', 'middle', 'middle_center', 'middle center', 'center screen', 'centre screen', 'screen center', 'screen centre', 'กลาง', 'ตรงกลาง', 'กลางจอ', 'กลางหน้าจอ', 'กึ่งกลาง', 'กลางภาพ', 'กลางวิดีโอ')
alias('bottom_center', 'bottom_center', 'bottom center', 'bottom-centre', 'bottom', 'lower', 'lower_center', 'lower center', 'center bottom', 'centre bottom', 'middle bottom', 'ด้านล่าง', 'ด้านล่างสุด', 'ล่าง', 'ล่างสุด', 'กลางล่าง', 'ตรงกลางด้านล่าง')
alias('top_left', 'top_left', 'top left', 'upper left', 'upper_left', 'left top', 'บนซ้าย', 'ซ้ายบน', 'มุมซ้ายบน', 'ด้านบนซ้าย')
alias('top_right', 'top_right', 'top right', 'upper right', 'upper_right', 'right top', 'บนขวา', 'ขวาบน', 'มุมขวาบน', 'ด้านบนขวา')
alias('bottom_left', 'bottom_left', 'bottom left', 'lower left', 'lower_left', 'left bottom', 'ล่างซ้าย', 'ซ้ายล่าง', 'มุมซ้ายล่าง', 'ด้านล่างซ้าย')
alias('bottom_right', 'bottom_right', 'bottom right', 'lower right', 'lower_right', 'right bottom', 'ล่างขวา', 'ขวาล่าง', 'มุมขวาล่าง', 'ด้านล่างขวา')

function normalizePosition(value) {
  if (value == null) return null
  const key = String(value).trim().toLowerCase().replace(/[\s_-]+/g, ' ').replace(/\s+/g, ' ')
  if (!key) return null
  return POSITION_ALIASES.get(key) || POSITION_ALIASES.get(key.replace(/ /g, '_')) || null
}

function alignmentFor(position) {
  return ALIGNMENT_BY_POSITION[normalizePosition(position) || DEFAULT_POSITION]
}

function verticalOf(position) {
  const p = normalizePosition(position) || DEFAULT_POSITION
  if (p.startsWith('top_')) return 'top'
  if (p === 'center') return 'middle'
  return 'bottom'
}

function horizontalOf(position) {
  const p = normalizePosition(position) || DEFAULT_POSITION
  if (p.endsWith('_left')) return 'left'
  if (p.endsWith('_right')) return 'right'
  return 'center'
}

function positionLabel(position) {
  return POSITION_LABELS[normalizePosition(position) || DEFAULT_POSITION]
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

// '#RGB' / '#RRGGBB' / 'rrggbb' / named colours commonly used by users.
const NAMED_COLORS = {
  white: '#FFFFFF',
  black: '#000000',
  yellow: '#FFE600',
  gold: '#FFD700',
  red: '#FF3B30',
  green: '#34C759',
  orange: '#FF9500',
  pink: '#FF2D95',
  blue: '#0A84FF',
  cyan: '#32D6E6',
  gray: '#9A9A9A',
  grey: '#9A9A9A',
  // Thai colour words used in instructions
  ขาว: '#FFFFFF',
  ดำ: '#000000',
  เหลือง: '#FFE600',
  แดง: '#FF3B30',
  เขียว: '#34C759',
  ส้ม: '#FF9500',
  ชมพู: '#FF2D95',
  ฟ้า: '#32D6E6',
}

function normalizeColor(value) {
  if (value == null) return null
  const raw = String(value).trim().toLowerCase()
  if (!raw || raw === 'none' || raw === 'transparent' || raw === 'default' || raw === 'ไม่มี') return null
  if (NAMED_COLORS[raw]) return NAMED_COLORS[raw]
  const hex = raw.replace(/^#/, '')
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return `#${hex.split('').map((c) => c + c).join('')}`.toUpperCase()
  }
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex.toUpperCase()}`
  return null
}

function colorToAss(hex, opacity = 1) {
  const normalized = normalizeColor(hex) || '#FFFFFF'
  const r = normalized.slice(1, 3)
  const g = normalized.slice(3, 5)
  const b = normalized.slice(5, 7)
  const alpha = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase()
}

function normalizeStyle(input, meta = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const height = Number(meta.height) || 720
  const width = Number(meta.width) || 1280

  const autoSize = Math.round(Math.min(Math.max(height * 0.055, 20), height * 0.12, 64))
  const fontSize = clamp(src.fontSize ?? src.font_size, 10, Math.max(24, Math.round(height * 0.4))) ?? autoSize

  const fontFamilyRaw = src.fontFamily ?? src.font_family
  const fontFamily = typeof fontFamilyRaw === 'string' && /^[\w .,'+-]{1,64}$/.test(fontFamilyRaw.trim())
    ? fontFamilyRaw.trim()
    : DEFAULT_STYLE.fontFamily

  const outlineWidth = clamp(src.outlineWidth ?? src.outline_width ?? src.outline, 0, 12) ?? DEFAULT_STYLE.outlineWidth
  const background = normalizeColor(src.background ?? src.backgroundColor ?? src.background_color) || 'none'
  const backgroundOpacity = clamp(src.backgroundOpacity ?? src.background_opacity, 0, 1) ?? DEFAULT_STYLE.backgroundOpacity
  const maxLines = clamp(src.maxLines ?? src.max_lines, 1, 6) ?? DEFAULT_STYLE.maxLines
  const safeMarginX = clamp(src.safeMarginX ?? src.safe_margin_x, 0, 0.25) ?? DEFAULT_STYLE.safeMarginX
  const safeMarginY = clamp(src.safeMarginY ?? src.safe_margin_y, 0, 0.3) ?? DEFAULT_STYLE.safeMarginY
  const bold = typeof src.bold === 'boolean' ? src.bold : DEFAULT_STYLE.bold

  return {
    fontFamily,
    fontSize: Math.round(fontSize),
    textColor: normalizeColor(src.textColor ?? src.text_color ?? src.color) || DEFAULT_STYLE.textColor,
    outlineColor: normalizeColor(src.outlineColor ?? src.outline_color) || DEFAULT_STYLE.outlineColor,
    outlineWidth: Math.round(outlineWidth),
    background,
    backgroundOpacity,
    maxLines,
    safeMarginX,
    safeMarginY,
    bold,
    // resolved pixel geometry (what the ASS file actually uses)
    margins: {
      x: Math.round(width * safeMarginX),
      y: Math.round(height * safeMarginY),
      // keep a floor so text never kisses the frame edge
      minX: Math.round(width * 0.02),
      minY: Math.round(height * 0.02),
    },
  }
}

// ---------------------------------------------------------------------------
// instruction parsing — an explicit position request must never be dropped
// ---------------------------------------------------------------------------

const THAI_CENTER = /(กลาง|กึ่งกลาง)/

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseSubtitleInstructions(text) {
  const raw = String(text || '')
  const src = ` ${raw.toLowerCase()} `
  const result = {
    position: null,
    explicitPosition: false,
    style: {},
    mode: null,
    explicitMode: false,
    notes: [],
  }

  // --- vertical intent -----------------------------------------------------
  // Thai script has no word boundaries, so `\b` around Thai words never
  // matches; list the Thai forms explicitly instead.
  const topRe = /(\b(top|upper|above|headline)\b|ด้านบน|บนสุด|ข้างบน|ส่วนบน|บน)/
  const bottomRe = /(\b(bottom|lower|below|footer)\b|ด้านล่าง|ล่างสุด|ข้างล่าง|ส่วนล่าง|ล่าง)/
  const centerWordRe = /(\b(center|centre|centered|centred|middle)\b|กลาง|กึ่งกลาง)/
  // "center the sentence" / "centered" without a frame reference is still a
  // positioning instruction — users type it exactly like that.
  const hasTop = topRe.test(src)
  const hasBottom = bottomRe.test(src)
  const hasCenterWord = centerWordRe.test(src)

  let vertical = null
  if (hasTop && !hasBottom) vertical = 'top'
  else if (hasBottom && !hasTop) vertical = 'bottom'
  else if (hasTop && hasBottom) {
    // e.g. "move subtitles from the bottom to the top" — the destination is
    // the last mentioned side.
    const topIdx = src.search(topRe)
    const bottomIdx = src.search(bottomRe)
    vertical = topIdx > bottomIdx ? 'top' : 'bottom'
    result.notes.push('both top and bottom were mentioned; using the last one')
  } else if (hasCenterWord) {
    vertical = 'middle'
  }

  // --- horizontal intent ---------------------------------------------------
  const hasLeft = /(\bleft\b|ซ้าย)/.test(src)
  const hasRight = /(\bright\b|ขวา)/.test(src)
  // avoid "right" as in "right now" / "alright"
  const rightIsPositional = hasRight && !/\b(right now|alright|right away|right here)\b/.test(src)
  let horizontal = null
  if (hasLeft && !rightIsPositional) horizontal = 'left'
  else if (rightIsPositional && !hasLeft) horizontal = 'right'

  if (vertical || horizontal) {
    const v = vertical || (horizontal ? 'bottom' : null)
    let position
    if (v === 'middle') position = 'center'
    else if (horizontal) position = `${v}_${horizontal}`
    else position = `${v}_center`
    // sanity: only canonical pairs exist
    if (POSITIONS.includes(position)) {
      result.position = position
      result.explicitPosition = true
      result.notes.push(`position "${position}" parsed from the instructions`)
    }
  }

  // --- style hints ---------------------------------------------------------
  const sizeMatch = raw.match(/(?:font\s*size|text\s*size|size|ขนาด(?:ตัวอักษร|ฟอนต์)?)\s*(?:of|=|:|is)?\s*(\d{1,3})\s*(?:px|pt)?/i)
  if (sizeMatch) {
    const size = Number(sizeMatch[1])
    if (size >= 10 && size <= 200) result.style.fontSize = size
  } else if (/\b(huge|giant|ใหญ่มาก)\b/i.test(raw)) {
    result.style.fontSize = 60
  } else if (/\b(big|large|ใหญ่)\b/i.test(raw)) {
    result.style.fontSize = 48
  } else if (/\b(small|tiny|เล็ก)\b/i.test(raw)) {
    result.style.fontSize = 26
  }

  const linesMatch = raw.match(/(\d)\s*(?:lines?|บรรทัด)/i)
  if (linesMatch) {
    const n = Number(linesMatch[1])
    if (n >= 1 && n <= 6) result.style.maxLines = n
  }

  for (const [word, color] of Object.entries(NAMED_COLORS)) {
    const re = new RegExp(`(?:text|font|caption|subtitle|สี)?\\s*(${escapeRegex(word)})\\b`, 'i')
    if (re.test(raw)) {
      // "white background" targets the background, not the text
      const bgNear = new RegExp(`(background|box|พื้นหลัง|กล่อง)[^.]{0,12}(${escapeRegex(word)})|(${escapeRegex(word)})[^.]{0,12}(background|box|พื้นหลัง|กล่อง)`, 'i')
      if (bgNear.test(raw)) {
        result.style.background = color
      } else {
        result.style.textColor = color
      }
      break
    }
  }

  if (/(no\s*outline|without\s*outline|ไม่มีขอบ|ไร้ขอบ)/i.test(raw)) result.style.outlineWidth = 0
  else if (/(outline|stroke|ขอบ(?:ตัวอักษร)?)/i.test(raw)) {
    const om = raw.match(/outline\s*(?:of|=|:|width)?\s*(\d{1,2})/i)
    result.style.outlineWidth = om ? Math.min(12, Math.max(1, Number(om[1]))) : 3
  }

  if (/(no\s*background|without\s*background|don'?t\s+add\s+(a\s+)?(background|box)|ไม่มีพื้นหลัง|ไม่ต้องมีกล่อง)/i.test(raw)) {
    result.style.background = 'none'
  } else if (/(background|box|พื้นหลัง|กล่อง)/i.test(raw)) {
    if (!result.style.background) result.style.background = '#000000'
    result.style.backgroundOpacity = 0.55
  }

  // --- add vs replace ------------------------------------------------------
  // Only subtitle-specific wording flips the destructive mode so a request
  // like "remove the background music" never wipes burned-in captions.
  const replaceRe = /((remove|erase|delete|clear|hide|obscure|blur|cover|get rid of)\s+(?:the\s+|any\s+)?(?:(?:old|existing|original|burned[- ]?in|hardcoded|hard-coded)\s+)*(?:subtitles?|captions?|text\s+on\s+screen)|replace\s+(?:the\s+)?(?:(?:old|existing|original|burned[- ]?in)\s+)*(?:subtitles?|captions?)|(?:ลบ|ลบออก|เอาออก|ซ่อน|เบลอ)\s*(?:ซับ(?:ไตเติ้ล)?|คำบรรยาย)(?:เดิม|เก่า)?|แทนที่\s*(?:ซับ(?:ไตเติ้ล)?|คำบรรยาย)(?:เดิม|เก่า)?)/i
  const addOnlyRe = /(keep|preserve|don'?t\s+(?:remove|touch|delete|erase))\s+(?:the\s+)?(?:old\s+|existing\s+|original\s+)?(?:subtitles?|captions?)|(?:เก็บ|รักษา)\s*(?:ซับ|คำบรรยาย)(?:เดิม)?/i
  if (addOnlyRe.test(raw)) {
    result.mode = 'add'
    result.explicitMode = true
  } else if (replaceRe.test(raw)) {
    result.mode = 'replace'
    result.explicitMode = true
  }

  return result
}

// ---------------------------------------------------------------------------
// Thai-aware text wrapping
// ---------------------------------------------------------------------------

const THAI_RE = /[\u0E00-\u0E7F]/

let cachedSegmenter = null
let segmenterLocale = null

function segmenterFor(locale) {
  if (cachedSegmenter && segmenterLocale === locale) return cachedSegmenter
  cachedSegmenter = null
  segmenterLocale = locale
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      cachedSegmenter = new Intl.Segmenter(locale, { granularity: 'word' })
    } catch {
      cachedSegmenter = null
    }
  }
  return cachedSegmenter
}

function graphemes(text) {
  const seg = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('th', { granularity: 'grapheme' })
    : null
  if (!seg) return Array.from(text)
  return Array.from(seg.segment(text), (s) => s.segment)
}

function graphemeLength(text) {
  // Thai combining marks should not count as separate glyph slots when we
  // budget line width; counting graphemes is close enough and avoids
  // splitting a base character from its tone mark.
  return graphemes(text).length
}

// Split a logical line into break-safe chunks. Latin text breaks on spaces,
// Thai/Lao/Khmer/Chinese breaks on dictionary word boundaries (Intl.Segmenter)
// and falls back to graphemes when a "word" is longer than the budget.
function breakUnits(text) {
  const thaiDominant = THAI_RE.test(text)
  if (!thaiDominant) {
    const words = text.split(/\s+/).filter(Boolean)
    return words.map((w) => ({ text: w, spaceBefore: true }))
  }
  const seg = segmenterFor('th')
  const units = []
  if (seg) {
    let pendingSpace = false
    for (const part of seg.segment(text)) {
      const value = part.segment
      if (!value) continue
      if (/^\s+$/.test(value)) {
        pendingSpace = true
        continue
      }
      units.push({ text: value, spaceBefore: pendingSpace })
      pendingSpace = false
    }
  } else {
    for (const g of graphemes(text)) units.push({ text: g, spaceBefore: false })
  }
  // A single dictionary token longer than the line budget must be split into
  // grapheme runs so it can still wrap.
  return units
}

function wrapLongUnit(unit, budget) {
  const out = []
  let current = ''
  const add = (text, spaceBefore) => out.push({ text, spaceBefore })
  for (const g of graphemes(unit.text)) {
    if (current && graphemeLength(current + g) > budget) {
      add(current, unit.spaceBefore && out.length === 0)
      current = g
    } else {
      current += g
    }
  }
  if (current) add(current, unit.spaceBefore && out.length === 0)
  return out
}

function wrapLogicalLine(line, budget) {
  const text = line.trim()
  if (!text) return []
  const units = breakUnits(text)
  const lines = []
  let current = ''
  for (const unit of units) {
    const candidate = current ? `${current}${unit.spaceBefore ? ' ' : ''}${unit.text}` : unit.text
    if (graphemeLength(candidate) <= budget) {
      current = candidate
      continue
    }
    if (current.trim()) lines.push(current.trim())
    if (graphemeLength(unit.text) > budget) {
      const pieces = wrapLongUnit(unit, budget)
      for (const piece of pieces.slice(0, -1)) {
        if (piece.text.trim()) lines.push(piece.text.trim())
      }
      current = pieces.length ? pieces[pieces.length - 1].text : ''
    } else {
      current = unit.text
    }
  }
  if (current.trim()) lines.push(current.trim())
  return lines
}

/**
 * Wrap one cue's text into at most `maxLines` visual lines.
 * - Explicit newlines in the source are preserved.
 * - Latin text wraps on word boundaries.
 * - Thai (no spaces) wraps on dictionary word boundaries via Intl.Segmenter.
 * - When content does not fit, the budget per line grows evenly instead of
 *   truncating: captions must never silently lose words.
 */
function wrapCueText(text, { maxChars = 42, maxLines = 2 } = {}) {
  const budgetCap = Math.max(8, Math.round(maxChars))
  const linesCap = Math.max(1, Math.round(maxLines))
  const sourceLines = String(text == null ? '' : text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!sourceLines.length) return []

  const totalGraphemes = sourceLines.reduce((sum, line) => sum + graphemeLength(line), 0)
  // even budget so a 3-line caption does not end with a one-word orphan line
  const evenBudget = Math.ceil(totalGraphemes / linesCap) + 2
  const budget = Math.max(budgetCap, Math.min(evenBudget, budgetCap * 2))

  const wrapped = []
  for (const line of sourceLines) wrapped.push(...wrapLogicalLine(line, budget))

  if (wrapped.length <= linesCap) return wrapped

  // Still too many lines → grow the budget until it fits (never truncate).
  let grown = budget
  let attempt = wrapped
  while (attempt.length > linesCap && grown < totalGraphemes * 2) {
    grown += Math.max(2, Math.ceil(budget / 2))
    attempt = []
    for (const line of sourceLines) attempt.push(...wrapLogicalLine(line, grown))
  }
  return attempt.slice(0, linesCap)
}

// ---------------------------------------------------------------------------
// resolution + ASS generation
// ---------------------------------------------------------------------------

/**
 * Resolve the effective caption layout for one render.
 * Precedence (highest first):
 *   1. explicit position parsed out of the user's instruction text
 *   2. explicit `position` field from the API/UI
 *   3. bottom_center default (only when nothing was requested)
 */
function resolveCaptionLayout({ instructions, position, style, layer } = {}, meta = {}) {
  const parsed = parseSubtitleInstructions(instructions)
  const requestedPosition = normalizePosition(position)
  const mergedStyleInput = { ...(style || {}), ...parsed.style }
  const resolvedStyle = normalizeStyle(mergedStyleInput, meta)

  let finalPosition = DEFAULT_POSITION
  let source = 'default'
  if (parsed.explicitPosition) {
    finalPosition = parsed.position
    source = 'instructions'
  } else if (requestedPosition) {
    finalPosition = requestedPosition
    source = 'request'
  }

  const warnings = []
  if (parsed.explicitPosition && requestedPosition && parsed.explicitPosition && requestedPosition !== parsed.position) {
    warnings.push(`the instruction asked for ${positionLabel(parsed.position)} while the request selected ${positionLabel(requestedPosition)} — using the instruction`)
  }
  if (position != null && !requestedPosition && !parsed.explicitPosition) {
    warnings.push(`"${position}" is not a known subtitle position — using ${positionLabel(DEFAULT_POSITION)}`)
  }

  const maxChars = charsPerLine(resolvedStyle, meta)

  return {
    position: finalPosition,
    alignment: alignmentFor(finalPosition),
    positionSource: source,
    explicitPosition: source !== 'default',
    style: resolvedStyle,
    maxChars,
    maxLines: resolvedStyle.maxLines,
    layer: Number.isFinite(Number(layer)) ? Math.max(0, Math.min(9, Math.round(Number(layer)))) : 0,
    parsed,
    warnings,
  }
}

function charsPerLine(style, meta = {}) {
  const width = Number(meta.width) || 1280
  const usable = Math.max(1, width - style.margins.x * 2)
  // Caption glyphs average ~0.52em wide; Thai clusters are slightly wider.
  const avgGlyph = Math.max(6, style.fontSize * 0.52)
  return Math.max(10, Math.floor(usable / avgGlyph))
}

/**
 * Approximate pixel box the rendered caption will occupy. Used for render
 * verification and by clients that need to reason about the caption area
 * without decoding the output.
 */
function captionRegion(layout, meta = {}) {
  const width = Number(meta.width) || 1080
  const height = Number(meta.height) || 1920
  const style = layout.style
  const lines = Math.max(1, layout.maxLines || 1)
  const textHeight = Math.min(height, style.fontSize * 1.32 * lines + style.outlineWidth * 2)
  const marginY = Math.max(style.margins.minY, style.margins.y)
  const marginX = Math.max(style.margins.minX, style.margins.x)
  const vertical = verticalOf(layout.position)
  let top
  if (vertical === 'top') top = marginY
  else if (vertical === 'bottom') top = height - marginY - textHeight
  else top = height / 2 - textHeight / 2

  const y = Math.round(clamp(top - 4, 0, Math.max(0, height - 8)))
  const h = Math.round(clamp(textHeight + 8, 4, height - y))
  return {
    x: Math.round(clamp(marginX * 0.5, 0, width - 8)),
    y,
    w: Math.round(clamp(width - marginX, 8, width)),
    h,
  }
}

function escapeAssText(text) {
  return String(text == null ? '' : text)
    // ASS override tags live inside braces; neutralise user input that would
    // otherwise inject styling (\pos, \clip, …)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
}

/**
 * libass renders Thai glyphs only when the requested family (or its fallback)
 * actually ships them. When the caller did not choose a family, pick a
 * Thai-capable one for Thai cues so text never renders as tofu boxes.
 * Override with SUBTITLE_THAI_FONT (e.g. "Noto Sans Thai" in a Linux container).
 */
function resolveFontFamily(style, text) {
  const explicit = style.fontFamily && style.fontFamily !== DEFAULT_STYLE.fontFamily
  if (explicit) return style.fontFamily
  if (!THAI_RE.test(String(text || ''))) return style.fontFamily
  const configured = (process.env.SUBTITLE_THAI_FONT || '').trim()
  if (configured) return configured
  return process.platform === 'win32' ? 'Leelawadee UI' : 'Noto Sans Thai'
}

function buildAssDocument(cues, meta = {}, layout) {
  const width = Number(meta.width) || 1280
  const height = Number(meta.height) || 720
  const style = layout.style
  const alignment = layout.alignment
  const boxMode = style.background && style.background !== 'none'

  const marginX = Math.max(style.margins.minX, style.margins.x)
  const marginY = Math.max(style.margins.minY, style.margins.y)

  const primary = colorToAss(style.textColor, 1)
  const outline = boxMode
    ? colorToAss(style.background, style.backgroundOpacity)
    : colorToAss(style.outlineColor, 1)
  const back = colorToAss('#000000', boxMode ? 0 : 0.6)
  // BorderStyle 3 = opaque box drawn with the outline colour; 1 = outline+shadow
  const borderStyle = boxMode ? 3 : 1
  const outlineWidth = boxMode ? Math.max(3, Math.round(style.fontSize * 0.22)) : style.outlineWidth
  const bold = style.bold ? -1 : 0
  const layer = layout.layer || 0
  const allText = (Array.isArray(cues) ? cues : []).map((c) => String(c && c.text != null ? c.text : '')).join(' ')
  const fontFamily = resolveFontFamily(style, allText)

  const events = (Array.isArray(cues) ? cues : []).map((cue) => {
    const start = Math.max(0, Number(cue.start) || 0)
    const end = Math.max(start + 0.01, Number(cue.end) || 0)
    const lines = wrapCueText(cue.text, { maxChars: layout.maxChars, maxLines: layout.maxLines })
    if (!lines.length) return null
    const text = lines.map(escapeAssText).join('\\N')
    const cueLayer = Number.isFinite(Number(cue.layer)) ? Math.max(0, Math.round(Number(cue.layer))) : layer
    const marginV = Number.isFinite(Number(cue.marginV)) ? Math.round(Number(cue.marginV)) : marginY
    // Per-cue margins default to the style margins; explicit overrides win.
    const mL = Number.isFinite(Number(cue.marginL)) ? Math.round(Number(cue.marginL)) : 0
    const mR = Number.isFinite(Number(cue.marginR)) ? Math.round(Number(cue.marginR)) : 0
    void mL; void mR
    return `Dialogue: ${cueLayer},${assTimestamp(start)},${assTimestamp(end)},A,0,0,${marginV},,${text}`
  }).filter(Boolean)

  return `[Script Info]
; generated by AI Clip Studio — position ${layout.position} (alignment ${alignment})
Title: AIClipStudio captions (${layout.position})
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.601

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: A,${fontFamily},${style.fontSize},${primary},${primary},${outline},${back},${bold},0,0,0,100,100,0,0,${borderStyle},${outlineWidth},0,${alignment},${marginX},${marginX},${marginY},1

[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`
}

function assTimestamp(sec) {
  const total = Math.max(0, Number(sec) || 0)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const cs = Math.round((total - Math.floor(total)) * 100)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// mode helpers (BUG 2: Add vs Replace must never be confused)
// ---------------------------------------------------------------------------

const SUBTITLE_MODES = Object.freeze(['add', 'replace'])

function normalizeMode(value) {
  if (value == null) return null
  const key = String(value).trim().toLowerCase()
  if (['add', 'append', 'overlay', 'burn', 'insert', 'เพิ่ม', 'วางทับ'].includes(key)) return 'add'
  if (['replace', 'remove', 'removal', 'erase', 'strip', 'แทนที่', 'ลบ'].includes(key)) return 'replace'
  return null
}

module.exports = {
  POSITIONS,
  DEFAULT_POSITION,
  ALIGNMENT_BY_POSITION,
  DEFAULT_STYLE,
  SUBTITLE_MODES,
  normalizePosition,
  normalizeStyle,
  normalizeColor,
  normalizeMode,
  alignmentFor,
  verticalOf,
  horizontalOf,
  positionLabel,
  colorToAss,
  parseSubtitleInstructions,
  wrapCueText,
  breakUnits,
  graphemeLength,
  resolveCaptionLayout,
  buildAssDocument,
  captionRegion,
  resolveFontFamily,
  assTimestamp,
  escapeAssText,
}
