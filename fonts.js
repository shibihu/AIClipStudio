// ---------------------------------------------------------------------------
// fonts.js — language-aware font selection for the libass/ffmpeg subtitle
// burn-in pipeline (and any other renderer that needs a real font family).
//
// Why this exists: ASS generators used to hardcode "DejaVu Sans". DejaVu has
// NO Thai glyph coverage (U+0E00–U+0E7F), so Thai subtitles rendered as tofu
// boxes. Fix at the source: pick the font family from the actual subtitle
// text, verify real glyph coverage by parsing the font's cmap table (no
// external deps), and hand libass a fontsdir it can always load.
//
// Selection rules:
//   • Thai text            → Noto Sans Thai (vendored in vendor/fonts/),
//                            then other Thai-capable families found via
//                            fontconfig / well-known system paths.
//   • Latin/other text     → DejaVu Sans (vendored), then system equivalents.
//   • Mixed Thai + English → a Thai font (Noto Sans Thai also carries Latin).
//   • NEVER silently return a family without verified Thai coverage for Thai
//     text — that path throws ThaiFontUnavailableError with install hints.
// ---------------------------------------------------------------------------

const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const ROOT = __dirname
const DEFAULT_VENDOR_DIR = path.join(ROOT, 'vendor', 'fonts')

// Thai block U+0E00–U+0E7F
const THAI_RE = /[\u0E00-\u0E7F]/

// Codepoints a font must map to non-zero glyphs before we trust it with Thai
// subtitles: base consonant ก, vowel ั (above), vowel ุ (below), tone ่,
// ไ, ๆ, Thai digit ๐ — plus basic Latin (subtitles almost always mix in
// numbers/punctuation). Combining marks MUST be in the font or the glyph
// silently disappears.
const THAI_PROBES = [0x0E01, 0x0E31, 0x0E38, 0x0E48, 0x0E44, 0x0E46, 0x0E50]
const LATIN_PROBES = [0x41, 0x61, 0x30, 0x2E, 0x21] // A a 0 . !

const INSTALL_HINTS = [
  'Ubuntu/Debian: sudo apt-get install -y fonts-noto-core   # provides "Noto Sans Thai"',
  'Termux:        pkg install font-noto                     # then: fc-cache -f',
  'Or drop NotoSansThai-Regular.ttf into the repo vendor/fonts/ directory.',
]

class ThaiFontUnavailableError extends Error {
  constructor(detail) {
    super('No installed font with Thai glyph coverage was found. '
      + (detail ? detail + ' ' : '')
      + 'Install one and restart the server:\n  ' + INSTALL_HINTS.join('\n  '))
    this.name = 'ThaiFontUnavailableError'
    this.tried = detail
  }
}

// ------------------------------------------------------------- font registry ---

const FAMILIES = {
  thai: [
    { family: 'Noto Sans Thai', vendored: ['NotoSansThai-Bold.ttf', 'NotoSansThai-Regular.ttf'] },
    { family: 'Noto Looped Thai', vendored: ['NotoLoopedThai-Bold.ttf', 'NotoLoopedThai-Regular.ttf'] },
    { family: 'Noto Serif Thai', vendored: ['NotoSerifThai-Bold.ttf', 'NotoSerifThai-Regular.ttf'] },
    { family: 'Sarabun', vendored: ['Sarabun-Regular.ttf'] },
    { family: 'Loma' }, { family: 'Garuda' }, { family: 'Waree' }, { family: 'Norasi' },
    { family: 'TH Sarabun New' },
  ],
  latin: [
    { family: 'DejaVu Sans', vendored: ['DejaVuSans-Bold.ttf', 'DejaVuSans.ttf'] },
    { family: 'Noto Sans' },
    { family: 'Liberation Sans' },
    { family: 'Arial' },
    { family: 'Helvetica' },
  ],
}

// Well-known font directories; the Termux prefix is included so the app works
// unmodified under Android/Termux.
function systemFontDirs() {
  const dirs = [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    '/data/data/com.termux/files/usr/share/fonts',
    '/data/data/com.termux/files/home/.fonts',
    path.join(process.env.HOME || '', '.fonts'),
    path.join(process.env.HOME || '', '.local/share/fonts'),
    '/System/Library/Fonts',
    '/Library/Fonts',
    '/sdcard/Android/data/com.termux/files/home/.fonts',
  ]
  if (process.env.AICLIP_FONT_DIRS) dirs.unshift(...process.env.AICLIP_FONT_DIRS.split(':').filter(Boolean))
  return dirs
}

function vendorFontsDir() {
  return process.env.AICLIP_VENDOR_FONTS || DEFAULT_VENDOR_DIR
}

// -------------------------------------------------------------- TTF cmap ----
// Minimal TrueType/OpenType cmap reader (formats 0, 4, 12) returning the set
// of supported codepoints. Enough to VERIFY glyph coverage without shipping a
// font library — answers "does this font actually contain Thai?" exactly.

const coverageCache = new Map()

function fontCoverage(fontPath) {
  if (coverageCache.has(fontPath)) return coverageCache.get(fontPath)
  let cov = null
  try {
    cov = readCmap(fs.readFileSync(fontPath))
  } catch { cov = null }
  coverageCache.set(fontPath, cov)
  return cov
}

function readCmap(buf) {
  if (!buf || buf.length < 12) return null
  const sfnt = buf.readUInt32BE(0)
  if (![0x00010000, 0x4F54544F, 0x74727565, 0x74746366].includes(sfnt)) return null
  const numTables = buf.readUInt16BE(4)
  let cmapOff = -1
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16
    if (off + 16 > buf.length) break
    if (buf.toString('latin1', off, off + 4) === 'cmap') {
      cmapOff = buf.readUInt32BE(off + 8)
      break
    }
  }
  if (cmapOff < 0 || cmapOff + 4 > buf.length) return null
  const nSub = buf.readUInt16BE(cmapOff + 2)
  // collect subtables, try them best-first: (3,10)/(0,4-6) unicode-full,
  // then (3,1)/(0,*) BMP. Some fonts expose a (0,5) format-14 variation-
  // selector subtable we cannot parse — fall through to the next one.
  const cands = []
  for (let i = 0; i < nSub; i++) {
    const rec = cmapOff + 4 + i * 8
    if (rec + 8 > buf.length) break
    const pid = buf.readUInt16BE(rec)
    const eid = buf.readUInt16BE(rec + 2)
    const off = buf.readUInt32BE(rec + 4)
    let score = -1
    if (pid === 3 && eid === 10) score = 5
    else if (pid === 0 && eid >= 4 && eid <= 6) score = 5
    else if (pid === 3 && eid === 1) score = 4
    else if (pid === 0) score = 4
    else if (pid === 3 && eid === 0) score = 3
    if (score >= 0) cands.push({ off, score })
  }
  cands.sort((a, b) => b.score - a.score)
  for (const c of cands) {
    const sub = cmapOff + c.off
    if (sub + 4 > buf.length) continue
    const fmt = buf.readUInt16BE(sub)
    let set = null
    if (fmt === 0) set = readCmap0(buf, sub)
    else if (fmt === 4) set = readCmap4(buf, sub)
    else if (fmt === 12) set = readCmap12(buf, sub)
    if (set && set.size) return set
  }
  return null
}

function readCmap0(buf, sub) {
  const set = new Set()
  for (let c = 0; c < 256 && sub + 6 + c < buf.length; c++) {
    if (buf.readUInt8(sub + 6 + c) !== 0) set.add(c)
  }
  return set
}

function readCmap4(buf, sub) {
  const segX2 = buf.readUInt16BE(sub + 6)
  const segCount = Math.floor(segX2 / 2)
  if (!segCount) return null
  const endOff = sub + 14
  const startOff = endOff + segX2 + 2 // skip reservedPad
  const deltaOff = startOff + segX2
  const rangeOff = deltaOff + segX2
  if (rangeOff + segX2 > buf.length) return null
  const set = new Set()
  for (let s = 0; s < segCount; s++) {
    const end = buf.readUInt16BE(endOff + s * 2)
    const start = buf.readUInt16BE(startOff + s * 2)
    const delta = buf.readInt16BE(deltaOff + s * 2)
    const ro = buf.readUInt16BE(rangeOff + s * 2)
    if (start === 0xFFFF) continue
    for (let c = start; c <= end && c !== 0xFFFF; c++) {
      let gid = 0
      if (ro === 0) {
        gid = (c + delta) & 0xFFFF
      } else {
        const addr = rangeOff + s * 2 + ro + (c - start) * 2
        if (addr + 2 <= buf.length) gid = buf.readUInt16BE(addr)
      }
      if (gid !== 0) set.add(c)
    }
  }
  return set
}

function readCmap12(buf, sub) {
  const nGroups = buf.readUInt32BE(sub + 12)
  const set = new Set()
  for (let g = 0; g < nGroups; g++) {
    const rec = sub + 16 + g * 12
    if (rec + 12 > buf.length) break
    const s = buf.readUInt32BE(rec)
    const e = buf.readUInt32BE(rec + 4)
    for (let c = s; c <= e; c++) {
      set.add(c)
      if (set.size > 400000) break
    }
  }
  return set
}

// True when fontPath maps every probe codepoint to a real glyph. A font with
// an unreadable/missing cmap counts as NOT covering.
function fontCovers(fontPath, probes) {
  const cov = fontCoverage(fontPath)
  if (!cov) return false
  return probes.every((cp) => cov.has(cp))
}

// ----------------------------------------------------------- font discovery ---

function normalizeFamily(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

let fcIndexCache = null
let fcIndexKey = null

// Run fc-list once and index family name → file paths. Any failure (missing
// binary, no fontconfig) yields an empty index — discovery then falls through
// to vendored files / system paths.
function fcListIndex(opts = {}) {
  const key = opts.fcListCmd || 'fc-list'
  if (fcIndexCache && fcIndexKey === key) return fcIndexCache
  fcIndexKey = key
  fcIndexCache = new Map()
  try {
    const out = execFileSync(key, [], { timeout: 15000, encoding: 'utf8' })
    for (const line of String(out).split('\n')) {
      if (!line.trim()) continue
      const colon = line.indexOf(':')
      if (colon <= 0) continue
      const file = line.slice(0, colon).trim()
      let families = line.slice(colon + 1)
      const styleIdx = families.indexOf(':style=')
      if (styleIdx >= 0) families = families.slice(0, styleIdx)
      for (const fam of families.split(',')) {
        const key2 = normalizeFamily(fam)
        if (!key2) continue
        if (!fcIndexCache.has(key2)) fcIndexCache.set(key2, [])
        fcIndexCache.get(key2).push(file)
      }
    }
  } catch { /* no fc-list — fine */ }
  return fcIndexCache
}

// Bounded walk for direct filename guesses (last resort when neither the
// vendored copy nor fontconfig can find a family).
function walkFor(dir, nameRegex, depth = 0) {
  if (depth > 4) return null
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const r = walkFor(p, nameRegex, depth + 1)
      if (r) return r
    } else if (nameRegex.test(e.name)) return p
  }
  return null
}

// Resolve one registry candidate to a concrete font file (not yet verified
// for coverage). Order: vendored → fontconfig → system path walk.
function findFamilyFile(cand, opts) {
  for (const f of cand.vendored || []) {
    if (!opts.vendorDir) break
    const p = path.join(opts.vendorDir, f)
    try { fs.accessSync(p); return { file: p, source: 'vendored' } } catch { /* next */ }
  }
  const paths = fcListIndex(opts).get(normalizeFamily(cand.family))
  if (paths && paths.length) {
    // prefer a file that exists and parses
    for (const p of paths) {
      try { fs.accessSync(p); return { file: p, source: 'fontconfig' } } catch { /* next */ }
    }
  }
  const condensed = cand.family.replace(/\s+/g, '')
  const guess = new RegExp(condensed + '[-_]?(bold|regular)?\\.tt[fc]$', 'i')
  for (const dir of opts.systemDirs) {
    const p = walkFor(dir, guess)
    if (p) return { file: p, source: 'system-path' }
  }
  return null
}

const fcDisallowed = /['"\\]/

function normalizeOpts(opts = {}) {
  return {
    vendorDir: opts.vendorDir !== undefined ? opts.vendorDir : vendorFontsDir(),
    fcListCmd: opts.fcListCmd || 'fc-list',
    systemDirs: opts.systemDirs !== undefined ? opts.systemDirs : systemFontDirs(),
  }
}

// ------------------------------------------------------------- selection ----

// Pick a font family that actually covers the text's glyphs.
//   text  — subtitle text (string) or array of strings (all cues)
//   opts  — { vendorDir, fcListCmd, systemDirs } for injection in tests
// Returns { family, file, source, fontsDir, coversThai }.
// Throws ThaiFontUnavailableError when the text needs Thai and no candidate
// has verified Thai coverage — never a silent tofu-producing fallback.
function selectFont(text, opts = {}) {
  const o = normalizeOpts(opts)
  const texts = Array.isArray(text) ? text : [text]
  const joined = texts.join('\n')
  const needThai = THAI_RE.test(joined)
  // codepoints actually present in the text — a font must cover every one of
  // them in the required script, not just the fixed probe set
  const thaiNeeded = new Set()
  const exoticNeeded = new Set()
  for (const ch of joined) {
    const cp = ch.codePointAt(0)
    if (cp < 0x20 || (cp >= 0x7F && cp < 0x2000)) continue // controls + common whitespace/punct handled by probes
    if (cp >= 0x0E00 && cp <= 0x0E7F) thaiNeeded.add(cp)
    else if (cp >= 0x2000) exoticNeeded.add(cp) // beyond Latin+Thai: emoji, CJK, currency, …
  }
  const probes = [...(needThai ? THAI_PROBES : []), ...LATIN_PROBES, ...thaiNeeded]
  const group = needThai ? FAMILIES.thai : FAMILIES.latin
  const tried = []

  for (const cand of group) {
    const found = findFamilyFile(cand, o)
    if (!found) { tried.push(`${cand.family}: not found`); continue }
    const cov = fontCoverage(found.file)
    if (!cov) { tried.push(`${cand.family}: unreadable cmap (${found.file})`); continue }
    const missing = probes.filter((cp) => !cov.has(cp))
    if (missing.length) {
      tried.push(`${cand.family}: missing glyphs ${missing.map((c) => 'U+' + c.toString(16).toUpperCase().padStart(4, '0')).join(' ')}`)
      continue
    }
    warnExotic(cand.family, cov, exoticNeeded)
    return {
      family: cand.family,
      file: found.file,
      source: found.source,
      fontsDir: o.vendorDir && fs.existsSync(o.vendorDir) ? o.vendorDir : null,
      coversThai: needThai,
    }
  }

  if (needThai) throw new ThaiFontUnavailableError(tried.join('; '))

  // Latin text: legacy default kept so existing English behaviour survives
  // even on systems where no Latin font could be verified (libass then uses
  // its own fontconfig fallback, as before). Thai never reaches this branch.
  const dv = FAMILIES.latin[0]
  const found = findFamilyFile(dv, o)
  if (found && fontCoverage(found.file)) warnExotic(dv.family, fontCoverage(found.file), exoticNeeded)
  return {
    family: dv.family,
    file: found ? found.file : null,
    source: found ? found.source : 'default',
    fontsDir: o.vendorDir && fs.existsSync(o.vendorDir) ? o.vendorDir : null,
    coversThai: false,
  }
}

// Non-fatal: emoji/CJK/etc. outside Latin+Thai may not exist in the chosen
// font. Never silently ignored — log which glyphs may render as tofu, but do
// not fail the render over them.
function warnExotic(family, cov, exoticNeeded) {
  const missing = [...exoticNeeded].filter((cp) => !cov.has(cp))
  if (missing.length) {
    console.warn(`[fonts] ${family} is missing ${missing.length} glyph(s) from the subtitle text ` +
      `(may render as boxes): ${missing.slice(0, 8).map((c) => 'U+' + c.toString(16).toUpperCase().padStart(4, '0')).join(' ')}`)
  }
}

// ------------------------------------------------------- subtitles filter ----

// Compose the ffmpeg `subtitles=` filter expression with the fontsdir libass
// needs to load vendored fonts. assPath must not contain quotes. fontsdir is
// only appended when the directory exists — a dangling fontsdir makes some
// libass builds fail font loading entirely.
function subtitlesFilter(assPath, opts = {}) {
  if (fcDisallowed.test(assPath)) throw new Error(`subtitle path not usable in a filter expression: ${assPath}`)
  let f = `subtitles='${assPath}'`
  const dir = opts.fontsDir !== undefined ? opts.fontsDir : vendorFontsDir()
  if (dir && fs.existsSync(dir)) {
    // same filter-expression rules apply to fontsdir — fail loudly here
    // instead of corrupting the whole filtergraph at render time
    if (fcDisallowed.test(dir)) throw new Error(`fontsdir not usable in a filter expression: ${dir}`)
    f += `:fontsdir=${dir}`
  }
  return f
}

// ----------------------------------------------------------- diagnostics ----

// Snapshot for /api/health + boot log: which Thai and Latin fonts are actually
// usable in THIS process. Never throws.
function fontDiagnostics(opts = {}) {
  const o = normalizeOpts(opts)
  const probe = (text) => {
    try {
      const sel = selectFont(text, o)
      return { family: sel.family, source: sel.source, file: sel.file }
    } catch (e) {
      return { family: null, error: e.message.split('\n')[0] }
    }
  }
  return {
    vendorFontsDir: o.vendorDir,
    vendorFontsExist: !!o.vendorDir && fs.existsSync(o.vendorDir),
    fontconfigAvailable: fcListIndex(o).size > 0,
    thai: probe('ทดสอบสระและวรรณยุกต์ 0123.'),
    latin: probe('Latin 0123.'),
  }
}

module.exports = {
  THAI_RE, THAI_PROBES, LATIN_PROBES, FAMILIES,
  containsThai: (t) => THAI_RE.test(String(t || '')),
  selectFont, subtitlesFilter, fontCovers, fontCoverage, fontDiagnostics,
  vendorFontsDir, systemFontDirs, readCmap, ThaiFontUnavailableError,
  INSTALL_HINTS,
}
