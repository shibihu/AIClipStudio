'use strict'

// ---------------------------------------------------------------------------
// render-report.js — the ONLY place that turns render internals into text a
// user reads. Raw FFmpeg commands, stderr and server paths stay in the
// server-side log; they may only reach a client when the operator explicitly
// turns on EXPOSE_RENDER_DEBUG=1 (developer mode).
// ---------------------------------------------------------------------------

const { positionLabel } = require('./subtitle-layout')

const DEBUG_ENABLED = () => /^(1|true|yes|on)$/i.test(String(process.env.EXPOSE_RENDER_DEBUG || '').trim())

// Patterns that betray implementation detail. Applied to every outgoing chat
// string as a final safety net (LLM replies, legacy job history, …).
const INTERNAL_PATTERNS = [
  /\bffmpeg\b[^\n\r]*/gi,
  /\bffprobe\b[^\n\r]*/gi,
  /\blibx264\b[^\n\r]*/gi,
  /\b-filter_complex\b[^\n\r]*/gi,
  /\bvf\s*=\s*[^\n\r]*/gi,
  /(?:[A-Za-z]:[\\/]|\/(?:home|tmp|Users|app|var|mnt|opt|srv|root)\/|\/(?:jobs|media)\/)[^\s`"'<>)]+/g,
  /\b(?:input|wrapper)\.[\w.-]+/g,
]

function stripInternalDetails(text) {
  let out = String(text == null ? '' : text)
  for (const pattern of INTERNAL_PATTERNS) out = out.replace(pattern, '')
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/`{1,3}\s*`{1,3}/g, '')
    .trim()
}

function formatDuration(seconds) {
  const total = Number(seconds)
  if (!Number.isFinite(total) || total <= 0) return null
  if (total < 60) return `${total.toFixed(total < 10 ? 1 : 0)}s`
  const m = Math.floor(total / 60)
  const s = Math.round(total % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

function audioLine(audio) {
  if (!audio) return null
  if (audio.preserved === true) return 'original audio preserved'
  if (audio.preserved === false) return audio.reason || 'audio changed'
  return null
}

/**
 * Structured, public render facts. Everything here is safe to send to a client.
 */
function renderFacts(reg) {
  const facts = reg.facts || {}
  const out = {
    operation: facts.operation || reg.summary || 'Edit',
    captions: Number.isFinite(facts.captions) ? facts.captions : null,
    outputDuration: Number.isFinite(facts.outputDuration) ? facts.outputDuration : null,
    subtitlePosition: facts.subtitlePosition || null,
    subtitlePositionLabel: facts.subtitlePosition ? positionLabel(facts.subtitlePosition) : null,
    audioPreserved: facts.audioPreserved,
    audioNote: audioLine(facts.audio),
    mode: facts.mode || null,
    detection: facts.detection || null,
    verification: facts.verification || null,
    success: reg.status === 'done',
  }
  return out
}

/**
 * The concise chat message a user sees when a render completes or fails.
 */
function formatRenderReport(reg) {
  const facts = renderFacts(reg)
  if (!facts.success) {
    const reason = reg.failureHint || 'The render could not be completed.'
    return `⚠️ ${reason}\n\nNo changes were made to your video. You can try again — if it keeps failing, upload a shorter clip.`
  }

  const lines = []
  const headline = facts.operation || 'Edit completed'
  lines.push(`✅ ${headline}`)

  const details = []
  if (facts.captions != null) details.push(`Captions: ${facts.captions}`)
  if (facts.outputDuration != null) {
    const d = formatDuration(facts.outputDuration)
    if (d) details.push(`Length: ${d}`)
  }
  if (facts.subtitlePositionLabel) details.push(`Position: ${facts.subtitlePositionLabel}`)
  if (facts.audioNote) details.push(`Audio: ${facts.audioNote}`)
  if (facts.mode === 'replace') {
    const det = facts.detection
    if (det && det.found) {
      details.push(`Old subtitles: obscured (detection confidence ${Math.round((det.confidence || 0) * 100)}%)`)
    } else if (det) {
      details.push('Old subtitles: none detected with confidence — left as-is')
    }
  }
  if (facts.verification && facts.verification.verified) {
    const v = facts.verification
    const parts = []
    if (v.oldBandChanged) parts.push('old subtitle area changed')
    if (v.oldBandChanged === false && facts.mode === 'replace') parts.push('old subtitle area unchanged (check the result)')
    if (v.newCaptionsVisible) parts.push('new captions visible')
    if (v.unrelatedUntouched === false) parts.push('some pixels outside the caption area changed')
    if (parts.length) details.push(`Verified: ${parts.join(', ')}`)
  }

  if (details.length) lines.push(details.map((d) => `• ${d}`).join('\n'))
  lines.push('Preview below shows the rendered result.')
  return lines.join('\n')
}

/** Failure text for a render — never includes stderr. */
function formatRenderError(reg) {
  void reg
  return 'Something went wrong while rendering. No changes were made to your video.'
}

/** Full diagnostics for server logs / explicit developer mode. */
function technicalDetails(reg) {
  if (!reg) return null
  return {
    renderId: reg.rid,
    jobId: reg.jobId,
    status: reg.status,
    source: reg.srcName,
    output: reg.outName,
    durationMs: reg.finishedAt && reg.startedAt ? reg.finishedAt - reg.startedAt : null,
    command: reg.cmdDisplay,
    stderrTail: reg.errTail || null,
  }
}

function maybeAttachTechnical(reg, payload) {
  if (!DEBUG_ENABLED()) return payload
  return { ...payload, technical: technicalDetails(reg), commands: [reg.cmdDisplay] }
}

module.exports = {
  DEBUG_ENABLED,
  stripInternalDetails,
  formatDuration,
  renderFacts,
  formatRenderReport,
  formatRenderError,
  technicalDetails,
  maybeAttachTechnical,
}
