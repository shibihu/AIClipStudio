'use strict'

// ---------------------------------------------------------------------------
// render-args.js — turns a render "fragment" into FFmpeg argv.
//
// Extracted from server.js so the caption pipeline can be exercised by tests
// with the exact same command the server runs (including filter_complex maps).
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object} options.frag   { vf, af, extraArgs, complex, maps, output, seek }
 * @param {string} options.src    input path
 * @param {string} options.outPath output path
 * @param {object} options.meta   probed media metadata (hasAudio, duration)
 * @returns {string[]}
 */
function buildFfmpegArgs({ frag, src, outPath, meta = {} }) {
  const args = ['-y', '-hide_banner', '-progress', 'pipe:1', '-nostats']
  if (frag.seek && (frag.seek.from != null || frag.seek.to != null)) {
    // fast-seek: -ss before -i stays frame-accurate for re-encode output
    if (frag.seek.from != null) args.push('-ss', String(frag.seek.from))
    args.push('-i', src)
    if (frag.seek.to != null) args.push('-t', String(Math.max(0.05, frag.seek.to - (frag.seek.from || 0))))
  } else {
    args.push('-i', src)
  }
  if (frag.complex) {
    args.push('-filter_complex', frag.complex)
    for (const map of frag.maps || []) args.push('-map', map)
  } else {
    if (frag.vf && frag.vf.length) args.push('-vf', frag.vf.join(','))
    if (frag.af && frag.af.length) args.push('-af', frag.af.join(','))
  }
  if (frag.output === 'mp4') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-movflags', '+faststart', '-pix_fmt', 'yuv420p')
    if (frag.af && frag.af.length) args.push('-c:a', 'aac', '-b:a', '160k')
    else if (meta.hasAudio && !(frag.extraArgs || []).includes('-an')) args.push('-c:a', 'copy')
  }
  if (frag.output === 'mp3') args.push('-vn')
  args.push(...(frag.extraArgs || []), outPath)
  return args
}

function displayCommand(bin, args, outPath) {
  return `${bin} ${args.map((a) => (/[\s'"]/.test(a) && a !== outPath && !a.startsWith('-') ? `"${a}"` : a)).join(' ')}`
}

module.exports = { buildFfmpegArgs, displayCommand }
