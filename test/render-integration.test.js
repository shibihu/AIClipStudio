// ---------------------------------------------------------------------------
// test/render-integration.test.js — real 9:16 renders.
//
// These tests run FFmpeg for real, with the same caption fragment builder and
// FFmpeg argv builder the server uses. They exist to prove the bugs are fixed
// end-to-end, not just in unit-level string assertions:
//   BUG 1: a requested position is honored (center is Alignment 5, etc.)
//   BUG 2: "add" keeps burned-in captions, "replace" obscures exactly that band
//   BUG 4: what the preview claims is the caption area is what changed
// ---------------------------------------------------------------------------

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildCaptionRender } = require('../caption-render')
const { buildFfmpegArgs } = require('../render-args')
const {
  resolveCaptionLayout,
  captionRegion,
  alignmentFor,
  graphemeLength,
} = require('../subtitle-layout')
const { detectBurnedInSubtitles, verifyCaptionRender, regionDiff } = require('../subtitle-removal')

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'
const FFMPEG_AVAILABLE = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0
const SKIP = FFMPEG_AVAILABLE ? false : 'ffmpeg is not available on PATH'
const KEEP_ARTIFACTS = /^(1|true|yes)$/i.test(String(process.env.KEEP_RENDER_ARTIFACTS || ''))

const W = 1080
const H = 1920
const T = 2 // seconds
const META = { width: W, height: H, duration: T, fps: 24, hasAudio: true }

const FONT_FILE = process.env.TEST_FONT_FILE || (process.platform === 'win32'
  ? 'C:/Windows/Fonts/arial.ttf'
  : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
const FONT_AVAILABLE = fs.existsSync(FONT_FILE)

let dir
let plain
let burned

function ffmpeg(args, options = {}) {
  return execFileSync(FFMPEG, args, { stdio: 'pipe', maxBuffer: 256 * 1024 * 1024, ...options })
}

function escFilterPath(file) {
  // Inside a filtergraph the volume/colon separators must be escaped.
  return file.replace(/\\/g, '/').replace(/:/g, '\\:')
}

function makeSource(file, { drawOldCaption = false } = {}) {
  const vf = drawOldCaption
    ? `drawtext=fontfile='${escFilterPath(FONT_FILE)}':text='OLD SUBTITLE HERE':` +
      'fontcolor=white:fontsize=72:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-420'
    : null
  const args = ['-y', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=0x2A3B4C:s=${W}x${H}:d=${T}:r=24`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${T}`]
  if (vf) args.push('-vf', vf)
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', file)
  ffmpeg(args)
}

before(() => {
  if (!FFMPEG_AVAILABLE) return
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclipstudio-render-'))
  plain = path.join(dir, 'plain.mp4')
  burned = path.join(dir, 'burned.mp4')
  makeSource(plain)
  if (FONT_AVAILABLE) makeSource(burned, { drawOldCaption: true })
})

after(() => {
  if (!dir || KEEP_ARTIFACTS) return
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

function renderCaption({
  src = plain,
  out,
  cues,
  position,
  style,
  instructions,
  mode = 'add',
  detection = null,
  layer = 0,
  meta = META,
}) {
  const layout = resolveCaptionLayout({ position, style, instructions, layer }, meta)
  const render = buildCaptionRender({ placed: cues, meta, dir, layout, mode, detection, layer })
  const outPath = path.join(dir, out)
  ffmpeg(buildFfmpegArgs({ frag: render.frag, src, outPath, meta }))
  return { render, layout, outPath }
}

function probe(file) {
  const json = execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file], { encoding: 'utf8' })
  return JSON.parse(json)
}

const ANALYSIS_W = 180
const ANALYSIS_H = 320

function grayFrame(file, time = 1) {
  return ffmpeg(['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1',
    '-vf', `scale=${ANALYSIS_W}:${ANALYSIS_H},format=gray`, '-f', 'rawvideo', '-'])
}

function scaleRegion(region) {
  return {
    x: Math.round((region.x * ANALYSIS_W) / W),
    y: Math.round((region.y * ANALYSIS_H) / H),
    w: Math.max(1, Math.round((region.w * ANALYSIS_W) / W)),
    h: Math.max(1, Math.round((region.h * ANALYSIS_H) / H)),
  }
}

/**
 * Where did pixels actually change, and how much? `threshold` ignores codec
 * noise so the centroid follows the caption glyphs, not re-encoding.
 */
function diffStats(before, after, threshold = 25) {
  let count = 0
  let sum = 0
  let sx = 0
  let sy = 0
  for (let y = 0; y < ANALYSIS_H; y++) {
    for (let x = 0; x < ANALYSIS_W; x++) {
      const i = y * ANALYSIS_W + x
      const d = Math.abs(before[i] - after[i])
      sum += d
      if (d >= threshold) {
        count++
        sx += x
        sy += y
      }
    }
  }
  return {
    count,
    meanDiff: sum / (ANALYSIS_W * ANALYSIS_H),
    cx: count ? sx / count : NaN,
    cy: count ? sy / count : NaN,
  }
}

function meanDiffOutside(before, after, regions) {
  let sum = 0
  let count = 0
  for (let y = 0; y < ANALYSIS_H; y++) {
    for (let x = 0; x < ANALYSIS_W; x++) {
      const inside = regions.some((r) => {
        const s = scaleRegion(r)
        return x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h
      })
      if (inside) continue
      const i = y * ANALYSIS_W + x
      sum += Math.abs(before[i] - after[i])
      count++
    }
  }
  return count ? sum / count : 0
}

function assEvents(body) {
  return body.split(/\r?\n/).filter((line) => line.startsWith('Dialogue:')).map((line) => line.slice('Dialogue: '.length))
}

function dialogueText(event) {
  // Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
  return event.split(',').slice(8).join(',')
}

test('source fixture is a real 9:16 clip with audio', { skip: SKIP }, () => {
  const info = probe(plain)
  const video = info.streams.find((s) => s.codec_type === 'video')
  const audio = info.streams.find((s) => s.codec_type === 'audio')
  assert.equal(video.width, 1080)
  assert.equal(video.height, 1920)
  assert.ok(audio, 'fixture must have an audio track')
  assert.ok(Math.abs(Number(info.format.duration) - T) < 0.2)
})

test('add: "middle of the screen" renders at the vertical center (Alignment 5)', { skip: SKIP }, () => {
  const { render, layout, outPath } = renderCaption({
    out: 'add-center.mp4',
    cues: [{ text: 'This is a centered caption', start: 0.1, end: 1.9 }],
    instructions: 'put the subtitles in the middle of the screen',
  })

  assert.equal(layout.position, 'center')
  assert.equal(layout.alignment, 5)
  assert.equal(alignmentFor('center'), 5)
  assert.match(render.ass.body, /Title: AIClipStudio captions \(center\)/)
  assert.match(assEvents(render.ass.body)[0], /^0,[^,]+,[^,]+,A,0,0,\d+,,/)
  // the alignment column of the Style line carries 5
  assert.match(render.ass.body, /^Style: A,[^\n]*,1,\d+,0,5,\d+,\d+,\d+,1$/m)

  const before = grayFrame(plain)
  const after = grayFrame(outPath)
  const stats = diffStats(before, after)
  assert.ok(stats.count > 250, `expected visible caption pixels, got ${stats.count}`)
  const cy = stats.cy / ANALYSIS_H
  assert.ok(cy > 0.4 && cy < 0.6, `caption centroid should be centered, got y=${cy.toFixed(3)}`)

  const newBand = captionRegion(layout, META)
  const inBand = regionDiff(before, after, ANALYSIS_W, ANALYSIS_H, scaleRegion(newBand))
  assert.ok(inBand >= 8, `caption area should change, got ${inBand.toFixed(2)}`)
  const outside = meanDiffOutside(before, after, [newBand])
  assert.ok(outside <= 7, `pixels outside the caption area must stay intact, got ${outside.toFixed(2)}`)

  const info = probe(outPath)
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'), 'audio must be preserved')
  assert.equal(info.streams.find((s) => s.codec_type === 'video').width, 1080)
})

test('add: Thai caption uses a Thai-capable font, wraps to 2 lines and loses no text', { skip: SKIP }, () => {
  const text = 'สวัสดีครับ นี่คือคำบรรยายภาษาไทยที่อยู่ตรงกลางจอและยาวมากพอที่จะต้องตัดขึ้นบรรทัดใหม่'
  const { render, layout, outPath } = renderCaption({
    out: 'add-thai-center.mp4',
    cues: [{ text, start: 0.1, end: 1.9 }],
    position: 'center',
  })

  assert.equal(layout.alignment, 5)
  const expectedFont = process.env.SUBTITLE_THAI_FONT
    || (process.platform === 'win32' ? 'Leelawadee UI' : 'Noto Sans Thai')
  assert.ok(render.ass.body.includes(expectedFont), `ASS must request ${expectedFont}`)

  const events = assEvents(render.ass.body)
  assert.equal(events.length, 1)
  const rendered = dialogueText(events[0])
  assert.ok(rendered.includes('\\N'), 'long Thai text should wrap')
  assert.ok((rendered.match(/\\N/g) || []).length <= layout.maxLines - 1, 'must respect max lines')
  assert.equal(
    graphemeLength(rendered.replace(/\\N/g, '')),
    graphemeLength(text),
    'wrapping must not drop Thai characters',
  )

  const before = grayFrame(plain)
  const after = grayFrame(outPath)
  const stats = diffStats(before, after)
  assert.ok(stats.count > 250, `expected visible Thai glyphs, got ${stats.count}`)
  const cy = stats.cy / ANALYSIS_H
  assert.ok(cy > 0.4 && cy < 0.6, `Thai caption centroid should be centered, got ${cy.toFixed(3)}`)
})

test('add: bottom_center uses Alignment 2 and stays in the lower safe area', { skip: SKIP }, () => {
  const { render, layout, outPath } = renderCaption({
    out: 'add-bottom.mp4',
    cues: [{ text: 'Bottom caption', start: 0.1, end: 1.9 }],
    position: 'bottom_center',
  })

  assert.equal(layout.alignment, 2)
  assert.match(render.ass.body, /^Style: A,[^\n]*,1,\d+,0,2,\d+,\d+,\d+,1$/m)

  const before = grayFrame(plain)
  const after = grayFrame(outPath)
  const stats = diffStats(before, after)
  assert.ok(stats.count > 150)
  const cy = stats.cy / ANALYSIS_H
  assert.ok(cy > 0.72, `caption should sit near the bottom, got y=${cy.toFixed(3)}`)

  const band = captionRegion(layout, META)
  assert.ok(band.y > H * 0.6, 'predicted band should be in the lower part of the frame')
  assert.ok(band.y + band.h <= H, 'predicted band must fit inside the frame')
})

test('add: top_left uses Alignment 7 and stays in the upper-left corner', { skip: SKIP }, () => {
  const { render, layout, outPath } = renderCaption({
    out: 'add-top-left.mp4',
    cues: [{ text: 'Top left', start: 0.1, end: 1.9 }],
    position: 'top_left',
  })

  assert.equal(layout.alignment, 7)
  assert.match(render.ass.body, /^Style: A,[^\n]*,1,\d+,0,7,\d+,\d+,\d+,1$/m)

  const before = grayFrame(plain)
  const after = grayFrame(outPath)
  const stats = diffStats(before, after)
  assert.ok(stats.count > 80)
  const cx = stats.cx / ANALYSIS_W
  const cy = stats.cy / ANALYSIS_H
  assert.ok(cy < 0.3, `caption should sit near the top, got y=${cy.toFixed(3)}`)
  assert.ok(cx < 0.5, `caption should sit on the left, got x=${cx.toFixed(3)}`)
})

test('replace: detects the burned-in band', { skip: SKIP || !FONT_AVAILABLE }, async () => {
  const detection = await detectBurnedInSubtitles(FFMPEG, burned, META)
  assert.equal(detection.found, true, detection.reason)
  assert.ok(detection.confidence >= 0.35, `confidence ${detection.confidence}`)
  assert.ok(detection.band.y > H * 0.6, `band should be near the bottom, got y=${detection.band.y}`)
  assert.ok(detection.band.y + detection.band.h < H)
  assert.ok(detection.band.w > W * 0.3, 'band should span a wide part of the frame')
})

test('replace: obscures the old band, shows the new centered caption, keeps audio and unrelated pixels', { skip: SKIP || !FONT_AVAILABLE }, async () => {
  const detection = await detectBurnedInSubtitles(FFMPEG, burned, META)
  assert.equal(detection.found, true)

  const { render, layout, outPath } = renderCaption({
    src: burned,
    out: 'replace-center.mp4',
    cues: [{ text: 'Brand new centered caption', start: 0.1, end: 1.9 }],
    position: 'center',
    mode: 'replace',
    detection,
  })

  assert.equal(layout.alignment, 5)
  assert.ok(render.obscure, 'replace mode with detection must build an obscure graph')
  assert.match(render.frag.complex, /boxblur/)
  assert.match(render.frag.complex, /overlay=\d+:\d+/)
  assert.deepEqual(render.frag.maps, ['[vout]', '0:a?'])
  assert.ok(render.facts.layer >= 1, 'new captions must sit above the obscured band')
  assert.equal(render.facts.mode, 'replace')

  const verification = await verifyCaptionRender(
    FFMPEG, burned, outPath, META, render.verify,
  )
  assert.equal(verification.verified, true)
  assert.equal(verification.oldBandChanged, true, `old band diff ${verification.oldBandDiff}`)
  assert.equal(verification.newCaptionsVisible, true, `new band diff ${verification.newBandDiff}`)
  assert.equal(verification.unrelatedUntouched, true, `unrelated diff ${verification.unrelatedDiff}`)

  // and the new caption really is in the middle of the frame
  const before = grayFrame(burned)
  const after = grayFrame(outPath)
  const centerRegion = scaleRegion(captionRegion(layout, META))
  let sx = 0
  let sy = 0
  let n = 0
  for (let y = centerRegion.y; y < centerRegion.y + centerRegion.h; y++) {
    for (let x = centerRegion.x; x < centerRegion.x + centerRegion.w; x++) {
      const i = y * ANALYSIS_W + x
      if (Math.abs(before[i] - after[i]) >= 40) { n++; sx += x; sy += y }
    }
  }
  assert.ok(n > 150, `new caption should be bright in the center band, got ${n} pixels`)
  const cy = sy / n / ANALYSIS_H
  assert.ok(cy > 0.4 && cy < 0.6, `new caption centroid should be centered, got ${cy.toFixed(3)}`)

  const info = probe(outPath)
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'))
  assert.ok(Math.abs(Number(info.format.duration) - T) < 0.2)
})

test('add: never obscures existing burned-in captions', { skip: SKIP || !FONT_AVAILABLE }, async () => {
  const detection = await detectBurnedInSubtitles(FFMPEG, burned, META)
  assert.equal(detection.found, true)

  const { render, outPath } = renderCaption({
    src: burned,
    out: 'add-over-burned.mp4',
    cues: [{ text: 'Added caption', start: 0.1, end: 1.9 }],
    position: 'center',
    mode: 'add',
    detection,
  })

  assert.equal(render.obscure, null)
  assert.equal(render.frag.complex, null, 'add mode must not rewrite pixels through a graph')

  const before = grayFrame(burned)
  const after = grayFrame(outPath)
  const oldBand = scaleRegion(detection.band)
  const oldDiff = regionDiff(before, after, ANALYSIS_W, ANALYSIS_H, oldBand)
  assert.ok(oldDiff <= 7, `add mode must leave the old subtitle band intact, got ${oldDiff.toFixed(2)}`)

  // the new caption is visible at the requested position
  const stats = diffStats(before, after)
  assert.ok(stats.count > 150, `new caption should add visible pixels, got ${stats.count}`)
  const cy = stats.cy / ANALYSIS_H
  assert.ok(cy > 0.4 && cy < 0.6, `new caption should be centered, got y=${cy.toFixed(3)}`)
})

test('multiple caption layers keep their layer order', { skip: SKIP }, () => {
  const cues = [
    { text: 'Lower layer', start: 0.1, end: 1.9, layer: 0 },
    { text: 'Upper layer', start: 0.1, end: 1.9, layer: 3 },
  ]
  const { render } = renderCaption({
    out: 'multi-layer.mp4',
    cues,
    position: 'center',
  })
  const events = assEvents(render.ass.body)
  assert.equal(events.length, 2)
  const layers = events.map((e) => Number(e.split(',')[0]))
  assert.deepEqual(layers, [0, 3])
  assert.ok(events[1].includes('Upper layer'))
})

test('replace without a detected band falls back to add and says so', { skip: SKIP }, () => {
  const { render, outPath } = renderCaption({
    out: 'replace-no-detection.mp4',
    cues: [{ text: 'Fallback caption', start: 0.1, end: 1.9 }],
    position: 'center',
    mode: 'replace',
    detection: { found: false, confidence: 0.1, band: null, reason: 'no band' },
  })
  assert.equal(render.obscure, null)
  assert.equal(render.facts.mode, 'add')
  assert.equal(render.facts.detection.found, false)
  assert.ok(fs.existsSync(outPath))
})
