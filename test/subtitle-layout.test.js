// test/subtitle-layout.test.js — shared subtitle layout engine regression
// tests. Covers the frame sizes and text shapes that used to overflow:
// long Thai without spaces, combining marks, long English, mixed language,
// numbers/punctuation/emoji, explicit multi-line cues and extreme cues.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const layout = require('../subtitle-layout')
const ai = require('../ai')
const captions = require('../caption')

const FRAMES = [
  [720, 1280],   // portrait
  [1080, 1920],  // tall portrait
  [1920, 1080],  // landscape
  [1080, 1080],  // square
  [1000, 300],   // unusual wide
  [300, 1000],   // unusual tall
]

const TEXTS = {
  longThaiNoSpaces: 'การทดสอบข้อความภาษาไทยยาวมากโดยไม่มีการเว้นวรรคเลยซึ่งอาจจะล้นออกนอกกรอบวิดีโอได้ง่ายมาก',
  thaiMarks: 'สวัสดีครับ ผมกำลังทดสอบสระบน สระล่าง วรรณยุกต์ ่ ้ ๊ ๋ ์ ำ',
  longEnglish: 'This is a very long English subtitle sentence that should wrap into at most two lines without overflowing the video frame at all.',
  mixed: 'Hello สวัสดีครับ 12345 67.89% mixed ภาษาไทย and English text that keeps going and going.',
  numbersPunctuation: 'ราคา ๑๒๕ บาท ครบ 100% (รวม VAT) — 2026! e-mail: test@example.com',
  emoji: 'ทดสอบอีโมจิ 😀🎬 และตัวเลข 12345 กับ English',
}

const THAI_MARK_START = /^[\u0E31\u0E33-\u0E3A\u0E47-\u0E4E]/

function assertInside(layoutResult, frame) {
  const { width, height } = frame
  assert.ok(layoutResult.fits, `layout does not fit ${width}x${height}`)
  assert.ok(layoutResult.maxLineWidth <= layoutResult.availableWidth + 0.5,
    `line ${layoutResult.maxLineWidth} > ${layoutResult.availableWidth}`)
  assert.ok(layoutResult.marginX >= Math.floor(width * 0.05) - 1,
    `horizontal margin ${layoutResult.marginX} below safe area`)
  assert.ok(layoutResult.blockTop >= layoutResult.topSafe - 0.5,
    `block top ${layoutResult.blockTop} above safe area ${layoutResult.topSafe}`)
  assert.ok(layoutResult.blockBottom <= height - layoutResult.bottomSafe + 0.5,
    `block bottom ${layoutResult.blockBottom} below safe area`)
  for (const line of layoutResult.lines) {
    assert.doesNotMatch(line, THAI_MARK_START, 'line starts with an orphaned Thai combining mark: ' + line)
  }
}

test('every listed resolution keeps normal cues inside the frame safe area', () => {
  for (const [width, height] of FRAMES) {
    for (const [name, text] of Object.entries(TEXTS)) {
      const l = layout.layoutCue(text, { width, height })
      assertInside(l, { width, height })
      // normal cues stay within the default two-line limit; only the
      // deliberately extreme cue below is allowed to use the emergency cap
      assert.ok(l.lineCount <= 2, `${width}x${height} ${name}: ${l.lineCount} lines`)
      assert.ok(l.fontSize >= 8 && l.fontSize <= 64)
    }
  }
})

test('portrait, landscape, square and arbitrary aspect ratios use the actual width', () => {
  const text = TEXTS.longThaiNoSpaces
  for (const [width, height] of FRAMES) {
    const l = layout.layoutCue(text, { width, height })
    assert.ok(l.availableWidth <= width * 0.9 + 1)
    assert.ok(l.availableWidth > width * 0.8)
    assertInside(l, { width, height })
  }
  const portrait = layout.layoutCue(text, { width: 1080, height: 1920 })
  const landscape = layout.layoutCue(text, { width: 1920, height: 1080 })
  assert.notEqual(portrait.fontSize, landscape.fontSize)
})

test('Thai vowels and tone marks never start a line', () => {
  const text = 'กำ ค้ำ น้ำ ทำ สระ วรรณยุกต์ ่ ้ ๊ ๋ ์  Hello ภาษาไทย'
  for (const [width, height] of FRAMES) {
    const l = layout.layoutCue(text, { width, height })
    assertInside(l, { width, height })
    for (const line of l.lines) {
      assert.doesNotMatch(line, THAI_MARK_START, 'orphaned mark in: ' + line)
      assert.notEqual([...line][0], '\u0E33', 'line starts with SARA AM: ' + line)
    }
  }
})

test('explicit multi-line cues keep their authored lines and stay bounded', () => {
  for (const [width, height] of FRAMES) {
    const l = layout.layoutCue('Hello world\nสวัสดีครับ', { width, height })
    assertInside(l, { width, height })
    assert.ok(l.lines.some((line) => line.includes('Hello')), 'first authored line lost')
    assert.ok(l.lines.some((line) => line.includes('สวัสดี')), 'second authored line lost')
  }
})

test('extremely long cues wrap instead of overflowing width or height', () => {
  const hugeThai = 'ภาษาไทยทดสอบ'.repeat(100)
  const hugeEnglish = ('A very long subtitle sentence with numbers 1234567890. ').repeat(40)
  for (const [width, height] of FRAMES) {
    for (const text of [hugeThai, hugeEnglish]) {
      const l = layout.layoutCue(text, { width, height })
      assertInside(l, { width, height })
      assert.ok(l.lineCount <= layout.DEFAULT_CONFIG.emergencyMaxLines ||
        l.fontSize <= layout.DEFAULT_CONFIG.absoluteMinFontSize,
        `extreme cue used ${l.lineCount} lines at ${l.fontSize}px`)
    }
  }
})

test('safe area and line limit are configurable', () => {
  const l = layout.layoutCue(TEXTS.longEnglish, { width: 1920, height: 1080 }, {
    safeAreaX: 0.1,
    maxLines: 3,
  })
  assert.ok(l.marginX >= 192, '10% horizontal safe area not applied')
  assert.ok(l.availableWidth <= 1920 * 0.8 + 2)
  assert.ok(l.lineCount <= 3)
  assertInside(l, { width: 1920, height: 1080 })
})

test('ASS output keeps cue timestamps byte-identical and pre-wraps every path', () => {
  const cues = [
    { text: TEXTS.longThaiNoSpaces, start: 0, end: 1.5 },
    { text: TEXTS.longEnglish, start: 1.5, end: 3.25 },
    { text: TEXTS.mixed, start: 3.25, end: 5 },
  ]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layoutass-'))
  const files = [
    ai.makeCaptionAss(cues, { width: 1080, height: 1920 }, dir),
    captions.makeThaiAss(cues, { width: 1080, height: 1920 }, dir),
  ]
  for (const vf of files) {
    const match = vf.match(/subtitles='([^']+)'/)
    const file = match ? match[1] : vf
    const text = fs.readFileSync(file, 'utf8')
    const dialogues = text.split('\n').filter((line) => line.startsWith('Dialogue:'))
    assert.equal(dialogues.length, cues.length)
    for (let i = 0; i < dialogues.length; i++) {
      const parts = dialogues[i].split(',')
      assert.equal(parts[1], layout.assTimestamp(cues[i].start), 'start timestamp changed')
      assert.equal(parts[2], layout.assTimestamp(cues[i].end), 'end timestamp changed')
      const body = parts.slice(8).join(',')
      assert.ok(body.includes('\\N') || layout.measureText(body, 64) <= 1080 * 0.9 + 1,
        'long cue was not pre-wrapped')
    }
    assert.match(text, /WrapStyle: 3/)
  }
})

test('makeCaptionAss and makeThaiAss share one layout result for the same cue', () => {
  const cue = [{ text: TEXTS.longThaiNoSpaces, start: 0, end: 2 }]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layoutsame-'))
  const read = (file) => {
    const match = file.match(/subtitles='([^']+)'/)
    return fs.readFileSync(match ? match[1] : file, 'utf8')
  }
  const cap = read(ai.makeCaptionAss(cue, { width: 720, height: 1280 }, dir))
  const thai = read(captions.makeThaiAss(cue, { width: 720, height: 1280 }, dir))
  const body = (text) => text.split('\n').find((line) => line.startsWith('Dialogue:'))
  const afterTime = (line) => line.split(',').slice(8).join(',')
  assert.equal(afterTime(body(cap)), afterTime(body(thai)))
})

test('measurement counts combining marks as zero-width and emoji as wide', () => {
  const base = layout.measureText('ก', 100, 'Noto Sans Thai')
  const marked = layout.measureText('ก่', 100, 'Noto Sans Thai')
  assert.equal(base, marked)
  assert.ok(layout.measureText('😀', 100, 'Noto Sans Thai') > base)
  assert.equal(layout.visualWidth('ั่'), 0)
  assert.equal(layout.visualWidth('กะ'), 2)
})
