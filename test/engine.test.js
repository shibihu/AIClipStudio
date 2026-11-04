// ---------------------------------------------------------------------------
// test/engine.test.js — regression suite for the pure "AI brain" logic.
// Run with: npm test   (uses Node's built-in test runner — zero dependencies)
// Covers: understand() intent parsing, build() ffmpeg assembly, filter
// sanitising, LLM op normalisation, caption cue math.
// ---------------------------------------------------------------------------

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  understand, build, safeFilter, normalizeOps, extractJson,
  buildCues, placeCues, normalizeTranscriptCues,
} = require('../ai')

const META = { duration: 20, width: 1280, height: 720, hasAudio: true, fps: 30 }

// --- understand(): natural-language → op list ---------------------------------

test('understand: remove the first 3 seconds', () => {
  const r = understand('remove the first 3 seconds', META)
  assert.equal(r.ops.length, 1)
  assert.equal(r.ops[0].kind, 'trim')
  assert.equal(r.ops[0].from, 3)
})

test('understand: keep only 0:05 to 0:10', () => {
  const r = understand('keep only from 0:05 to 0:10', META)
  assert.equal(r.ops[0].kind, 'trim')
  assert.equal(r.ops[0].from, 5)
  assert.equal(r.ops[0].to, 10)
})

test('understand: cut the last 5 seconds uses duration', () => {
  const r = understand('cut the last 5 seconds', META)
  assert.equal(r.ops[0].kind, 'trim')
  assert.equal(r.ops[0].to, 15)
})

test('understand: speed up 2x', () => {
  const r = understand('make it 2x speed', META)
  assert.equal(r.ops[0].kind, 'speed')
  assert.equal(r.ops[0].vf, 'setpts=PTS/2')
})

test('understand: slow motion defaults to 0.5', () => {
  const r = understand('slow motion please', META)
  assert.equal(r.ops[0].kind, 'speed')
  assert.match(r.ops[0].label, /0\.5× slow motion/)
})

test('understand: mute + extract audio', () => {
  assert.equal(understand('mute it', META).ops[0].kind, 'mute')
  assert.equal(understand('give me just the audio', META).ops[0].kind, 'audioOut')
  assert.equal(understand('extract the audio', META).ops[0].outKind, 'mp3')
})

test('understand: volume louder 2x / quieter', () => {
  const up = understand('make it louder 2x', META)
  assert.equal(up.ops[0].kind, 'volume')
  assert.equal(up.ops[0].af, 'volume=2')
  // and the same message must NOT be misread as a speed change
  assert.equal(up.ops.find((o) => o.kind === 'speed'), undefined)
  const down = understand('make it quieter', META)
  assert.equal(down.ops[0].kind, 'volume')
  assert.match(down.ops[0].af, /volume=0\./)
})

test('understand: flips, rotation and aspect', () => {
  assert.equal(understand('mirror it', META).ops[0].vf, 'hflip')
  assert.equal(understand('turn it upside down', META).ops[0].vf, 'vflip')
  assert.equal(understand('rotate 90', META).ops[0].vf, 'transpose=1')
  assert.equal(understand('rotate 180', META).ops[0].vf, 'transpose=1,transpose=1')
  assert.equal(understand('make it square', META).ops[0].rx, 1)
  assert.equal(understand('9:16 for tiktok', META).ops[0].ry, 16)
})

test('understand: scale presets', () => {
  assert.equal(understand('make it 720p', META).ops[0].vf, 'scale=-2:720')
  assert.equal(understand('make it smaller', META).ops[0].vf, 'scale=iw/2:ih/2')
})

test('understand: gif + fps', () => {
  const g = understand('make a gif at 15 fps', META)
  assert.equal(g.ops[0].kind, 'gif')
  assert.equal(g.ops[0].fps, 15)
  const f = understand('convert to 24 fps', META)
  assert.equal(f.ops[0].vf, 'fps=24')
})

test('understand: reverse and boomerang', () => {
  assert.equal(understand('play it backwards', META).ops[0].kind, 'reverse')
  assert.equal(understand('make a boomerang', META).ops[0].kind, 'boomerang')
})

test('understand: color looks', () => {
  assert.equal(understand('black and white', META).ops[0].vf, 'hue=s=0')
  assert.equal(understand('make it sepia vintage', META).ops[0].kind, 'sepia')
  assert.equal(understand('brighter', META).ops[0].vf, 'eq=brightness=0.08')
  assert.equal(understand('more contrast', META).ops[0].vf, 'eq=contrast=1.3')
})

test('understand: blur with radius', () => {
  assert.equal(understand('blur it', META).ops[0].vf, 'boxblur=4')
  assert.equal(understand('blur by 10', META).ops[0].vf, 'boxblur=10')
})

test('understand: text overlay with quotes, position and size', () => {
  const r = understand("add text 'Good Vibes Only' at the top, big font", META)
  const t = r.ops.find((o) => o.kind === 'text')
  assert.equal(t.text, 'Good Vibes Only')
  assert.equal(t.pos, 'top')
  assert.equal(t.size, 52)
})

test('understand: chained edits in one message', () => {
  const r = understand("cut the first 3 seconds, make it square, add text 'HI'", META)
  const kinds = r.ops.map((o) => o.kind)
  assert.deepEqual(kinds, ['trim', 'aspect', 'text'])
})

test('understand: unknown message yields no ops', () => {
  const r = understand('hello, how are you today?', META)
  assert.equal(r.ops.length, 0)
  assert.equal(r.unknown, true)
})

test('understand: empty message', () => {
  assert.equal(understand('', META).unknown, true)
})

// --- regressions: "shorter"/"slow" wording must not trigger unrelated ops ------

test('understand: "make it shorter" no longer crops to 9:16', () => {
  const r = understand('make the video shorter', META)
  assert.equal(r.ops.find((o) => o.kind === 'aspect'), undefined)
})

test('understand: "make it 5 seconds shorter" trims 5s off the end', () => {
  const r = understand('make it 5 seconds shorter', META)
  assert.deepEqual(r.ops.map((o) => o.kind), ['trim'])
  assert.equal(r.ops[0].to, 15)
})

test('understand: "shorter by 5" trims 5s off too', () => {
  const r = understand('make the clip shorter by 5', META)
  assert.deepEqual(r.ops.map((o) => o.kind), ['trim'])
  assert.equal(r.ops[0].to, 15)
})

test('understand: "shorten the clip to 10 seconds" keeps the first 10s', () => {
  const r = understand('shorten the clip to 10 seconds', META)
  assert.deepEqual(r.ops.map((o) => o.kind), ['trim'])
  assert.equal(r.ops[0].to, 10)
})

test('understand: explicit vertical intent still crops (regression)', () => {
  assert.equal(understand('9:16 for tiktok', META).ops[0].rx, 9)
  assert.equal(understand('make a youtube short version', META).ops[0].ry, 16)
})

test('understand: "slower 2x" slows down instead of speeding up', () => {
  const r = understand('slower 2x please', META)
  assert.equal(r.ops[0].kind, 'speed')
  assert.equal(r.ops[0].vf, 'setpts=PTS*2.000')
  assert.equal(r.ops[0].af, 'atempo=0.5')
})

test('understand: "2x speed" still speeds up (regression)', () => {
  const r = understand('2x speed', META)
  assert.equal(r.ops[0].vf, 'setpts=PTS/2')
})

// --- build(): op list → ffmpeg fragments ---------------------------------------

test('build: bare trim becomes fast-seek (no filter graph)', () => {
  const frag = build([{ kind: 'trim', from: 2, to: 6 }], META, null)
  assert.deepEqual(frag.seek, { from: 2, to: 6 })
  assert.equal(frag.complex, null)
  assert.equal(frag.vf.length, 0)
})

test('build: trim + visual filter trims inside the graph', () => {
  const frag = build(
    [{ kind: 'trim', from: 2, to: 6 }, { kind: 'gray', label: 'b&w', vf: 'hue=s=0' }],
    META, null,
  )
  assert.equal(frag.seek, undefined)
  assert.match(frag.vf[0], /^trim=start=2:end=6,setpts=PTS-STARTPTS$/)
  assert.match(frag.af[0], /^atrim=start=2:end=6/)
  assert.equal(frag.vf[1], 'hue=s=0')
})

test('build: mute appends -an', () => {
  const frag = build([{ kind: 'mute', label: 'mute' }], META, null)
  assert.deepEqual(frag.extraArgs, ['-an'])
})

test('build: audioOut switches output to mp3 and drops video filters', () => {
  const frag = build(
    [{ kind: 'gray', label: 'b&w', vf: 'hue=s=0' }, { kind: 'audioOut', label: 'mp3' }],
    META, null,
  )
  assert.equal(frag.output, 'mp3')
  assert.equal(frag.vf.length, 0)
})

test('build: mute + audioOut still yields a renderable mp3 (no -an)', () => {
  const frag = build(
    [{ kind: 'mute', label: 'mute' }, { kind: 'audioOut', label: 'mp3', outKind: 'mp3' }],
    META, null,
  )
  assert.equal(frag.output, 'mp3')
  assert.equal(frag.extraArgs.includes('-an'), false)
})

test('build: mute stays intact for mp4 output', () => {
  const frag = build([{ kind: 'mute', label: 'mute' }], META, null)
  assert.equal(frag.output, 'mp4')
  assert.deepEqual(frag.extraArgs, ['-an'])
})

test('build: gif builds a palette filter graph', () => {
  const frag = build([{ kind: 'gif', label: 'gif', fps: 12, width: 480 }], META, null)
  assert.equal(frag.output, 'gif')
  assert.match(frag.complex, /palettegen/)
  assert.match(frag.complex, /fps=12/)
})

test('build: boomerang concatenates a reversed copy and mutes audio', () => {
  const frag = build([{ kind: 'boomerang', label: 'boomerang' }], META, null)
  assert.match(frag.complex, /reverse/)
  assert.match(frag.complex, /concat/)
  assert.deepEqual(frag.extraArgs, ['-an'])
})

test('build: crop to 9:16 from 1280x720, output keeps square pixels', () => {
  const frag = build([{ kind: 'aspect', label: '9:16', rx: 9, ry: 16 }], META, null)
  assert.match(frag.vf[0], /^crop=406:720:/)
  assert.equal(frag.vf[1], 'setsar=1')
})

test('build: square crop from 1280x720', () => {
  const frag = build([{ kind: 'aspect', label: '1:1', rx: 1, ry: 1 }], META, null)
  assert.match(frag.vf[0], /^crop=720:720:/)
})

test('build: text op forwards its subtitles filter', () => {
  const frag = build([{ kind: 'text', label: 'text', vf: "subtitles='/x/overlay-1.ass'" }], META, null)
  assert.match(frag.vf[0], /^subtitles=/)
})

test('build: speed without audio keeps atempo empty-proof (@ no audio, aout skip)', () => {
  const frag = build([{ kind: 'speed', label: '2x', vf: 'setpts=PTS/2', af: 'atempo=2' }], { ...META, hasAudio: false }, null)
  assert.equal(frag.vf[0], 'setpts=PTS/2')
})

// --- safeFilter: the LLM must not be able to escape the sandbox ----------------

test('safeFilter: accepts plain filters', () => {
  assert.equal(safeFilter('eq=brightness=0.1'), 'eq=brightness=0.1')
  assert.equal(safeFilter('vignette'), 'vignette')
  assert.equal(safeFilter('fade=t=in:st=0:d=1'), 'fade=t=in:st=0:d=1')
})

test('safeFilter: rejects file-based / escape attempts', () => {
  const bad = [
    "subtitles='x.ass'", 'drawtext=fontfile=/etc/passwd', 'overlay', 'movie=x.mp4',
    'file', "eq'$(rm -rf)", 'a\\b', 'a|b', 'a;b', 'hflip;',
    'x'.repeat(501),
  ]
  for (const b of bad) assert.equal(safeFilter(b), null, `should reject ${b}`)
})

// --- normalizeOps: LLM JSON → validated ops ------------------------------------

test('normalizeOps: chat-only answer becomes a chat reply', () => {
  const r = normalizeOps({ ops: [{ kind: 'chat', reply: 'It is a nice clip!' }] }, META)
  assert.equal(r.isChat, true)
  assert.equal(r.reply, 'It is a nice clip!')
})

test('normalizeOps: clamps trim to duration', () => {
  const r = normalizeOps({ ops: [{ kind: 'trim', from: 5, to: 999 }] }, META)
  assert.equal(r.ops[0].to, 20)
})

test('normalizeOps: speed builds setpts + atempo chain', () => {
  const r = normalizeOps({ ops: [{ kind: 'speed', rate: 4 }] }, META)
  assert.match(r.ops[0].vf, /setpts=PTS\/4/)
  assert.match(r.ops[0].af, /atempo=2,atempo=2/)
})

test('normalizeOps: rotation maps degrees to transpose', () => {
  const r = normalizeOps({ ops: [{ kind: 'rotate', deg: 270 }] }, META)
  assert.equal(r.ops[0].vf, 'transpose=2')
})

test('normalizeOps: eq builds a joined filter, empty eq dropped', () => {
  const r = normalizeOps({ ops: [{ kind: 'eq', saturation: 1.6, brightness: 0.05 }] }, META)
  assert.equal(r.ops[0].vf, 'eq=brightness=0.05:saturation=1.6')
  const empty = normalizeOps({ ops: [{ kind: 'eq' }] }, META)
  assert.equal(empty, null)
})

test('normalizeOps: unsafe filter/afilter dropped', () => {
  assert.equal(normalizeOps({ ops: [{ kind: 'filter', vf: "subtitles='x'" }] }, META), null)
  const r = normalizeOps({ ops: [{ kind: 'filter', vf: 'vignette' }] }, META)
  assert.equal(r.ops[0].vf, 'vignette')
})

test('normalizeOps: unknown kinds dropped entirely', () => {
  assert.equal(normalizeOps({ ops: [{ kind: 'wipecrop' }] }, META), null)
})

test('normalizeOps: text normalised (pos whitelist, size clamp)', () => {
  const r = normalizeOps({ ops: [{ kind: 'text', text: 'HI', pos: 'sideways', size: 99999 }] }, META)
  assert.equal(r.ops[0].pos, 'center')
  assert.equal(r.ops[0].size, 200)
})

test('normalizeOps: ops with missing/invalid required fields are dropped entirely', () => {
  const r = normalizeOps({
    ops: [
      { kind: 'speed' },              // no rate
      { kind: 'speed', rate: 1 },     // 1× is a no-op
      { kind: 'volume' },             // no factor
      { kind: 'volume', factor: 0 },
      { kind: 'fps' },                // no value
      { kind: 'text', text: '   ' },  // empty text
      { kind: 'rotate', deg: 45 },    // unsupported angle
      { kind: 'scale', height: -3 },
      { kind: 'gif', fps: -2 },
    ],
  }, META)
  assert.equal(r, null)
})

test('normalizeOps: valid mixed ops survive validation', () => {
  const r = normalizeOps({ ops: [{ kind: 'speed', rate: 2 }, { kind: 'text', text: 'hi' }, { kind: 'rotate', deg: -90 }] }, META)
  assert.equal(r.ops.length, 3)
  assert.equal(r.ops[2].vf, 'transpose=2')
})

test('normalizeOps: afilter kept on audio clips, dropped on video-only', () => {
  const r = normalizeOps({ ops: [{ kind: 'afilter', af: 'bass=g=8' }] }, META)
  assert.equal(r.ops[0].af, 'bass=g=8')
  assert.equal(normalizeOps({ ops: [{ kind: 'afilter', af: 'bass=g=8' }] }, { ...META, hasAudio: false }), null)
})

test('normalizeOps: gif + blur normalised/clamped', () => {
  const r = normalizeOps({ ops: [{ kind: 'gif', fps: 500, width: 99999 }, { kind: 'blur', radius: 999 }] }, META)
  assert.equal(r.ops[0].fps, 60)
  assert.equal(r.ops[0].width, 1280)
  assert.equal(r.ops[1].vf, 'boxblur=20')
})

// --- extractJson ----------------------------------------------------------------

test('extractJson: tolerates prose around the JSON', () => {
  assert.equal(extractJson('Sure! Here you go: {"ops":[]}'), '{"ops":[]}')
  assert.equal(extractJson('[note] {"a":{"b":1}} (end)'), '{"a":{"b":1}}')
  assert.equal(extractJson('no braces here'), 'no braces here')
})

// --- caption cue math ------------------------------------------------------------

test('buildCues: wraps long lines and caps count', () => {
  const lines = buildCues('Short line\nA much longer line that definitely needs to be wrapped into several caption chunks')
  assert.ok(lines.length >= 3)
  for (const c of lines) assert.ok(c.length <= 48)
})

test('buildCues: empty input yields nothing', () => {
  assert.deepEqual(buildCues('   \n  '), [])
})

test('placeCues: distributes cues proportionally over segments', () => {
  const placed = placeCues(['a', 'b', 'c', 'd'], [[0, 10], [20, 30]])
  assert.equal(placed.length, 4)
  const inSeg1 = placed.filter((c) => c.start >= 0 && c.end <= 10)
  const inSeg2 = placed.filter((c) => c.start >= 20 && c.end <= 30)
  assert.ok(inSeg1.length >= 1 && inSeg2.length >= 1)
  for (const c of placed) assert.ok(c.end > c.start)
})

test('normalizeTranscriptCues: validates, clips and wraps STT output', () => {
  const raw = [
    { text: 'one two three four five six seven eight nine ten eleven twelve thirteen', start: 0, end: 5 },
    { text: '', start: 5, end: 6 },               // empty → dropped
    { text: 'overlapping end', start: 8.8, end: 10.5 }, // clipped to duration 10
    { text: 'too short', start: 6.0, end: 6.05 }, // zero-length → dropped
  ]
  const out = normalizeTranscriptCues(raw, { duration: 10 })
  assert.ok(out.length >= 3)
  for (const c of out) {
    assert.ok(c.start >= 0 && c.end <= 10)
    assert.ok(c.text.length <= 48)
    assert.ok(c.end > c.start)
  }
  // sorted by start
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start >= out[i - 1].start)
})

test('normalizeTranscriptCues: caps cue count', () => {
  const many = []
  for (let i = 0; i < 40; i++) many.push({ text: `cue number ${i} speaking`, start: i * 0.5, end: i * 0.5 + 0.4 })
  const out = normalizeTranscriptCues(many, { duration: 30 }, { maxCues: 10 })
  assert.ok(out.length <= 10)
})

test('normalizeTranscriptCues: survives garbage input', () => {
  assert.deepEqual(normalizeTranscriptCues(null, META), [])
  assert.deepEqual(normalizeTranscriptCues('nope', META), [])
  assert.deepEqual(normalizeTranscriptCues([42, {}], META), [])
})
