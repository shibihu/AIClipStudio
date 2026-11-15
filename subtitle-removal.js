'use strict'

// ---------------------------------------------------------------------------
// subtitle-removal.js — "Replace existing subtitles" support.
//
// Detection works on decoded frames (no external dependencies): FFmpeg emits
// small grayscale frames, and we look for a horizontally-wide band whose rows
// carry persistent high-contrast edges across most of the clip. That is the
// signature of burned-in captions.
//
// Removal obscures exactly that band with a blurred copy of itself (crop →
// boxblur → overlay), so pixels outside the band are never touched and the
// original audio stream is left alone. Both steps report measurements instead
// of claiming success blindly.
// ---------------------------------------------------------------------------

const { execFile } = require('child_process')

const ANALYSIS_WIDTH = 160
const MIN_BAND_ROWS = 2
const MAX_BAND_FRACTION = 0.42 // a subtitle band may never cover the whole frame
const ROW_TEXT_EDGE_DENSITY = 0.055
const ROW_TEXT_BRIGHTNESS = 55
const PERSISTENCE_THRESHOLD = 0.3

function even(n) {
  const v = Math.round(n)
  return v % 2 === 0 ? v : v - 1
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function decodeGrayFrames(ffmpeg, src, meta, { samples = 24, width = ANALYSIS_WIDTH } = {}) {
  const srcW = Number(meta.width) || 0
  const srcH = Number(meta.height) || 0
  const duration = Number(meta.duration) || 0
  if (!srcW || !srcH || !duration) return Promise.resolve({ frames: [], width: 0, height: 0, samples: 0 })

  const w = Math.min(width, srcW)
  const h = Math.max(2, even((w * srcH) / srcW))
  const frameBytes = w * h
  const fps = clamp(samples / duration, 0.05, 30)

  return new Promise((resolve) => {
    execFile(
      ffmpeg,
      ['-v', 'error', '-i', src, '-an', '-vf', `fps=${fps.toFixed(6)},scale=${w}:${h},format=gray`,
        '-frames:v', String(samples), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
      { timeout: 180000, maxBuffer: 128 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => {
        if (err || !stdout || !stdout.length) return resolve({ frames: [], width: w, height: h, samples: 0 })
        const count = Math.floor(stdout.length / frameBytes)
        const frames = []
        for (let i = 0; i < count; i++) frames.push(stdout.subarray(i * frameBytes, (i + 1) * frameBytes))
        resolve({ frames, width: w, height: h, samples: count })
      },
    )
  })
}

// Row metrics for one grayscale frame: horizontal edge density, brightness,
// and the horizontal extent of the "edgy" pixels (used as the band's x-range).
function rowMetrics(frame, width, height) {
  const edgeDensity = new Float64Array(height)
  const brightness = new Float64Array(height)
  const minX = new Int32Array(height).fill(width)
  const maxX = new Int32Array(height).fill(-1)
  const threshold = 34

  for (let y = 0; y < height; y++) {
    const row = y * width
    let edges = 0
    let sum = 0
    for (let x = 0; x < width; x++) {
      const value = frame[row + x]
      sum += value
      if (x === 0) continue
      if (Math.abs(value - frame[row + x - 1]) >= threshold) {
        edges++
        if (x < minX[y]) minX[y] = x
        if (x > maxX[y]) maxX[y] = x
      }
    }
    edgeDensity[y] = edges / Math.max(1, width - 1)
    brightness[y] = sum / width
  }
  return { edgeDensity, brightness, minX, maxX }
}

/**
 * Detect a burned-in subtitle band.
 * @returns {Promise<{found:boolean, confidence:number, band:null|{x:number,y:number,w:number,h:number},
 *   coverage:number, samples:number, reason:string, rows?:number[]}>}
 */
async function detectBurnedInSubtitles(ffmpeg, src, meta, { samples = 24 } = {}) {
  const decoded = await decodeGrayFrames(ffmpeg, src, meta, { samples })
  const { frames, width, height } = decoded
  if (!frames.length) {
    return {
      found: false, confidence: 0, band: null, coverage: 0, samples: 0,
      reason: 'the clip could not be sampled for subtitle detection',
    }
  }

  // Persistence per row: in how many frames does this row look like text?
  const textish = new Float64Array(height)
  const edgeSum = new Float64Array(height)
  const xMinSeen = new Int32Array(height).fill(width)
  const xMaxSeen = new Int32Array(height).fill(-1)

  for (const frame of frames) {
    const metrics = rowMetrics(frame, width, height)
    for (let y = 0; y < height; y++) {
      const looksLikeText = metrics.edgeDensity[y] >= ROW_TEXT_EDGE_DENSITY && metrics.brightness[y] >= ROW_TEXT_BRIGHTNESS
      if (looksLikeText) {
        textish[y] += 1
        edgeSum[y] += metrics.edgeDensity[y]
        if (metrics.minX[y] < xMinSeen[y]) xMinSeen[y] = metrics.minX[y]
        if (metrics.maxX[y] > xMaxSeen[y]) xMaxSeen[y] = metrics.maxX[y]
      }
    }
  }

  const persistence = Array.from(textish, (n) => n / frames.length)
  // smooth over 3 rows so a single noisy row cannot split the band
  const smooth = persistence.map((_, y) => {
    const window = persistence.slice(Math.max(0, y - 1), Math.min(height, y + 2))
    return window.reduce((a, b) => a + b, 0) / window.length
  })

  let best = null
  let start = -1
  for (let y = 0; y <= height; y++) {
    const active = y < height && smooth[y] >= PERSISTENCE_THRESHOLD
    if (active && start < 0) start = y
    if (!active && start >= 0) {
      const end = y
      const rows = end - start
      const score = smooth.slice(start, end).reduce((a, b) => a + b, 0) / Math.max(1, rows)
      if (rows >= MIN_BAND_ROWS && rows <= height * MAX_BAND_FRACTION && (!best || score > best.score)) {
        best = { start, end, score }
      }
      start = -1
    }
  }

  if (!best) {
    return {
      found: false, confidence: 0, band: null, coverage: 0, samples: frames.length,
      reason: 'no persistent high-contrast text band was found (the clip may have no burned-in subtitles)',
    }
  }

  // Horizontal extent: union of text pixels inside the band, padded a little.
  let x0 = width
  let x1 = -1
  for (let y = best.start; y < best.end; y++) {
    if (xMinSeen[y] < x0) x0 = xMinSeen[y]
    if (xMaxSeen[y] > x1) x1 = xMaxSeen[y]
  }
  if (x1 <= x0) { x0 = 0; x1 = width - 1 }
  const padX = Math.max(1, Math.round(width * 0.02))
  x0 = Math.max(0, x0 - padX)
  x1 = Math.min(width - 1, x1 + padX)

  const srcW = Number(meta.width) || width
  const srcH = Number(meta.height) || height
  const scaleX = srcW / width
  const scaleY = srcH / height

  const bandY = even(clamp(best.start * scaleY - srcH * 0.008, 0, srcH - 2))
  const bandX = even(clamp(x0 * scaleX - srcW * 0.01, 0, srcW - 2))
  const bandW = even(clamp((x1 - x0 + 1) * scaleX + srcW * 0.02, 4, srcW - bandX))
  const bandH = even(clamp((best.end - best.start) * scaleY + srcH * 0.016, 4, srcH - bandY))

  // Edges outside the band should be calm; a busy frame everywhere lowers
  // confidence instead of pretending we found captions.
  let outside = 0
  let outsideRows = 0
  for (let y = 0; y < height; y++) {
    if (y >= best.start && y < best.end) continue
    outside += smooth[y]
    outsideRows++
  }
  const outsideMean = outsideRows ? outside / outsideRows : 0
  const contrast = Math.max(0, best.score - outsideMean)
  const confidence = clamp(0.55 * best.score + 0.45 * clamp(contrast / 0.05, 0, 1), 0, 1)

  const found = best.score >= PERSISTENCE_THRESHOLD && confidence >= 0.35
  return {
    found,
    confidence: Math.round(confidence * 100) / 100,
    band: { x: bandX, y: bandY, w: Math.max(4, bandW), h: Math.max(4, bandH) },
    coverage: Math.round(best.score * 100) / 100,
    samples: frames.length,
    reason: found
      ? `persistent text band detected in ${Math.round(best.score * 100)}% of sampled frames`
      : 'a candidate band was found but confidence is too low to claim a burned-in subtitle',
  }
}

/**
 * FFmpeg filter_complex graph that blurs `band` in place.
 * Audio is untouched; the graph produces `[vout]`.
 */
function buildObscureGraph(band, meta) {
  const srcW = Number(meta.width) || 1080
  const srcH = Number(meta.height) || 1920
  const w = Math.max(4, even(clamp(band.w, 4, srcW)))
  const h = Math.max(4, even(clamp(band.h, 4, srcH)))
  const x = even(clamp(band.x, 0, srcW - w))
  const y = even(clamp(band.y, 0, srcH - h))
  const radius = clamp(Math.round(h / 5), 4, 32)
  return {
    band: { x, y, w, h },
    graph: `[0:v]split=2[base][region];` +
      `[region]crop=${w}:${h}:${x}:${y},boxblur=${radius}:3[blurred];` +
      `[base][blurred]overlay=${x}:${y}[obscured]`,
  }
}

// ---------------------------------------------------------------------------
// pixel verification
// ---------------------------------------------------------------------------

function regionDiff(a, b, width, height, region) {
  const x0 = clamp(Math.round(region.x), 0, width - 1)
  const x1 = clamp(Math.round(region.x + region.w), 1, width)
  const y0 = clamp(Math.round(region.y), 0, height - 1)
  const y1 = clamp(Math.round(region.y + region.h), 1, height)
  let sum = 0
  let count = 0
  for (let y = y0; y < y1; y++) {
    const row = y * width
    for (let x = x0; x < x1; x++) {
      sum += Math.abs(a[row + x] - b[row + x])
      count++
    }
  }
  return count ? sum / count : 0
}

function diffExcluding(a, b, width, height, regions) {
  let sum = 0
  let count = 0
  for (let y = 0; y < height; y++) {
    const row = y * width
    let inRegion = false
    for (const r of regions) {
      if (!r) continue
      if (y >= r.y && y < r.y + r.h) { inRegion = true; break }
    }
    if (inRegion) continue
    for (let x = 0; x < width; x++) {
      sum += Math.abs(a[row + x] - b[row + x])
      count++
    }
  }
  return count ? sum / count : 0
}

async function measureFrameDiff(ffmpeg, src, out, meta, { samples = 12 } = {}) {
  const [before, after] = await Promise.all([
    decodeGrayFrames(ffmpeg, src, meta, { samples }),
    decodeGrayFrames(ffmpeg, out, meta, { samples }),
  ])
  const count = Math.min(before.frames.length, after.frames.length)
  if (!count) return null
  const { width, height } = before
  // scale the requested regions from source pixels into analysis pixels
  const scaleX = width / (Number(meta.width) || width)
  const scaleY = height / (Number(meta.height) || height)
  const toAnalysis = (region) => region ? ({
    x: region.x * scaleX,
    y: region.y * scaleY,
    w: Math.max(1, region.w * scaleX),
    h: Math.max(1, region.h * scaleY),
  }) : null

  return { before, after, count, width, height, toAnalysis }
}

/**
 * Measure whether a render actually changed the detected old-subtitle band and
 * whether unrelated areas stayed intact.
 *
 * @param {{oldBand?:object,newBand?:object}} regions in source pixels
 */
async function verifyCaptionRender(ffmpeg, src, out, meta, { oldBand = null, newBand = null, samples = 12 } = {}) {
  const measured = await measureFrameDiff(ffmpeg, src, out, meta, { samples })
  if (!measured) {
    return {
      verified: false,
      reason: 'the rendered output could not be sampled for visual verification',
      oldBandDiff: null, newBandDiff: null, unrelatedDiff: null,
    }
  }
  const { before, after, count, width, height, toAnalysis } = measured
  const oldRegion = toAnalysis(oldBand)
  const newRegion = toAnalysis(newBand)

  let oldBandDiff = 0
  let newBandDiff = 0
  let unrelatedDiff = 0
  for (let i = 0; i < count; i++) {
    oldBandDiff += oldRegion ? regionDiff(before.frames[i], after.frames[i], width, height, oldRegion) : 0
    newBandDiff += newRegion ? regionDiff(before.frames[i], after.frames[i], width, height, newRegion) : 0
    unrelatedDiff += diffExcluding(before.frames[i], after.frames[i], width, height, [oldRegion, newRegion])
  }
  oldBandDiff = oldRegion ? oldBandDiff / count : null
  newBandDiff = newRegion ? newBandDiff / count : null
  unrelatedDiff = unrelatedDiff / count

  const round = (v) => v == null ? null : Math.round(v * 100) / 100
  return {
    verified: true,
    samples: count,
    oldBandDiff: round(oldBandDiff),
    newBandDiff: round(newBandDiff),
    unrelatedDiff: round(unrelatedDiff),
    // thresholds are tolerant of H.264 noise but strict enough to catch a
    // no-op: a real change moves tens of grey levels in the affected band.
    oldBandChanged: oldBandDiff != null ? oldBandDiff >= 8 : null,
    newCaptionsVisible: newBandDiff != null ? newBandDiff >= 4 : null,
    unrelatedUntouched: unrelatedDiff <= 7,
  }
}

module.exports = {
  detectBurnedInSubtitles,
  buildObscureGraph,
  verifyCaptionRender,
  decodeGrayFrames,
  rowMetrics,
  regionDiff,
  diffExcluding,
  even,
}
