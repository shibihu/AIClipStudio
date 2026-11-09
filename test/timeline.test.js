// ---------------------------------------------------------------------------
// test/timeline.test.js — timeline model + AI editing tools (pure logic, no
// ffmpeg/python needed; python-backed tools are exercised by py/test_service.py
// and integration checks there). Run: npm test.
// ---------------------------------------------------------------------------

const { test } = require('node:test')
const assert = require('node:assert/strict')
const timeline = require('../timeline')
const tools = require('../tools')

function tl3() {
  const tl = timeline.newTimeline({ id: 'j1', fps: 30, width: 1280, height: 720 })
  const v = timeline.newTrack('video', 'V1', 0)
  const a = timeline.newTrack('audio', 'A1', 1)
  tl.tracks = [v, a]
  timeline.addClip(tl, { trackId: v.id, asset: 'a.mp4', name: 'A', duration: 10 }, 0)
  timeline.addClip(tl, { trackId: a.id, asset: 'a.mp4', kind: 'audio', name: 'snd', duration: 10 }, 0)
  return tl
}

function ctx(tl) {
  return {
    tl,
    dir: '/jobs/j1',
    meta: { versionName: 'input.mp4', duration: 20, width: 1280, height: 720, hasAudio: true, hasVideo: true },
    py: () => { throw new Error('no python in unit test') },
    changed: false,
  }
}

// --- model -------------------------------------------------------------------

test('addClip appends at the tail and keeps timestamps', () => {
  const tl = timeline.newTimeline({})
  const c = timeline.addClip(tl, { asset: 'x.mp4', duration: 5 })
  assert.equal(c.timelineStart, 0)
  const c2 = timeline.addClip(tl, { asset: 'x2.mp4', duration: 7 })
  assert.equal(c2.timelineStart, 5)
  assert.equal(timeline.timelineDuration(tl), 12)
})

test('addClip rejects empty asset and absurd durations', () => {
  const tl = timeline.newTimeline({})
  assert.throws(() => timeline.addClip(tl, { asset: '..', duration: 1 }), /asset/)
  assert.throws(() => timeline.addClip(tl, { asset: 'ok.mp4', duration: 0 }), /duration/)
})

test('splitClip produces two adjacent clips with exact math', () => {
  const tl = tl3()
  const v = tl.tracks[0]
  const [left, right] = timeline.splitClip(tl, v.clips[0].id, 4)
  assert.equal(left.duration, 4)
  assert.equal(right.duration, 6)
  assert.equal(right.timelineStart, 4)
  assert.equal(v.clips.length, 2)
  assert.equal(timeline.timelineDuration(tl), 10)
})

test('splitClip refuses points outside the clip', () => {
  const tl = tl3()
  const id = tl.tracks[0].clips[0].id
  assert.throws(() => timeline.splitClip(tl, id, 40), /inside/)
})

test('trimClip adjusts source window and duration', () => {
  const tl = tl3()
  const id = tl.tracks[0].clips[0].id
  const c = timeline.trimClip(tl, id, { timelineStart: 2, sourceStart: 3, duration: 5 })
  assert.equal(c.timelineStart, 2)
  assert.equal(c.sourceStart, 3)
  assert.equal(c.duration, 5)
})

test('moveClip shifts in time and across tracks of the same kind', () => {
  const tl = tl3()
  const v = timeline.newTrack('video', 'V2', 2)
  tl.tracks.push(v)
  const id = tl.tracks[0].clips[0].id
  const c = timeline.moveClip(tl, id, { timelineStart: 1, trackId: v.id })
  assert.equal(c.timelineStart, 1)
  assert.equal(v.clips.length, 1)
  assert.equal(tl.tracks[0].clips.length, 0)
  // cross-kind move is refused
  const aid = tl.tracks[1].clips[0].id
  assert.throws(() => timeline.moveClip(tl, aid, { trackId: v.id }), /onto a video track/)
})

test('reorderClip re-packs the track sequentially', () => {
  const tl = timeline.newTimeline({})
  const a = timeline.addClip(tl, { asset: 'a.mp4', duration: 1, name: 'a' })
  const b = timeline.addClip(tl, { asset: 'b.mp4', duration: 2, name: 'b' })
  const c = timeline.addClip(tl, { asset: 'c.mp4', duration: 3, name: 'c' })
  timeline.reorderClip(tl, c.id, 0)
  const names = tl.tracks[0].clips.map((x) => x.name)
  assert.deepEqual(names, ['c', 'a', 'b'])
  assert.deepEqual(
    tl.tracks[0].clips.map((x) => x.timelineStart), [0, 3, 4])
})

test('removeClip closes gaps when asked', () => {
  const tl = timeline.newTimeline({})
  const a = timeline.addClip(tl, { asset: 'a.mp4', duration: 2 })
  timeline.addClip(tl, { asset: 'b.mp4', duration: 2 })
  timeline.removeClip(tl, a.id, { trimGap: true })
  assert.deepEqual(tl.tracks[0].clips.map((x) => x.timelineStart), [0])
})

test('sanitizeAndSort prevents overlaps after inserts', () => {
  const tl = timeline.newTimeline({})
  timeline.addClip(tl, { asset: 'a.mp4', duration: 5 })
  const c = timeline.addClip(tl, { asset: 'b.mp4', duration: 2 })
  c.timelineStart = 3 // collision → sanitize pulls it back to 5
  timeline.sanitizeAndSort(tl.tracks[0])
  assert.equal(c.timelineStart, 5)
})

test('transitions and markers validate', () => {
  const tl = tl3()
  timeline.addTransition(tl, tl.tracks[0].clips[0].id, { type: 'cross_dissolve', duration: 0.5 })
  timeline.addMarker(tl, { time: 3.5, label: 'hook' })
  assert.equal(tl.tracks[0].clips[0].transitionIn.type, 'cross_dissolve')
  assert.throws(() => timeline.addTransition(tl, tl.tracks[0].clips[0].id, { type: 'nope' }), /transition/)
  // unknown clip
  assert.throws(() => timeline.addTransition(tl, 'zz', { type: 'cut' }), /no such clip/)
})

test('setClipProps re-times speed without touching the source window', () => {
  const tl = tl3()
  const id = tl.tracks[0].clips[0].id
  const c = timeline.setClipProps(tl, id, { speed: 2, volume: 0.5, muted: true })
  assert.equal(c.speed, 2)
  assert.equal(c.duration, 5) // 10s at 2× = 5s
  assert.equal(c.volume, 0.5)
  assert.equal(c.muted, true)
})

test('sanitize() accepts summarized timelines round-trip', () => {
  const tl = tl3()
  const s = timeline.summarize(tl)
  const t2 = timeline.sanitize(JSON.parse(JSON.stringify(s)))
  assert.equal(t2.tracks.length, 2)
  assert.equal(t2.tracks[0].clips.length, 1)
  assert.equal(timeline.timelineDuration(t2), 10)
})

// --- tools --------------------------------------------------------------------

test('tool catalog: every name resolves and has an arg description', () => {
  assert.ok(tools.CATALOG.length >= 25)
  for (const t of tools.CATALOG) {
    assert.ok(t.name && t.group && t.args, t.name)
    assert.equal(tools.getTool(t.name), t)
  }
})

test('add_clip/remove_clip/split_clip via tool ctx', () => {
  const tl = timeline.newTimeline({ id: 'j1', fps: 30 })
  const c = ctx(tl)
  const r1 = tools.getTool('add_clip').fn(c, { trackId: null, asset: 'input.mp4', duration: 6 })
  assert.ok(r1.clip.id)
  const r2 = tools.getTool('split_clip').fn(c, { clipId: r1.clip.id, at: 2 })
  assert.equal(r2.right.duration, 4)
  const t2 = timeline.sanitize(JSON.parse(JSON.stringify(timeline.summarize(tl))))
  timeline.addClip(t2, { asset: 'z.mp4', duration: 1, timelineStart: 99, kind: 'audio' })
})

test('overlay tools add image clips to a video track by default', () => {
  const c = ctx(timeline.newTimeline({ id: 'j1', fps: 30 }))
  const text = tools.getTool('add_text_overlay').fn(c, { text: 'Hello' })
  const image = tools.getTool('add_image_overlay').fn(c, { asset: 'logo.png' })

  assert.equal(c.tl.tracks.length, 1)
  assert.equal(c.tl.tracks[0].kind, 'video')
  assert.equal(text.clip.kind, 'image')
  assert.equal(image.clip.kind, 'image')
  assert.equal(c.changed, true)
})

test('reorder_clips tool validates the id permutation', () => {
  const tl = tl3()
  timeline.addClip(tl, { asset: 'b.mp4', duration: 2, name: 'B2' }) // video track now has 2 clips
  const c = ctx(tl)
  const clips = tl.tracks[0].clips
  for (const x of clips) assert.ok(x.id, 'video track clips need ids')
  tools.getTool('reorder_clips').fn(c, { trackId: tl.tracks[0].id, order: [clips[1].id, clips[0].id] })
  assert.equal(tl.tracks[0].clips[0].name, 'B2')
})

test('normalizeOps passes tool ops through to the server', () => {
  const { normalizeOps } = require('../ai')
  const nx = normalizeOps({
    ops: [{ kind: 'tool', name: 'split_clip', args: { clipId: 'c1', at: 3 } }],
    summary: 'split',
  }, { hasAudio: true })
  assert.equal(nx.ops[0].kind, 'tool')
  assert.equal(nx.ops[0].name, 'split_clip')
  assert.deepEqual(nx.ops[0].args, { clipId: 'c1', at: 3 })
  assert.equal(nx.isLLM, true)
})

test('normalizeOps drops unknown tool names', () => {
  const { normalizeOps } = require('../ai')
  const nx = normalizeOps({
    ops: [{ kind: 'tool', name: 'trip_the_user', args: {} }],
  }, { hasAudio: true })
  assert.equal(nx, null)
})
