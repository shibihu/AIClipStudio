// test/thai-render.test.js — INTEGRATION: burn Thai ASS into a real video with
// the vendored ffmpeg/libass and verify the glyphs are actually drawn by
// comparing the subtitle band against a no-subtitle render. Exit code 0 alone
// is NOT trusted here (or anywhere in this repo's burn path).
// Skips cleanly when no working ffmpeg binary is available (e.g. CI without
// the vendor binaries).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const captions = require('../caption')
const fonts = require('../fonts')

function resolveFfmpeg() {
  const cands = [
    path.join(__dirname, '..', 'vendor', `ffmpeg-${process.arch === 'x64' ? 'amd64' : 'arm64'}`),
    path.join(__dirname, '..', 'vendor', 'ffmpeg'),
    'ffmpeg',
  ]
  for (const c of cands) {
    try { execFileSync(c, ['-version'], { timeout: 20000, stdio: 'ignore' }); return c } catch { /* next */ }
  }
  return null
}

const FFMPEG = resolveFfmpeg()
const W = 320, H = 240

function grabFrame(video, at, file) {
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-ss', String(at), '-i', video,
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', file], { timeout: 60000 })
  return fs.readFileSync(file)
}

// mean |a−b| over the lower subtitle band — 0 would mean nothing was drawn
function bandDiff(a, b) {
  let sum = 0
  let n = 0
  const startY = Math.floor(H * 0.6) * W * 3
  for (let i = startY; i < a.length; i++) { sum += Math.abs(a[i] - b[i]); n++ }
  return sum / n
}

test('ffmpeg burn-in: Thai glyphs are drawn into the frame', { skip: !FFMPEG && 'no working ffmpeg binary' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thaiburn-'))
  const ass = captions.makeThaiAss([
    { text: 'สวัสดีครับ ยินดีต้อนรับ', start: 0, end: 2 },
    { text: 'สระ วรรณยุกต์ กับ กาแฟ latte 60%', start: 2, end: 4 },
  ], { width: W, height: H }, dir)
  const withSubs = path.join(dir, 'thai.mp4')
  const noSubs = path.join(dir, 'plain.mp4')
  // same source + encode for both, only the subtitles filter differs
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-f', 'lavfi', '-i', `color=c=0x224488:s=${W}x${H}:d=4:r=10`,
    '-vf', fonts.subtitlesFilter(ass), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    withSubs], { timeout: 120000 })
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-f', 'lavfi', '-i', `color=c=0x224488:s=${W}x${H}:d=4:r=10`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', noSubs], { timeout: 120000 })
  assert.ok(fs.existsSync(withSubs) && fs.statSync(withSubs).size > 0)

  const fSub = grabFrame(withSubs, 0.5, path.join(dir, 'sub.raw'))
  const fPlain = grabFrame(noSubs, 0.5, path.join(dir, 'plain.raw'))
  assert.equal(fSub.length, fPlain.length)
  const diff = bandDiff(fSub, fPlain)
  assert.ok(diff > 2, `subtitle band unchanged (mean diff ${diff.toFixed(3)}) — Thai glyphs were NOT drawn`)
  console.log(`    thai burn-in: subtitle band mean|Δ| = ${diff.toFixed(2)}/255`)
})

test('ffmpeg burn-in: mixed Thai/English cue renders too', { skip: !FFMPEG && 'no working ffmpeg binary' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thaiburn-'))
  const ass = captions.makeThaiAss([
    { text: 'Hello world สวัสดีชาวโลก 100%', start: 0, end: 2 },
  ], { width: W, height: H }, dir)
  const out = path.join(dir, 'mixed.mp4')
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=2:r=10`,
    '-vf', fonts.subtitlesFilter(ass), '-frames:v', '12', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', out], { timeout: 120000 })
  const fSub = grabFrame(out, 1, path.join(dir, 'sub.raw'))
  // solid black baseline — any glyph pixels show up as a big diff
  const black = Buffer.alloc(fSub.length, 0)
  assert.ok(bandDiff(fSub, black) > 2, 'mixed cue produced no visible pixels')
})

test('ffmpeg reports failure (nonzero exit) for a broken subtitle file — and stderr carries the cause', { skip: !FFMPEG && 'no working ffmpeg binary' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assbad-'))
  const bad = path.join(dir, 'bad.ass')
  fs.writeFileSync(bad, 'this is not an ASS file at all\n', 'utf8')
  let code = 0
  let stderr = ''
  try {
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1:r=10`,
      '-vf', fonts.subtitlesFilter(bad), '-frames:v', '3', '-f', 'null', '-'], { timeout: 60000, stdio: 'pipe' })
  } catch (e) {
    code = e.status ?? 1
    stderr = String(e.stderr || '')
  }
  assert.notEqual(code, 0, 'ffmpeg accepted a garbage ASS file silently')
  assert.ok(stderr.length > 0, 'no stderr captured for the failure')
})
