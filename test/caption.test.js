// test/caption.test.js — unit tests for the caption replacement module
// (pure Node: graph composition, ASS generation, frag wiring, intent ops).
// Integration (detection/validate/audio) lives in py/test_caption.py
// (`npm run py:test:captions`).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const captions = require('../caption')

test('buildRegionEffects: blur chains only touch the region box', () => {
  const { chains, finalLabel } = captions.buildRegionEffects(
    [{ start: 0.3, end: 5, x: 100, y: 300, width: 500, height: 40 }],
    { width: 1280, height: 720 }, { method: 'blur', radius: 14 })
  const graph = chains.join(';')
  assert.match(graph, /crop=500:40:100:300/)
  assert.match(graph, /gblur=sigma=14/)
  assert.doesNotMatch(graph, /crop=1280:720/) // never a whole-frame crop
  assert.equal(finalLabel, 'fx0')
})

test('composeFfmpegGraph ends with libass burn + vendor fontsdir', () => {
  const graph = captions.composeFfmpegGraph(
    [`[0:v]split[a][b];[a]crop=10:10:0:0,gblur=sigma=8[c];[b][c]overlay=0:0[fx0]`],
    'fx0', '/tmp/x.ass')
  assert.match(graph, /\[fx0\]subtitles='\/tmp\/x\.ass':fontsdir=/)
  assert.match(graph, /fontsdir=\S*vendor\/fonts/)
  assert.match(graph, /setsar=1\[vout\]$/)
})

test('buildCaptionFrag maps original audio untouched', () => {
  const frag = captions.buildCaptionFrag(
    { regions: [{ start: 0, end: 4, x: 2, y: 2, width: 10, height: 10 }], method: 'blur', radius: 14, assFile: '/tmp/z.ass' },
    { width: 1280, height: 720 })
  assert.equal(frag.output, 'mp4')
  assert.deepEqual(frag.af, []) // no audio filters anywhere in the graph
  assert.equal(frag.audioMap, '0:a?')
  assert.match(frag.complex, /\[vout\]$/)
})

test('buildCaptionFrag with trim merges audio trim into the graph', () => {
  const plainFrag = { seek: { from: 1, to: 3 }, vf: [], af: [] }
  const frag = captions.buildCaptionFrag(
    { regions: [], method: 'blur', radius: 14, assFile: '/tmp/z.ass', pipe: { plainFrag } },
    { width: 1280, height: 720 })
  assert.equal(frag.audioMap, '[aout]')
  assert.match(frag.complex, /atrim=start=1:end=3/)
  assert.match(frag.complex, /trim=start=1:end=3/)
})

test('makeThaiAss: valid ASS, Thai cues survive unescaped, font picked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asstest-'))
  const file = captions.makeThaiAss([{ text: 'ทดสอบไทย', start: 0, end: 1.5 }], { width: 640, height: 360 }, dir)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /Noto Sans Thai/)
  assert.ok(text.includes('ทดสอบไทย'))
  assert.match(text, /Dialogue: 0,00:00:00\.00,00:00:01\.50/)
  // libass ValidationShape not available in unit tests — but ffmpeg renders a
  // frame from this fixture in py/test_caption.py, which would fail loudly on
  // an invalid .ass (style below covers wrap/margins; WrapStyle 3 = greedy
  // wrap with unlimited lines — 0 caps at 2 balanced lines and long Thai cues
  // overflow the frame width)
  assert.match(text, /WrapStyle: 3/)
})

test('normalizeOps keeps multi-step caption intents and labels them', () => {
  const ai = require('../ai')
  const nx = ai.normalizeOps({
    ops: [
      { kind: 'trim', to: 30 },
      { kind: 'replace_existing_subtitles', language: 'th', method: 'inpaint', radius: 20 },
      { kind: 'preserve_original_audio' },
      { kind: 'blur_caption_regions', radius: 9 },
      { kind: 'detect_caption_regions' },
      { kind: 'add_translated_subtitles', language: 'th' },
      { kind: 'text', text: 'hi', pos: 'top' },
    ],
    summary: 'x',
  }, { duration: 60, hasAudio: true })
  assert.ok(nx.ops, 'normalization dropped everything')
  const kinds = nx.ops.map((o) => o.kind)
  for (const k of ['trim', 'replace_existing_subtitles', 'preserve_original_audio',
    'blur_caption_regions', 'detect_caption_regions', 'add_translated_subtitles', 'text']) {
    assert.ok(kinds.includes(k), 'missing kind ' + k + ' got ' + kinds.join(','))
  }
  const rep = nx.ops.find((o) => o.kind === 'replace_existing_subtitles')
  assert.equal(rep.language, 'th')
  assert.equal(rep.radius, 20)
})
