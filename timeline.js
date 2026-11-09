// ---------------------------------------------------------------------------
// timeline.js — internal multi-track timeline model for AIClipStudio.
// Holds tracks/clips/transitions/markers per job, persisted in job.json
// (non-destructive: clips only ever reference source files + trim windows).
// Conversions to/from OpenTimelineIO go through the Python service
// (py/otio_bridge.py) — see docs/INTEGRATION.md for the mapping rules.
// Pure data module: no fs/network here, fully unit-testable (test/engine.test.js).
// ---------------------------------------------------------------------------

const SCHEMA = 2

function newTimeline({ id, fps = 30, width = null, height = null, name = 'main' } = {}) {
  return {
    schema: SCHEMA,
    id,
    name,
    fps,
    width,
    height,
    tracks: [],
    markers: [],
    metadata: {},
    rev: 0, // bumped on every mutation — cheap cache bust for OTIO/renders
  }
}

function newTrack(kind, name, i) {
  if (kind !== 'video' && kind !== 'audio') throw new Error('track kind must be video|audio')
  return {
    id: `t${i}-${kind[0]}${Math.random().toString(36).slice(2, 6)}`,
    kind, name: name || `${kind === 'video' ? 'V' : 'A'}${i}`,
    locked: false,
    clips: [],
  }
}

function mkClip(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('clip spec required')
  const assetStr = String(spec.asset || '')
  const isTextOverlay = spec.kind === 'image' && assetStr.startsWith('text:') && assetStr.length <= 205
  if (!isTextOverlay && (!/^[\w./\\-]+$/.test(assetStr) || assetStr.includes('..'))) throw new Error('clip asset path required')
  const dur = +spec.duration
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('clip duration must be > 0')
  const c = {
    id: spec.id || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    asset: String(spec.asset),
    name: String(spec.name || 'clip'),
    kind: ['video', 'audio', 'image'].includes(spec.kind) ? spec.kind : 'video',
    timelineStart: round6(spec.timelineStart ?? 0), // position on the timeline
    sourceStart: Math.max(0, round6(spec.sourceStart ?? 0)), // cut start INSIDE the source
    duration: round6(dur), // timeline duration (already speed-adjusted)
    sourceDuration: spec.sourceDuration != null ? round6(spec.sourceDuration) : round6(dur),
    naturalDuration: spec.naturalDuration != null ? round6(spec.naturalDuration) : round6(dur),
    speed: clampSpeed(spec.speed ?? 1),
    fromVersion: spec.fromVersion || null,
    volume: clamp01(spec.volume ?? 1),
    muted: !!spec.muted,
  }
  if (spec.transitionIn) c.transitionIn = normalizeTransition(spec.transitionIn)
  if (spec.effects && Array.isArray(spec.effects)) c.effects = spec.effects.filter(cleanEffect)
  // overlay geometry (image/text/sticker clips)
  if (spec.pos && Array.isArray(spec.pos)) {
    c.pos = [round6(Math.max(-2, Math.min(2, +spec.pos[0] || 0))),
             round6(Math.max(-2, Math.min(2, +spec.pos[1] || 0)))]
  }
  const scaleOk = +spec.scale
  if (Number.isFinite(scaleOk) && scaleOk > 0 && scaleOk <= 10) c.scale = round6(scaleOk)
  const opOk = +spec.opacity
  if (Number.isFinite(opOk) && opOk >= 0 && opOk <= 1) c.opacity = round6(opOk)
  if (spec.color && /^#\w{3,8}$/.test(String(spec.color))) c.color = String(spec.color)
  const sizeOk = Math.round(+spec.size)
  if (Number.isFinite(sizeOk) && sizeOk >= 8 && sizeOk <= 400) c.size = sizeOk
  if (typeof spec.text === 'string' && spec.text) c.text = spec.text.slice(0, 200)
  return c
}

function clampSpeed(v) {
  const x = Math.round((+v || 1) * 1e6) / 1e6
  return Math.max(0.1, Math.min(8, x))
}

function clamp01(v) {
  const x = Math.round((+v || 1) * 1e6) / 1e6
  return Math.max(0, Math.min(4, x))
}

function normalizeTransition(t) {
  if (t && typeof t === 'object' && !/^\{|\[/.test(typeof t === 'string' ? t : '')) {
    // ok — object payload expected
  } else if (typeof t === 'string') {
    try { t = JSON.parse(t) } catch { throw new Error('bad transition') }
  }
  if (!t || typeof t !== 'object') throw new Error('bad transition')
  const allowed = ['cut', 'dip_to_color', 'cross_dissolve', 'slide', 'wipe']
  const type = t.type || 'cut'
  if (!allowed.includes(type)) throw new Error(`bad transition type: ${type}`)
  const duration = Math.max(0.05, Math.min(6, Math.round((+t.duration || 0.3) * 1e3) / 1e3))
  return { type, duration }
}

function cleanEffect(e) {
  // effects are arbitrary blobs — cap them so a hostile payload can't explode job.json
  if (!e || typeof e !== 'object') return null
  const kept = {}
  let n = 0
  for (const [k, v] of Object.entries(e)) {
    if (n >= 8) break
    if (!/^[\w-]{1,24}$/.test(k)) continue
    kept[k] = typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v).slice(0, 400)) : typeof v === 'number' ? Math.min(1e6, Math.max(-1e6, v)) : String(v).slice(0, 120)
    n++
  }
  return Object.keys(kept).length ? kept : null
}

function round6(x) {
  return Math.round((+x + 0) * 1e6) / 1e6 // stable across languages (see py/otio_bridge.py)
}

// --- track lookup --------------------------------------------------------

function trackOf(tl, tid) {
  const tr = (tl.tracks || []).find((t) => t.id === tid)
  if (!tr) throw new Error(`no such track: ${tid}`)
  return tr
}

function clipOf(tr, cid) {
  const c = tr.clips.find((c) => c.id === cid)
  if (!c) throw new Error(`no such clip: ${cid} on ${tr.id}`)
  return c
}

function sanitizeAndSort(tr) {
  // enforce: sort order, no overlaps (pull back forward-overlapping), min 0.05 gap handling
  tr.clips.sort((a, b) => a.timelineStart - b.timelineStart)
  for (let i = 1; i < tr.clips.length; i++) {
    const prevEnd = tr.clips[i - 1].timelineStart + tr.clips[i - 1].duration
    if (tr.clips[i].timelineStart < prevEnd - 1e-6) {
      tr.clips[i].timelineStart = round6(prevEnd)
    }
  }
}

// --- operations (each takes & returns the mutated timeline; throws on bad ids)
// All operations are non-destructive: sources are untouched, only metadata moves.

function addClip(tl, { trackId, kind, asset, ...rest }, atIdx) {
  if (!trackId) {
    // auto-create or append to the default track of the right kind
    const kindWant = kind === 'audio' ? 'audio' : 'video'
    let tr = tl.tracks.find((t) => t.kind === kindWant)
    if (!tr) {
      tr = newTrack(kindWant, null, tl.tracks.length)
      tl.tracks.push(tr)
    }
    trackId = tr.id
  }
  const tr = trackOf(tl, trackId)
  if (tr.locked) throw new Error(`track ${trackId} is locked`)
  const c = mkClip({ kind: kind || tr.kind, asset, ...rest })
  if (atIdx === undefined || atIdx === null) {
    // append at end of the track (tail-chasing: after the last clip)
    const last = tr.clips[tr.clips.length - 1]
    c.timelineStart = round6(last ? last.timelineStart + last.duration : 0)
    tr.clips.push(c)
  } else {
    const i = Math.max(0, Math.min(atIdx, tr.clips.length))
    const before = tr.clips[i - 1]
    c.timelineStart = round6(before ? before.timelineStart + before.duration : 0)
    tr.clips.splice(i, 0, c)
    // push all after out of the overlap cost of the new clip
    for (let k = i + 1; k < tr.clips.length; k++) {
      const prev = tr.clips[k - 1]
      if (tr.clips[k].timelineStart < prev.timelineStart + prev.duration) {
        tr.clips[k].timelineStart = round6(prev.timelineStart + prev.duration)
      }
    }
  }
  tl.rev++
  return c
}

function removeClip(tl, clipId, { trimGap = false } = {}) {
  for (const tr of tl.tracks) {
    const i = tr.clips.findIndex((c) => c.id === clipId)
    if (i === -1) continue
    tr.clips.splice(i, 1)
    if (trimGap) closeGapAfter(tr, i)
    tl.rev++
    return tr
  }
  throw new Error(`no such clip: ${clipId}`)
}

function closeGapAfter(tr, i) {
  // shift everything after slot i left to close the gap
  let cursor = tr.clips[i - 1]
    ? round6(tr.clips[i - 1].timelineStart + tr.clips[i - 1].duration) : 0
  for (let k = i; k < tr.clips.length; k++) {
    tr.clips[k].timelineStart = cursor
    cursor = round6(cursor + tr.clips[k].duration)
  }
}

function splitClip(tl, clipId, atTimelineSec) {
  const at = round6(atTimelineSec)
  for (const tr of tl.tracks) {
    const c = tr.clips.find((c) => c.id === clipId)
    if (!c) continue
    const rel = at - c.timelineStart
    if (rel < 0.05 || rel > c.duration - 0.05) {
      throw new Error(`split point must fall inside the clip (have ${rel.toFixed(3)}s inside ${c.duration}s)`)
    }
    const right = mkClip({ ...c, timelineStart: at, duration: round6(c.duration - rel), sourceStart: round6(c.sourceStart + rel * (c.speed || 1)) })
    right.id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    c.duration = rel
    if (c.effects && (c.effects[0] || {}).wholeClip !== true) {
      right.effects = c.effects
      c.effects = []
    }
    if (c.transitionIn && rel >= c.transitionIn.duration) {
      right.transitionIn = c.transitionIn
      delete c.transitionIn
    }
    const i = tr.clips.indexOf(c)
    tr.clips.splice(i + 1, 0, right)
    sanitizeAndSort(tr)
    tl.rev++
    return [c, right]
  }
  throw new Error(`no such clip: ${clipId}`)
}

function trimClip(tl, clipId, { timelineStart, sourceStart, duration }) {
  for (const tr of tl.tracks) {
    const c = tr.clips.find((c) => c.id === clipId)
    if (!c) continue
    if (tr.locked) throw new Error(`track ${tr.id} is locked`)
    let newDur = duration != null ? round6(duration) : c.duration
    newDur = Math.max(0.05, newDur)
    if (sourceStart != null) {
      c.sourceStart = Math.max(0, round6(sourceStart))
    }
    if (timelineStart != null) c.timelineStart = Math.max(0, round6(timelineStart))
    if (c.sourceStart + newDur * (c.speed || 1) > (c.sourceDuration ?? 1e6) + 1e-3) {
      throw new Error(`trim exceeds the source: ${c.sourceStart}s + ${newDur}s > ${(c.sourceDuration ?? '?')}s inside the source`)
    }
    c.duration = newDur
    sanitizeAndSort(tr)
    tl.rev++
    return c
  }
  throw new Error(`no such clip: ${clipId}`)
}

function moveClip(tl, clipId, { timelineStart, trackId } = {}) {
  for (const tr of tl.tracks) {
    const i = tr.clips.findIndex((c) => c.id === clipId)
    if (i === -1) continue
    const c = tr.clips[i]
    if (trackId && trackId !== tr.id) {
      const target = trackOf(tl, trackId)
      if (target.kind !== tr.kind) throw new Error(`cannot move a ${tr.kind} clip onto a ${target.kind} track`)
      if (target.locked) throw new Error(`track ${trackId} is locked`)
      tr.clips.splice(i, 1)
      target.clips.push(c)
    }
    if (timelineStart != null) c.timelineStart = Math.max(0, round6(timelineStart))
    sanitizeAndSort(tr)
    if (trackId && trackId !== tr.id) sanitizeAndSort(trackOf(tl, trackId))
    tl.rev++
    return c
  }
  throw new Error(`no such clip: ${clipId}`)
}

function reorderClip(tl, clipId, toIdx) {
  for (const tr of tl.tracks) {
    const i = tr.clips.findIndex((c) => c.id === clipId)
    if (i === -1) continue
    if (i === toIdx) return tr.clips[i]
    const [c] = tr.clips.splice(i, 1)
    const target = Math.max(0, Math.min(toIdx, tr.clips.length))
    tr.clips.splice(target, 0, c)
    // re-pack: sequential placement keeps timestamps consistent
    let cursor = 0
    for (const k of tr.clips) {
      k.timelineStart = cursor
      cursor = round6(cursor + k.duration)
    }
    tl.rev++
    return c
  }
  throw new Error(`no such clip: ${clipId}`)
}

function addTransition(tl, clipId, transition) {
  const t = normalizeTransition(transition)
  for (const tr of tl.tracks) {
    const c = tr.clips.find((c) => c.id === clipId)
    if (!c) continue
    c.transitionIn = t
    tl.rev++
    return t
  }
  throw new Error(`no such clip: ${clipId}`)
}

function addMarker(tl, { time, label }) {
  tl.markers.push({ time: round6(time || 0), label: String(label || '').slice(0, 120) })
  tl.markers.sort((a, b) => a.time - b.time)
  tl.rev++
  return tl.markers[tl.markers.length - 1]
}

function setClipProps(tl, clipId, { volume, muted, speed } = {}) {
  for (const tr of tl.tracks) {
    const c = tr.clips.find((c) => c.id === clipId)
    if (!c) continue
    if (volume != null) c.volume = clamp01(volume)
    if (muted != null) c.muted = !!muted
    if (speed != null) {
      const ns = clampSpeed(speed)
      if (ns !== c.speed) {
        // re-scale duration; the source window stays the same
        // (timeline length shrinks as playback speeds up)
        const ratio = (c.speed || 1) / ns
        c.duration = round6(c.duration * ratio)
        c.speed = ns
        if ((c.sourceStart || 0) + c.duration * ns > (c.sourceDuration ?? ((c.sourceStart || 0) + c.duration * ns)) + 1e-3 && (c.sourceDuration ?? null) !== null) {
          throw new Error(`speed ${ns}× exceeds the source length of the clip`)
        }
      }
    }
    sanitizeAndSort(tr)
    tl.rev++
    return c
  }
  throw new Error(`no such clip: ${clipId}`)
}

function addEffect(tl, clipId, effect) {
  for (const tr of tl.tracks) {
    const c = tr.clips.find((c) => c.id === clipId)
    if (!c) continue
    const clean = cleanEffect(effect)
    if (!clean) throw new Error('invalid effect payload')
    if (!Array.isArray(c.effects)) c.effects = []
    if (c.effects.length >= 16) throw new Error('too many effects on one clip')
    c.effects.push(clean)
    tl.rev++
    return c
  }
  throw new Error(`no such clip: ${clipId}`)
}

function timelineDuration(tl) {
  let dur = 0
  for (const tr of tl.tracks) {
    for (const c of tr.clips) {
      dur = Math.max(dur, round6(c.timelineStart + c.duration))
    }
  }
  return dur
}

// --- (de)serialization -----------------------------------------------------

function sanitize(tl) {
  // Safe to feed any parsed JSON: coerce to the canonical internal model.
  if (!tl || typeof tl !== 'object') throw new Error('bad timeline payload')
  const out = newTimeline({ fps: tl.fps, width: tl.width, height: tl.height, name: tl.name })
  out.id = tl.id || out.id
  out.rev = +(tl.rev || 0)
  out.markers = Array.isArray(tl.markers) ? tl.markers.slice(0, 200).map((m) => ({ time: round6(m.time || 0), label: String(m.label || '').slice(0, 120) })) : []
  out.metadata = tl.metadata && typeof tl.metadata === 'object' ? JSON.parse(JSON.stringify(tl.metadata)) : {}
  let i = 0
  for (const tr of tl.tracks || []) {
    if (!tr || typeof tr !== 'object' || (tr.kind && tr.kind !== 'video' && tr.kind !== 'audio')) continue
    const t = newTrack(tr.kind === 'audio' ? 'audio' : 'video', tr.name, ++i)
    t.id = /^[A-Za-z0-9-]{1,40}$/.test(String(tr.id || '')) ? tr.id : t.id
    t.locked = !!tr.locked
    for (const c of (Array.isArray(tr.clips) ? tr.clips : []).slice(0, 500)) {
      try { t.clips.push(mkClip(c)) } catch { /* bad clip: skip, keep the rest usable */ }
    }
    sanitizeAndSort(t)
    out.tracks.push(t)
  }
  return out
}

function summarize(tl) {
  return {
    schema: tl.schema, id: tl.id, name: tl.name, fps: tl.fps,
    width: tl.width, height: tl.height, rev: tl.rev,
    duration: timelineDuration(tl),
    tracks: tl.tracks.map((t) => ({
      id: t.id, kind: t.kind, name: t.name, locked: t.locked,
      clips: t.clips.map((c) => ({
        id: c.id, name: c.name, kind: c.kind, asset: c.asset,
        timelineStart: c.timelineStart, sourceStart: c.sourceStart,
        duration: c.duration, speed: c.speed, volume: c.volume,
        muted: c.muted, transitionIn: c.transitionIn || null,
        pos: c.pos, scale: c.scale, opacity: c.opacity,
        color: c.color, size: c.size, text: c.text,
        effects: c.effects && c.effects.length ? c.effects : undefined,
      })),
    })),
    markers: tl.markers,
    metadata: tl.metadata,
  }
}

module.exports = {
  newTimeline, newTrack, mkClip, sanitize, summarize, sanitizeAndSort,
  addClip, removeClip, splitClip, trimClip, moveClip, reorderClip,
  addTransition, addMarker, setClipProps, addEffect, timelineDuration,
  round6,
}
