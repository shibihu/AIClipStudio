// ---------------------------------------------------------------------------
// test/render-report.test.js — user-facing text must never leak internals.
// BUG 3: raw FFmpeg commands, stderr and server paths appeared in chat.
// ---------------------------------------------------------------------------

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  stripInternalDetails,
  formatRenderReport,
  formatDuration,
  renderFacts,
  technicalDetails,
  maybeAttachTechnical,
  DEBUG_ENABLED,
} = require('../render-report')

function doneReg(overrides = {}) {
  return {
    rid: 'rid-1',
    jobId: 'job-1',
    status: 'done',
    srcName: 'input.mp4',
    outName: 'out-2.mp4',
    startedAt: 1000,
    finishedAt: 5000,
    summary: 'added 12 captions at center',
    cmdDisplay: 'ffmpeg -y -i C:/Users/me/jobs/abc/input.mp4 -vf subtitles=filename=\'C\\:/Users/me/jobs/abc/captions.ass\' out-2.mp4',
    errTail: '',
    facts: {
      operation: 'Subtitles added',
      captions: 12,
      outputDuration: 18.44,
      subtitlePosition: 'center',
      mode: 'add',
      audio: { preserved: true, reason: 'original audio track copied unchanged' },
      audioPreserved: true,
      detection: { found: false, skipped: true },
      verification: { verified: true, newCaptionsVisible: true, unrelatedUntouched: true },
    },
    ...overrides,
  }
}

test('report: success summary contains every required user-facing field', () => {
  const text = formatRenderReport(doneReg())
  assert.match(text, /^✅/)
  assert.match(text, /Subtitles added/)
  assert.match(text, /Captions: 12/)
  assert.match(text, /Length: 18s/)
  assert.match(text, /Position: center/)
  assert.match(text, /Audio: original audio preserved/)
  assert.match(text, /Verified: new captions visible/)
})

test('report: success never contains commands, paths or stderr', () => {
  const text = formatRenderReport(doneReg())
  assert.ok(!/ffmpeg/i.test(text), text)
  assert.ok(!/C:[\\/]/.test(text), text)
  assert.ok(!/\.ass/.test(text), text)
  assert.ok(!/libx264|filter_complex|-crf/.test(text), text)
})

test('report: replace mode reports detection confidence and old-band verification', () => {
  const text = formatRenderReport(doneReg({
    facts: {
      operation: 'Subtitles replaced',
      captions: 8,
      outputDuration: 9.2,
      subtitlePosition: 'bottom_center',
      mode: 'replace',
      audio: { preserved: true },
      detection: { found: true, confidence: 0.82 },
      verification: { verified: true, oldBandChanged: true, newCaptionsVisible: true, unrelatedUntouched: true },
    },
  }))
  assert.match(text, /Old subtitles: obscured \(detection confidence 82%\)/)
  assert.match(text, /old subtitle area changed/)
})

test('report: replace mode with no confident detection says so, never claims removal', () => {
  const text = formatRenderReport(doneReg({
    facts: {
      operation: 'Subtitles added',
      captions: 5,
      subtitlePosition: 'center',
      mode: 'replace',
      audio: { preserved: true },
      detection: { found: false, confidence: 0.2, reason: 'no persistent band' },
    },
  }))
  assert.match(text, /none detected with confidence/)
  assert.ok(!/obscured/.test(text))
})

test('report: failure is user-friendly and hides stderr', () => {
  const reg = {
    rid: 'rid-2',
    status: 'failed',
    failureHint: 'I hit a problem while rendering that edit.',
    errTail: '[libx264 @ 0000] Error while opening encoder\nC:\\secret\\path\\input.mp4: Invalid data',
    cmdDisplay: 'ffmpeg -y -i /srv/jobs/x/input.mp4 out.mp4',
  }
  const text = formatRenderReport(reg)
  assert.match(text, /^⚠️/)
  assert.ok(!/libx264|secret|srv\/jobs|Invalid data|ffmpeg/.test(text), text)
})

test('sanitizer: strips commands and absolute paths from any text', () => {
  const dirty = [
    'Done. I ran:',
    '`ffmpeg -y -i /srv/jobs/abc/input.mp4 -vf subtitles=filename=\'/srv/jobs/abc/c.ass\' out-2.mp4`',
    'The file C:\\Users\\me\\jobs\\abc\\out-2.mp4 is ready.',
    'stderr said: libx264 error',
  ].join('\n')
  const clean = stripInternalDetails(dirty)
  assert.ok(!/ffmpeg/i.test(clean), clean)
  assert.ok(!/libx264/i.test(clean), clean)
  assert.ok(!/\/srv\/jobs/.test(clean), clean)
  assert.ok(!/C:\\Users/.test(clean), clean)
  assert.match(clean, /Done\./)
})

test('sanitizer: leaves normal prose and emoji untouched', () => {
  const text = '✅ Subtitles added\n• Position: center\n• Audio: original audio preserved'
  assert.equal(stripInternalDetails(text), text)
})

test('technical details stay server-side unless debug mode is enabled', () => {
  const prev = process.env.EXPOSE_RENDER_DEBUG
  delete process.env.EXPOSE_RENDER_DEBUG
  const reg = doneReg()
  const payload = { status: 'done' }
  const hidden = maybeAttachTechnical(reg, payload)
  assert.equal(hidden.commands, undefined)
  assert.equal(hidden.technical, undefined)

  process.env.EXPOSE_RENDER_DEBUG = '1'
  assert.equal(DEBUG_ENABLED(), true)
  const shown = maybeAttachTechnical(reg, payload)
  assert.ok(shown.technical.command.includes('ffmpeg'))
  assert.ok(Array.isArray(shown.commands) && shown.commands[0].includes('ffmpeg'))
  assert.deepEqual(Object.keys(technicalDetails(reg)).sort(), ['command', 'durationMs', 'jobId', 'output', 'renderId', 'source', 'status', 'stderrTail'].sort())

  if (prev === undefined) delete process.env.EXPOSE_RENDER_DEBUG
  else process.env.EXPOSE_RENDER_DEBUG = prev
})

test('duration formatting', () => {
  assert.equal(formatDuration(8.25), '8.3s')
  assert.equal(formatDuration(18.44), '18s')
  assert.equal(formatDuration(64.4), '1m 04s')
  assert.equal(formatDuration(null), null)
})

test('renderFacts: exposes a position label and success flag', () => {
  const facts = renderFacts(doneReg())
  assert.equal(facts.subtitlePosition, 'center')
  assert.equal(facts.subtitlePositionLabel, 'center')
  assert.equal(facts.success, true)
  assert.equal(facts.captions, 12)
})
