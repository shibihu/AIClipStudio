// test/subtitle-render-bounds.test.js — INTEGRATION: burn subtitles into real
// portrait, landscape and square videos, then inspect the actual pixels. The
// bounding box of every non-background subtitle pixel must stay inside the
// configured safe area. Exit code 0 alone is not trusted.
// Skips cleanly when no working ffmpeg/libass binary exists.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const layout = require('../subtitle-layout')
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
const BG = [0x22, 0x44, 0x88]

const cues = [
  { text: 'การทดสอบข้อความภาษาไทยยาวมากโดยไม่มีการเว้นวรรคเลยซึ่งอาจจะล้นออกนอกกรอบวิดีโอได้ง่ายมาก', start: 0, end: 2 },
  { text: 'This is a very long English subtitle sentence that should wrap into two lines without overflowing the video frame at all.', start: 2, end: 4 },
  { text: 'Hello สวัสดีครับ 12345 67.89% mixed ภาษาไทย and English text that keeps going and going.', start: 4, end: 6 },
]

function grabRaw(video, at, file) {
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-ss', String(at), '-i', video,
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', file], { timeout: 60000, stdio: 'ignore' })
  return fs.readFileSync(file)
}

function subtitleBBox(buf, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      const distance = Math.abs(buf[i] - BG[0]) + Math.abs(buf[i + 1] - BG[1]) + Math.abs(buf[i + 2] - BG[2])
      if (distance > 60) {
        count++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { minX, minY, maxX, maxY, count }
}

test('rendered subtitle pixels stay inside the frame safe area', { skip: !FFMPEG && 'no working ffmpeg binary' }, () => {
  const frames = [[720, 1280], [1080, 1920], [1920, 1080], [1080, 1080]]
  for (const [W, H] of frames) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subframes-'))
    const family = fonts.selectFont(cues.map((c) => c.text)).family
    const built = layout.buildAssTrack(cues, { width: W, height: H }, { family })
    const ass = path.join(dir, 'subs.ass')
    fs.writeFileSync(ass, built.ass, 'utf8')
    const video = path.join(dir, 'out.mp4')
    execFileSync(FFMPEG, [
      '-y', '-hide_banner', '-f', 'lavfi', '-i', `color=c=0x224488:s=${W}x${H}:d=6:r=10`,
      '-vf', fonts.subtitlesFilter(ass), '-c:v', 'libx264', '-preset', 'ultrafast',
      '-crf', '18', '-pix_fmt', 'yuv420p', video,
    ], { timeout: 120000, stdio: 'ignore' })

    const safeX = Math.floor(W * 0.05)
    const safeY = Math.floor(H * 0.05)
    for (const at of [1, 3, 5]) {
      const raw = grabRaw(video, at, path.join(dir, `f${at}.raw`))
      const box = subtitleBBox(raw, W, H)
      assert.ok(box.count > 0, `${W}x${H} t=${at}: no subtitle pixels rendered`)
      assert.ok(box.minX >= safeX - 2, `${W}x${H} t=${at}: left overflow ${box.minX} < ${safeX}`)
      assert.ok(box.maxX <= W - safeX + 2, `${W}x${H} t=${at}: right overflow ${box.maxX} > ${W - safeX}`)
      assert.ok(box.minY >= safeY - 2, `${W}x${H} t=${at}: top overflow ${box.minY} < ${safeY}`)
      assert.ok(box.maxY <= H - safeY + 2, `${W}x${H} t=${at}: bottom overflow ${box.maxY} > ${H - safeY}`)
    }
  }
})
