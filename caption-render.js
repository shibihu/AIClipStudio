'use strict'

// ---------------------------------------------------------------------------
// caption-render.js — assembles the caption render fragment.
//
// One code path for "add" and "replace": the server and the tests both call
// this, so what is verified in tests is exactly what production renders.
// ---------------------------------------------------------------------------

const { writeCaptionAss } = require('./ai')
const { captionRegion, positionLabel } = require('./subtitle-layout')
const { buildObscureGraph } = require('./subtitle-removal')

/**
 * @param {object} options
 * @param {Array}  options.placed      timestamped cues
 * @param {object} options.meta        probed source metadata
 * @param {string} options.dir         job directory for the .ass file
 * @param {object} options.layout      resolved layout (position/style/alignment)
 * @param {'add'|'replace'} options.mode
 * @param {object|null} options.detection burned-in detection result (replace only)
 * @param {number} [options.layer]
 */
function buildCaptionRender({ placed, meta, dir, layout, mode = 'add', detection = null, layer = 0 }) {
  const useReplace = mode === 'replace' && detection && detection.found && detection.band
  const obscure = useReplace ? buildObscureGraph(detection.band, meta) : null
  const effectiveLayer = useReplace ? Math.max(1, layer) : layer

  const ass = writeCaptionAss(placed, meta, dir, {
    position: layout.position,
    style: layout.style,
    layer: effectiveLayer,
  })

  const captionCount = placed.length
  const summary = useReplace
    ? `replaced the burned-in subtitles with ${captionCount} new caption${captionCount === 1 ? '' : 's'} at ${positionLabel(layout.position)}`
    : `added ${captionCount} caption${captionCount === 1 ? '' : 's'} at ${positionLabel(layout.position)}`

  let frag
  if (obscure) {
    frag = {
      vf: [],
      af: [],
      extraArgs: [],
      // blur the old band, then burn the new captions on top of the result
      complex: `${obscure.graph};[obscured]${ass.filter}[vout]`,
      maps: ['[vout]', '0:a?'],
      output: 'mp4',
      desc: [summary],
    }
  } else {
    frag = { vf: [ass.filter], af: [], extraArgs: [], complex: null, output: 'mp4', desc: [summary] }
  }

  const facts = {
    operation: useReplace ? 'Subtitles replaced' : 'Subtitles added',
    captions: captionCount,
    subtitlePosition: layout.position,
    mode: useReplace ? 'replace' : 'add',
    layer: effectiveLayer,
    audio: { preserved: true, reason: 'original audio track copied unchanged' },
    audioPreserved: true,
    detection: detection || null,
  }

  const verify = {
    oldBand: obscure ? obscure.band : null,
    newBand: captionRegion(layout, meta),
  }

  return { frag, ass, obscure, facts, verify, summary, positionLabel: positionLabel(layout.position) }
}

module.exports = { buildCaptionRender }
