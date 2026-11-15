// ---------------------------------------------------------------------------
// test/subtitle-layout.test.js — regression suite for caption geometry.
//
// The bug this suite locks down: users asked for centred captions and the
// generator silently used bottom alignment. Every position now has a numeric
// ASS alignment and the tests assert it directly, including Alignment 5 for
// `center`.
// ---------------------------------------------------------------------------

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  POSITIONS,
  DEFAULT_POSITION,
  ALIGNMENT_BY_POSITION,
  normalizePosition,
  normalizeMode,
  normalizeStyle,
  alignmentFor,
  positionLabel,
  colorToAss,
  parseSubtitleInstructions,
  wrapCueText,
  graphemeLength,
  resolveCaptionLayout,
  buildAssDocument,
  captionRegion,
} = require('../subtitle-layout')

const META_9x16 = { width: 1080, height: 1920, duration: 12 }
const META_16x9 = { width: 1280, height: 720, duration: 12 }

// --- position → alignment ----------------------------------------------------

test('positions: the seven supported placements have the ASS numeric-keypad alignment', () => {
  assert.deepEqual(POSITIONS, [
    'top_center', 'center', 'bottom_center',
    'top_left', 'top_right', 'bottom_left', 'bottom_right',
  ])
  assert.equal(alignmentFor('top_left'), 7)
  assert.equal(alignmentFor('top_center'), 8)
  assert.equal(alignmentFor('top_right'), 9)
  assert.equal(alignmentFor('center'), 5)
  assert.equal(alignmentFor('bottom_left'), 1)
  assert.equal(alignmentFor('bottom_center'), 2)
  assert.equal(alignmentFor('bottom_right'), 3)
})

test('positions: aliases resolve (Thai words, spaces, "middle", "centre")', () => {
  assert.equal(normalizePosition('TOP CENTER'), 'top_center')
  assert.equal(normalizePosition('centre'), 'center')
  assert.equal(normalizePosition('middle'), 'center')
  assert.equal(normalizePosition('bottom-left'), 'bottom_left')
  assert.equal(normalizePosition('กลางจอ'), 'center')
  assert.equal(normalizePosition('ด้านล่าง'), 'bottom_center')
  assert.equal(normalizePosition('มุมขวาบน'), 'top_right')
  assert.equal(normalizePosition('sideways'), null)
})

test('positions: no position → bottom_center default, never center', () => {
  assert.equal(DEFAULT_POSITION, 'bottom_center')
  const layout = resolveCaptionLayout({}, META_9x16)
  assert.equal(layout.position, 'bottom_center')
  assert.equal(layout.alignment, 2)
  assert.equal(layout.positionSource, 'default')
})

// --- explicit instruction parsing -------------------------------------------

test('instructions: English centre request wins over a bottom default', () => {
  const parsed = parseSubtitleInstructions('put the subtitles in the center of the screen')
  assert.equal(parsed.position, 'center')
  assert.equal(parsed.explicitPosition, true)

  const layout = resolveCaptionLayout(
    { instructions: 'put the subtitles in the center of the screen', position: 'bottom_center' },
    META_9x16,
  )
  assert.equal(layout.position, 'center')
  assert.equal(layout.alignment, 5)
  assert.equal(layout.positionSource, 'instructions')
  assert.ok(layout.warnings.some((w) => /instruction/.test(w)), 'conflict must be reported, not hidden')
})

test('instructions: top / bottom-left / top-right are all understood', () => {
  assert.equal(parseSubtitleInstructions('captions at the top').position, 'top_center')
  assert.equal(parseSubtitleInstructions('subs bottom left please').position, 'bottom_left')
  assert.equal(parseSubtitleInstructions('place text in the top right corner').position, 'top_right')
  assert.equal(parseSubtitleInstructions('centre the captions').position, 'center')
})

test('instructions: Thai positioning requests are understood and never ignored', () => {
  assert.equal(parseSubtitleInstructions('ใส่ซับไว้กลางจอ').position, 'center')
  assert.equal(parseSubtitleInstructions('วางคำบรรยายไว้ด้านบน').position, 'top_center')
  assert.equal(parseSubtitleInstructions('ย้ายซับไปมุมขวาล่าง').position, 'bottom_right')
  // Bare "บน"/"ล่าง" inside Thai words (no spaces, no ASCII word boundary).
  assert.equal(parseSubtitleInstructions('ใส่ซับมุมซ้ายบน').position, 'top_left')
  assert.equal(parseSubtitleInstructions('ใส่ซับมุมขวาบน').position, 'top_right')
  assert.equal(parseSubtitleInstructions('วางซับไว้บนสุด').position, 'top_center')
  assert.equal(parseSubtitleInstructions('วางซับไว้ล่างสุด').position, 'bottom_center')

  const layout = resolveCaptionLayout({ instructions: 'ใส่ซับไว้กลางจอ' }, META_9x16)
  assert.equal(layout.position, 'center')
  assert.equal(layout.alignment, 5)
})

test('instructions: style hints (size, lines, colour, box) are parsed', () => {
  const big = parseSubtitleInstructions('captions in the center, font size 48, 1 line, yellow text, with a background')
  assert.equal(big.position, 'center')
  assert.equal(big.style.fontSize, 48)
  assert.equal(big.style.maxLines, 1)
  assert.equal(big.style.textColor, '#FFE600')
  assert.equal(big.style.background, '#000000')
})

test('instructions: subtitle-specific wording flips add → replace only when explicit', () => {
  assert.equal(parseSubtitleInstructions('replace the existing subtitles').mode, 'replace')
  assert.equal(parseSubtitleInstructions('remove the old burned-in captions').mode, 'replace')
  assert.equal(parseSubtitleInstructions('ลบซับเดิมออก').mode, 'replace')
  assert.equal(parseSubtitleInstructions('keep the old subtitles and add new ones').mode, 'add')
  // unrelated destructive wording must never touch burned-in captions
  assert.equal(parseSubtitleInstructions('remove the background music').mode, null)
  assert.equal(parseSubtitleInstructions('delete the first 3 seconds').mode, null)
  assert.equal(normalizeMode('add'), 'add')
  assert.equal(normalizeMode('replace'), 'replace')
  assert.equal(normalizeMode('แทนที่'), 'replace')
  assert.equal(normalizeMode('nonsense'), null)
})

test('instructions: unknown requested position falls back with a warning', () => {
  const layout = resolveCaptionLayout({ position: 'sideways' }, META_9x16)
  assert.equal(layout.position, 'bottom_center')
  assert.ok(layout.warnings.length >= 1)
})

// --- style + safe margins ----------------------------------------------------

test('style: colours convert to ASS &HAABBGGRR', () => {
  assert.equal(colorToAss('#FFFFFF', 1), '&H00FFFFFF')
  assert.equal(colorToAss('#FF0000', 1), '&H000000FF')
  assert.equal(colorToAss('#00FF00', 1), '&H0000FF00')
  // 50% opacity background → alpha 0x80 in the high byte
  assert.match(colorToAss('#000000', 0.5), /^&H80000000$/)
})

test('style: values are clamped and safe margins scale with the frame', () => {
  const style = normalizeStyle({ fontSize: 5000, maxLines: 99, safeMarginX: 5, outlineWidth: -3 }, META_9x16)
  assert.ok(style.fontSize <= Math.round(1920 * 0.4))
  assert.equal(style.maxLines, 6)
  assert.equal(style.safeMarginX, 0.25)
  assert.equal(style.outlineWidth, 0)
  assert.equal(style.margins.x, Math.round(1080 * 0.25))
  assert.ok(style.margins.minX > 0)
})

test('style: background renders as an opaque box (BorderStyle 3)', () => {
  const layout = resolveCaptionLayout({ style: { background: '#000000', backgroundOpacity: 0.6 } }, META_9x16)
  const doc = buildAssDocument([{ text: 'boxed', start: 0, end: 1 }], META_9x16, layout)
  assert.match(doc, /Style: A,[^,]+,64,/)
  assert.match(doc, /,3,\d+,0,2,/) // BorderStyle=3 … Alignment=2
})

// --- ASS document ------------------------------------------------------------

test('ass: a center request produces Alignment 5 in the burned-in style', () => {
  const layout = resolveCaptionLayout({ position: 'center' }, META_9x16)
  const doc = buildAssDocument([{ text: 'Hello centre world', start: 0.5, end: 2.5 }], META_9x16, layout)
  assert.equal(layout.alignment, 5)
  assert.match(doc, /position center \(alignment 5\)/)
  // 4th style field is Alignment in our Format line
  const styleLine = doc.split('\n').find((l) => l.startsWith('Style: A,'))
  const fields = styleLine.split(',')
  const format = doc.split('\n').find((l) => l.startsWith('Format: Name,'))
  const alignmentIndex = format.split(',').findIndex((f) => f.trim() === 'Alignment')
  assert.equal(Number(fields[alignmentIndex]), 5)
  assert.match(doc, /Dialogue: 0,00:00:00\.50,00:00:02\.50,A,0,0,\d+,/)
})

test('ass: bottom_center stays Alignment 2 and margin-safe', () => {
  const layout = resolveCaptionLayout({}, META_9x16)
  const doc = buildAssDocument([{ text: 'lower third', start: 0, end: 1 }], META_9x16, layout)
  const styleLine = doc.split('\n').find((l) => l.startsWith('Style: A,'))
  const format = doc.split('\n').find((l) => l.startsWith('Format: Name,'))
  const idx = (name) => format.split(',').findIndex((f) => f.trim() === name)
  const fields = styleLine.split(',')
  assert.equal(Number(fields[idx('Alignment')]), 2)
  assert.equal(Number(fields[idx('MarginV')]), Math.round(1920 * 0.07))
  assert.equal(Number(fields[idx('MarginL')]), Math.round(1080 * 0.06))
})

test('ass: user text cannot inject override tags, and layers are honoured', () => {
  const layout = resolveCaptionLayout({ position: 'top_center', layer: 2 }, META_9x16)
  const doc = buildAssDocument([{ text: '{\\pos(0,0)}hack', start: 0, end: 1 }], META_9x16, layout)
  assert.ok(!doc.includes('{\\pos'), 'override tags must be neutralised')
  assert.match(doc, /Dialogue: 2,/)
})

test('ass: explicit newlines become \N and never exceed maxLines', () => {
  const layout = resolveCaptionLayout({ style: { maxLines: 2 } }, META_9x16)
  const doc = buildAssDocument([{ text: 'line one\nline two\nline three', start: 0, end: 1 }], META_9x16, layout)
  const dialogue = doc.split('\n').find((l) => l.startsWith('Dialogue:'))
  const text = dialogue.split(',,').pop()
  assert.equal(text.split('\\N').length, 2)
})

// --- Thai-aware wrapping -----------------------------------------------------

test('wrap: Thai wraps on dictionary words without splitting combining marks', () => {
  const text = 'สวัสดีครับ วันนี้อากาศดีมาก และเราจะไปเที่ยวทะเลด้วยกันนะ'
  const lines = wrapCueText(text, { maxChars: 24, maxLines: 2 })
  assert.equal(lines.length, 2)
  for (const line of lines) assert.ok(graphemeLength(line) <= 30, `line too wide: ${line}`)
  // no word loss (spaces are optional in Thai)
  const squash = (s) => s.replace(/\s+/g, '')
  assert.equal(squash(lines.join('')), squash(text))
  // a Thai grapheme cluster must never start with a combining mark
  for (const line of lines) assert.ok(!/^[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/.test(line))
})

test('wrap: long Thai sentence stays within maxLines and keeps every word', () => {
  const text = 'ในวันหยุดสุดสัปดาห์นี้เราจะไปเที่ยวทะเลที่จังหวัดประจวบคีรีขันธ์กับเพื่อน ๆ และจะถ่ายวิดีโอสั้น ๆ เก็บไว้'
  const lines = wrapCueText(text, { maxChars: 26, maxLines: 2 })
  assert.ok(lines.length <= 2)
  assert.equal(lines.join('').replace(/\s+/g, '').length, text.replace(/\s+/g, '').length)
})

test('wrap: English wraps on spaces and keeps words intact', () => {
  const lines = wrapCueText('This is a fairly long English caption that should wrap into two lines', { maxChars: 24, maxLines: 2 })
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.ok(line.length <= 40)
    for (const word of line.split(' ')) assert.ok('This is a fairly long English caption that should wrap into two lines'.includes(word))
  }
})

test('wrap: extremely long unbroken Thai token is split by graphemes, not bytes', () => {
  const text = 'ก'.repeat(80)
  const lines = wrapCueText(text, { maxChars: 20, maxLines: 1 })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].length, 80)
})

// --- geometry used for preview + verification --------------------------------

test('captionRegion: matches the requested anchor and respects margins', () => {
  const center = resolveCaptionLayout({ position: 'center' }, META_9x16)
  const centerBox = captionRegion(center, META_9x16)
  const centerMid = centerBox.y + centerBox.h / 2
  assert.ok(Math.abs(centerMid - 960) < 90, `centre box should straddle the middle, got ${centerMid}`)

  const bottom = resolveCaptionLayout({ position: 'bottom_center' }, META_9x16)
  const bottomBox = captionRegion(bottom, META_9x16)
  assert.ok(bottomBox.y > 1400, 'bottom captions live in the lower part of the frame')
  assert.ok(bottomBox.y + bottomBox.h <= 1920)

  const top = resolveCaptionLayout({ position: 'top_left' }, META_9x16)
  const topBox = captionRegion(top, META_9x16)
  assert.ok(topBox.y < 260)
})

test('ass: 16:9 and 9:16 frames both get PlayRes matching the source', () => {
  for (const meta of [META_9x16, META_16x9]) {
    const layout = resolveCaptionLayout({ position: 'center' }, meta)
    const doc = buildAssDocument([{ text: 'x', start: 0, end: 1 }], meta, layout)
    assert.match(doc, new RegExp(`PlayResX: ${meta.width}`))
    assert.match(doc, new RegExp(`PlayResY: ${meta.height}`))
  }
})

test('labels: every position has a human label', () => {
  for (const p of POSITIONS) assert.ok(positionLabel(p) && positionLabel(p).length > 2)
  assert.equal(positionLabel('center'), 'center')
  assert.equal(positionLabel('bottom_center'), 'bottom center')
  assert.equal(ALIGNMENT_BY_POSITION.center, 5)
})
