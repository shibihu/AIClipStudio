// test/fonts.test.js — language-aware font selection + ASS Thai integrity.
// Pure Node unit tests; the real ffmpeg burn lives in test/thai-render.test.js.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const fonts = require('../fonts')
const captions = require('../caption')
const ai = require('../ai')

const VENDOR = path.join(__dirname, '..', 'vendor', 'fonts')
const THAI_TTF = path.join(VENDOR, 'NotoSansThai-Bold.ttf')
const DV_TTF = path.join(VENDOR, 'DejaVuSans-Bold.ttf')

// injectable "everything missing" environment: no vendored dir, no fontconfig
const MISSING = {
  vendorDir: path.join(os.tmpdir(), 'fonts-missing-' + Date.now()),
  fcListCmd: '/nonexistent/fc-list',
  systemDirs: [path.join(os.tmpdir(), 'fonts-missing-sys-' + Date.now())],
}

// ---------------------------------------------------------------- detection ---

test('containsThai: ranges U+0E00–U+0E7F, punctuation, digits, marks', () => {
  assert.equal(fonts.containsThai('สวัสดีครับ'), true)
  assert.equal(fonts.containsThai('Hello'), false)
  assert.equal(fonts.containsThai(''), false)
  assert.equal(fonts.containsThai(null), false)
  // Thai punctuation ๆ (U+0E46) and digits ๐–๙ (U+0E50–U+0E59)
  assert.equal(fonts.containsThai('ๆ'), true)
  assert.equal(fonts.containsThai('๑๒๓'), true)
  // combining vowels/tone marks alone are still Thai text
  assert.equal(fonts.containsThai('\u0E31\u0E48'), true)
  // Latin punctuation must not read as Thai
  assert.equal(fonts.containsThai('.,!? 123'), false)
})

// ------------------------------------------------------------ cmap parsing ---

test('fontCovers: Noto Sans Thai covers Thai probes; DejaVu does not', () => {
  assert.ok(fs.existsSync(THAI_TTF), 'vendored NotoSansThai-Bold.ttf missing')
  assert.ok(fs.existsSync(DV_TTF), 'vendored DejaVuSans-Bold.ttf missing')
  assert.equal(fonts.fontCovers(THAI_TTF, fonts.THAI_PROBES), true)
  assert.equal(fonts.fontCovers(THAI_TTF, fonts.LATIN_PROBES), true) // Thai font also carries Latin
  assert.equal(fonts.fontCovers(DV_TTF, fonts.THAI_PROBES), false) // the tofu case
  assert.equal(fonts.fontCovers(DV_TTF, fonts.LATIN_PROBES), true)
})

test('fontCoverage: missing/unreadable font reports as not covering', () => {
  assert.equal(fonts.fontCovers('/nonexistent/font.ttf', fonts.LATIN_PROBES), false)
})

// -------------------------------------------------------------- selection ---

test('selectFont: Thai-only text → Noto Sans Thai', () => {
  const sel = fonts.selectFont('สวัสดีครับ')
  assert.equal(sel.family, 'Noto Sans Thai')
  assert.equal(sel.coversThai, true)
})

test('selectFont: English-only text → DejaVu Sans', () => {
  const sel = fonts.selectFont('Hello 123.')
  assert.equal(sel.family, 'DejaVu Sans')
  assert.equal(sel.coversThai, false)
})

test('selectFont: mixed Thai + English → Thai-capable font (single family per file)', () => {
  const sel = fonts.selectFont('สวัสดี Hello 123!')
  assert.equal(sel.family, 'Noto Sans Thai')
  assert.equal(sel.coversThai, true)
})

test('selectFont: cue arrays are checked as a union (one style per file)', () => {
  const sel = fonts.selectFont(['hello world', 'สวัสดีครับ', 'ok'])
  assert.equal(sel.family, 'Noto Sans Thai')
  assert.equal(fonts.selectFont(['hello', 'world 123']).family, 'DejaVu Sans')
})

test('selectFont: Thai text with NO Thai-capable font throws, never tofu', () => {
  assert.throws(() => fonts.selectFont('สวัสดีครับ', MISSING), (e) => {
    assert.equal(e.name, 'ThaiFontUnavailableError')
    // diagnostic must name what was tried and how to fix it
    assert.match(e.message, /Noto Sans Thai/)
    assert.match(e.message, /apt-get install -y fonts-noto-core/)
    assert.match(e.message, /pkg install font-noto/)
    return true
  })
  // the same missing environment must NOT hand Thai text to DejaVu
  let refused = false
  try { fonts.selectFont('ทดสอบ', MISSING) } catch (e) { refused = e.name === 'ThaiFontUnavailableError' }
  assert.ok(refused, 'fallback handed Thai text to a font without Thai coverage')
})

test('selectFont: Latin text still degrades gracefully when nothing is verifiable', () => {
  const sel = fonts.selectFont('Hello', MISSING)
  assert.equal(sel.family, 'DejaVu Sans')
  assert.equal(sel.file, null)
  assert.equal(sel.source, 'default')
})

test('selectFont: falls back through fontconfig when vendored copy is absent', () => {
  // fake fc-list binary: a shell script reporting a copy of the vendored font
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fcfake-'))
  const fakeFontDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcfont-'))
  const fakeFont = path.join(fakeFontDir, 'NotoSansThai-Bold.ttf')
  fs.copyFileSync(THAI_TTF, fakeFont)
  const script = path.join(bin, 'fc-list')
  fs.writeFileSync(script, `#!/bin/sh\necho '${fakeFont}: Noto Sans Thai:style=Bold'\n`)
  fs.chmodSync(script, 0o755)
  const sel = fonts.selectFont('สวัสดีครับ', { vendorDir: bin, fcListCmd: script, systemDirs: [] })
  assert.equal(sel.family, 'Noto Sans Thai')
  assert.equal(sel.source, 'fontconfig')
  assert.equal(sel.file, fakeFont)
})

// ---------------------------------------------------------------- ASS gen ---

const THAI_CUES = [
  { text: 'สวัสดีครับ ยินดีต้อนรับ', start: 0, end: 1.5 },
  { text: 'สระบน สระล่าง วรรณยุกต์ สามพัน', start: 1.5, end: 3 },
  { text: 'ราคา ๑๒๕ บาท ครึ่ง. ปี 2026!', start: 3, end: 4.5 },
  { text: 'Mixed Thai–English: กาแฟ latte 60%', start: 4.5, end: 6 },
  { text: 'บรรทัดยาวเกินความกว้างของเฟรมจะถูกตัดเป็นหลายบรรทัดอัตโนมัติเพื่อไม่ให้ล้นขอบจอ', start: 6, end: 9 },
]

test('makeThaiAss: UTF-8 integrity — vowels, tone marks, digits, punctuation survive byte-exact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thaifont-'))
  const file = captions.makeThaiAss(THAI_CUES, { width: 640, height: 360 }, dir)
  const text = fs.readFileSync(file, 'utf8')
  // comparison is whitespace-insensitive: Thai has no inter-word spaces and
  // wrapThai may hard-break a word across lines without inserting one
  const strip = (s) => String(s).replace(/\\N/g, '').replace(/\s+/g, '')
  const flat = strip(text)
  for (const c of THAI_CUES) {
    assert.ok(flat.includes(strip(c.text)), 'cue text corrupted: ' + c.text)
  }
  assert.doesNotMatch(text, /\uFFFD/) // no replacement characters
  assert.doesNotMatch(text, /DejaVu/) // hardcoded Latin font is gone
  // the written file is byte-exact UTF-8 (BOM would break some libass builds)
  const buf = fs.readFileSync(file)
  assert.deepEqual([buf[0], buf[1], buf[2]], [0x5B, 0x53, 0x63]) // "[Sc" — no BOM
})

test('makeThaiAss: multi-line wrap splits long Thai cues on the frame budget', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thaifont-'))
  const file = captions.makeThaiAss(THAI_CUES, { width: 640, height: 360 }, dir)
  const text = fs.readFileSync(file, 'utf8')
  const long = text.split('\n').find((l) => l.startsWith('Dialogue:') && l.includes('บรรทัดยาว'))
  assert.ok(long, 'long cue missing')
  assert.ok(long.includes('\\N'), 'long Thai cue was not pre-wrapped')
})

test('makeThaiAss: font family is chosen from the cues, verified for Thai coverage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thaifont-'))
  const file = captions.makeThaiAss(THAI_CUES, { width: 640, height: 360 }, dir)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /Style: TH,Noto Sans Thai,/)
  // and the family we wrote is one the module verifies for Thai glyphs
  const fam = text.match(/Style: TH,([^,]+),/)[1]
  const sel = fonts.selectFont('สวัสดี')
  assert.ok(fam === sel.family || fonts.fontCovers(fonts.selectFont('สวัสดี').file, fonts.THAI_PROBES))
})

test('wrapThai: keeps combining marks attached to their base glyph', () => {
  // word with marks must never start a line with a lone tone mark
  const lines = captions.wrapThai('ครับ ทำงานที่บ้าน', 6)
  for (const l of lines) {
    assert.ok(!/^[\u0E31\u0E33-\u0E3A\u0E47-\u0E4E]/.test(l), 'line starts with an orphaned combining mark: ' + l)
  }
  assert.equal(captions.visualWidth('ั่'), 0) // marks take no width
  assert.equal(captions.visualWidth('กะ'), 2)
})

// --------------------------------------------------- ai.js ASS generators ---

test('makeTextOverlay: Thai text picks a Thai-capable family and adds fontsdir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-'))
  const ops = [{ kind: 'text', text: 'สวัสดีชาวโลก', size: 40, pos: 'center', label: 'text' }]
  const out = ai.makeTextOverlay(ops, { width: 640, height: 360 }, dir, 10)
  assert.equal(out.length, 1)
  assert.match(out[0].vf, /^subtitles='.*\.ass':fontsdir=/)
  const assName = out[0].vf.match(/subtitles='([^']+)'/)[1]
  const text = fs.readFileSync(assName, 'utf8')
  assert.match(text, /Style: A,Noto Sans Thai,/)
  assert.ok(text.includes('สวัสดีชาวโลก'))
})

test('makeTextOverlay: English text keeps DejaVu Sans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-'))
  const ops = [{ kind: 'text', text: 'Good vibes', size: 40, pos: 'top', label: 'text' }]
  const out = ai.makeTextOverlay(ops, { width: 640, height: 360 }, dir, 10)
  const text = fs.readFileSync(out[0].vf.match(/subtitles='([^']+)'/)[1], 'utf8')
  assert.match(text, /Style: A,DejaVu Sans,/)
})

test('makeTextOverlay: no Thai font available → op degrades with a diagnostic, no tofu burn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-'))
  const ops = [{ kind: 'text', text: 'สวัสดีชาวโลก', size: 40, pos: 'center', label: 'text' }]
  // stub selectFont to simulate a Thai-less system
  const orig = fonts.selectFont
  fonts.selectFont = (t, o) => orig(t === 'สวัสดีชาวโลก' ? t : t, { ...MISSING })
  try {
    const out = ai.makeTextOverlay(ops, { width: 640, height: 360 }, dir, 10)
    // existing degrade semantics: the op stays in the list but kind=null and
    // no .ass/vf is produced — the burn never happens rather than rendering tofu
    assert.equal(out.length, 1)
    assert.equal(out[0].kind, null)
    assert.equal(out[0].vf, undefined)
  } finally {
    fonts.selectFont = orig
  }
})

test('makeCaptionAss: one Thai cue anywhere switches the whole track to a Thai font', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capass-'))
  const cues = [
    { text: 'hello there', start: 0, end: 1 },
    { text: 'สวัสดีครับ 100%', start: 1, end: 2 },
  ]
  const vf = ai.makeCaptionAss(cues, { width: 640, height: 360 }, dir)
  assert.match(vf, /^subtitles='.*\.ass':fontsdir=/)
  const text = fs.readFileSync(vf.match(/subtitles='([^']+)'/)[1], 'utf8')
  assert.match(text, /Style: A,Noto Sans Thai,/)
  assert.ok(text.includes('สวัสดีครับ 100%'))
})

test('makeCaptionAss: English cues keep DejaVu Sans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capass-'))
  const vf = ai.makeCaptionAss([{ text: 'just english', start: 0, end: 1 }], { width: 640, height: 360 }, dir)
  const text = fs.readFileSync(vf.match(/subtitles='([^']+)'/)[1], 'utf8')
  assert.match(text, /Style: A,DejaVu Sans,/)
})

// ------------------------------------------------------------ diagnostics ---

test('fontDiagnostics never throws and reports real families', () => {
  const d = fonts.fontDiagnostics()
  assert.equal(d.thai.family, 'Noto Sans Thai')
  assert.equal(d.latin.family, 'DejaVu Sans')
  assert.equal(d.vendorFontsExist, true)
  const missing = fonts.fontDiagnostics(MISSING)
  assert.equal(missing.thai.family, null)
  assert.ok(missing.thai.error.length > 0)
})

test('subtitlesFilter: skips fontsdir when the dir does not exist', () => {
  const f = fonts.subtitlesFilter('/tmp/x.ass', { fontsDir: '/nonexistent/fonts' })
  assert.equal(f, "subtitles='/tmp/x.ass'")
})
