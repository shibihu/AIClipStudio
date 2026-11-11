// ---------------------------------------------------------------------------
// tools.js — structured editing tools the AI Agent can call.
// Each tool is a small function with a JSON-schema-lite signature; the server
// exposes them via POST /api/tool and the LLM sees the catalog as "tool" ops.
// Execution styles:
//   • timeline tools  — mutate the internal model (timeline.js), persist once
//   • analysis tools  — call the Python service (moviepy/cv/librosa/whisper)
//   • render tools    — materialize the timeline through the Python service
// Everything stays non-destructive: sources never change, the timeline model
// is metadata, renders always write new files.
// ---------------------------------------------------------------------------

const timeline = require('./timeline')

const PY_TIMEOUT_MS = Number(process.env.PY_TIMEOUT_MS) || 900000 // heavy renders

// --- tool context -------------------------------------------------------------

function T(name, group, summary, args, fn) {
  return { name, group, summary, args, fn }
}

const num = (n, dflt) => (isNaN(+n) ? dflt : +n)
const str = (s, dflt = '') => (s == null ? dflt : String(s))

// --- helpers shared by the tools ----------------------------------------------

function ensureTracks(tl) {
  if (!tl.tracks.length) {
    tl.tracks.push(timeline.newTrack('video', 'V1', 0))
  }
  return tl.tracks
}

function mainVideoTrack(tl) {
  ensureTracks(tl)
  return tl.tracks.find((t) => t.kind === 'video') || tl.tracks[0]
}

function fileRef(dir, f) {
  const s = String(f || '')
  if (/[/\\]/.test(s) && !s.startsWith('.') && !s.includes('..') && s.length > 2) return s
  return `${dir}/${s}` // relative to the job's media base for portability
}

// --- tool implementations ------------------------------------------------------

function toolAddClip(ctx, a) {
  const tl = ctx.tl
  const kind = ['video', 'audio', 'image'].includes(a.kind) ? a.kind : undefined
  const asset = fileRef(ctx.dir, a.asset || a.src || a.path || ctx.meta.versionName)
  if (!asset) throw new Error('add_clip needs an asset (a job media file)')
  const sourceStart = Math.max(0, num(a.sourceStart, 0))
  let duration = num(a.duration, null)
  if (duration == null) {
    if (kind === 'image') duration = num(a.until ?? a.endTime, 3)
    else if (asset.startsWith(ctx.dir)) {
      // unknown duration for a job file: resolve lazily inline (fast ffprobe)
      throw new Error('add_clip needs an explicit duration in seconds')
    } else throw new Error('add_clip needs an explicit duration in seconds')
  }
  if (a.endTime != null && a.startTime != null) duration = num(a.endTime, 0) - num(a.startTime, 0)
  const c = timeline.addClip(tl, {
    trackId: a.trackId,
    kind: kind || undefined,
    asset,
    name: str(a.name, 'clip'),
    timelineStart: Math.max(0, num(a.timelineStart ?? a.at, null) ?? tail(tl, a.trackId)),
    sourceStart,
    duration,
    speed: num(a.speed, 1),
    volume: num(a.volume, 1),
    transitionIn: a.transitionIn,
    fromVersion: ctx.meta.versionName || null,
    sourceDuration: duration,
  })
  ctx.changed = true
  return { clip: clipOut(c), track: a.trackId || mainVideoTrack(tl).id }
}

function tail(tl, trackId) {
  const tr = trackId ? tl.tracks.find((t) => t.id === trackId) : mainVideoTrack(tl)
  const last = tr && tr.clips[tr.clips.length - 1]
  return last ? last.timelineStart + last.duration : 0
}

function clipOut(c) {
  return { ...c, effects: c.effects && c.effects.length ? c.effects : undefined }
}

function toolRemoveClip(ctx, { clipId, trimGap = true }) {
  const tr = timeline.removeClip(ctx.tl, str(clipId), { trimGap: !!trimGap })
  ctx.changed = true
  return { removed: clipId, track: tr.id }
}

function toolSplitClip(ctx, { clipId, at }) {
  const [left, right] = timeline.splitClip(ctx.tl, str(clipId), num(at, 0))
  ctx.changed = true
  return { left: clipOut(left), right: clipOut(right) }
}

function toolTrimClip(ctx, a) {
  const c = timeline.trimClip(ctx.tl, str(a.clipId), {
    timelineStart: a.timelineStart != null && a.timelineStart !== '' ? num(a.timelineStart) : undefined,
    sourceStart: a.sourceStart != null && a.sourceStart !== '' ? num(a.sourceStart) : undefined,
    duration: a.duration != null && a.duration !== '' ? num(a.duration) : undefined,
  })
  ctx.changed = true
  return { clip: clipOut(c) }
}

function toolMoveClip(ctx, a) {
  const c = timeline.moveClip(ctx.tl, str(a.clipId), {
    timelineStart: a.timelineStart != null && a.timelineStart !== '' ? num(a.timelineStart) : undefined,
    trackId: a.trackId || undefined,
  })
  ctx.changed = true
  return { clip: clipOut(c) }
}

function toolReorderClips(ctx, { trackId, order }) {
  const tr = trackId && ctx.tl.tracks.find((t) => t.id === trackId)
    ? ctx.tl.tracks.find((t) => t.id === trackId)
    : mainVideoTrack(ctx.tl)
  if (!Array.isArray(order)) throw new Error('reorder_clips needs "order": array of clip ids (new order)')
  const want = order.map(str)
  const have = tr.clips.map((c) => c.id)
  if (new Set(want).size !== want.length || want.some((id) => !have.includes(id))) {
    if (process.env.TOOLS_DEBUG) console.error('[reorder-debug]', { want, have })
    throw new Error('order must be a permutation of the track\'s current clip ids')
  }
  want.forEach((id, i) => { timeline.reorderClip(ctx.tl, id, i) }) // re-packs and stamps
  ctx.changed = true
  return { track: tr.id, order: tr.clips.map((c) => clipOut(c)) }
}

function toolChangeSpeed(ctx, { clipId, rate, speed }) {
  const r = num(rate ?? speed, 1)
  if (!(r > 0.01 && r !== 1 && r < 100)) throw new Error('rate must be positive and not 1')
  const c = timeline.setClipProps(ctx.tl, str(clipId), { speed: r })
  ctx.changed = true
  return { clip: clipOut(c) }
}

function toolCropVideo(ctx, a) {
  const fx = { type: 'crop', x: Math.round(num(a.x, 0)), y: Math.round(num(a.y, 0)), w: Math.round(num(a.w, 0)), h: Math.round(num(a.h, 0)) }
  if (!(fx.w > 0 && fx.h > 0)) throw new Error('crop_video needs w and h (pixels)')
  return toolAddEffect(ctx, { clipId: a.clipId, effect: fx })
}

function toolResizeVideo(ctx, { clipId, width, height, scale }) {
  const s = num(scale, null) ?? (width ? num(width) / ctx.meta.width : height ? num(height) / ctx.meta.height : null)
  if (!s) throw new Error('resize_video needs width, height or scale')
  return toolAddEffect(ctx, { clipId, effect: { type: 'scale', scale: Math.round(s * 1000) / 1000 } })
}

function toolAddAudio(ctx, a) {
  const asset = fileRef(ctx.dir, a.asset || a.src)
  if (!asset) throw new Error('add_audio needs an asset (a job media file)')
  const start = Math.max(0, num(a.timelineStart ?? a.at ?? a.start, tail(ctx.tl, a.trackId)))
  const dur = a.duration != null && a.duration !== '' ? num(a.duration)
    : (a.until != null ? Math.max(0.05, num(a.until) - start)
      : Math.max(0.5, (ctx.meta.duration || 10) - start))
  const c = timeline.addClip(ctx.tl, {
    trackId: a.trackId, asset, kind: 'audio',
    name: str(a.name, 'audio'),
    timelineStart: start,
    sourceStart: Math.max(0, num(a.sourceStart, 0)),
    duration,
    volume: num(a.volume, 1),
    muted: !!a.muted,
  })
  ctx.changed = true
  return { clip: clipOut(c) }
}

function toolAdjustVolume(ctx, a) {
  if (a.clipId) {
    const c = timeline.setClipProps(ctx.tl, str(a.clipId), { volume: num(a.volume ?? a.factor, 1) })
    ctx.changed = true
    return { clip: clipOut(c) }
  }
  throw new Error('adjust_volume needs the clipId of an audio clip')
}

function toolFadeAudio(ctx, a) {
  return toolAddEffect(ctx, {
    clipId: a.clipId,
    effect: { type: 'audio_fade', wholeClip: true, fin: num(a.in, 0.5), fout: num(a.out, 0.5) },
  })
}

function toolRemoveAudio(ctx, { clipId, startPos, endPos }) {
  // removes audio clips fully inside [startPos,endPos) on the audio tracks
  let removed = 0
  for (const tr of ctx.tl.tracks.filter((t) => t.kind === 'audio')) {
    for (const c of [...tr.clips]) {
      if (c.timelineStart >= (startPos ?? -1) && c.timelineStart + c.duration <= (endPos ?? 1e12)) {
        timeline.removeClip(ctx.tl, c.id); removed++
      }
    }
  }
  ctx.changed = removed > 0
  return { removed }
}

function toolAddSoundEffect(ctx, a) {
  return toolAddAudio(ctx, { ...a, kind: 'audio', name: a.name || 'sfx' })
}

function toolAddCaption(ctx, a) {
  // prefers STT transcript when the segment comes transcribe_audio → add_caption
  const q = a.segments && a.segments.length ? a.segments : (a.text ? [{ text: str(a.text), start: num(a.start, 0), end: num(a.end, num(a.duration ?? 3, 3)) }] : null)
  if (!q) throw new Error('add_caption needs text (and start/end) or segments')
  const out = []
  for (const seg of q.slice(0, 120)) {
    ctx.tl.markers.push({ time: num(seg.start, 0), label: `[caption] ${String(seg.text).slice(0, 100)}` })
    out.push({ start: seg.start, end: seg.end, text: seg.text })
  }
  ctx.tl.rev++
  return { captions: out, note: 'captions ride on markers; render/burn-in goes through the captions pipeline' }
}

function toolAddTextOverlay(ctx, a) {
  const from = Math.max(0, num(a.from ?? a.start, 0))
  const until = num(a.until ?? a.end, from + num(a.duration ?? 3, 3))
  const c = timeline.addClip(ctx.tl, {
    trackId: a.trackId, kind: 'image', asset: `text:${str(a.text, '').slice(0, 200)}`,
    name: 'text overlay',
    timelineStart: from, duration: Math.max(0.05, until - from),
    pos: str(a.pos, 'center'), size: Math.round(num(a.size, ctx.meta.height ? Math.round(ctx.meta.height * 0.06) : 40)),
    color: str(a.color, '#FFFFFF'),
  })
  ctx.changed = true
  return { clip: clipOut(c), note: 'text renders as a PNG overlay at render time (pillow) or via the existing .ass burn-in' }
}

function toolAddImageOverlay(ctx, a) {
  const asset = fileRef(ctx.dir, a.asset || a.src)
  if (!asset) throw new Error('add_image_overlay needs an asset file in the job folder')
  const from = Math.max(0, num(a.from ?? a.start, 0))
  const until = num(a.until ?? a.end, from + num(a.duration ?? 3, 3))
  const c = timeline.addClip(ctx.tl, {
    trackId: a.trackId, kind: 'image', asset,
    name: a.name || 'image overlay',
    timelineStart: from, duration: Math.max(0.05, until - from),
    pos: [num(a.x, .5), num(a.y, .5)], scale: num(a.scale, 1),
    opacity: num(a.opacity, 1),
  })
  ctx.changed = true
  return { clip: clipOut(c) }
}

function toolAddSticker(ctx, a) {
  const asset = fileRef(ctx.dir, a.asset || a.src)
  if (!asset) throw new Error('add_sticker needs an asset PNG already in the job dir (or render one via add_lottie first)')
  return toolAddImageOverlay(ctx, { ...a, asset })
}

function toolAddLottie(ctx, a) {
  const lottie = a.lottie || a.asset
  if (!lottie) throw new Error('add_lottie needs "lottie": inline JSON or a path to a .json Lottie file')
  const outName = `lottie-${Math.random().toString(36).slice(2, 8)}.gif`
  const outPath = `${ctx.dir}/${outName}`
  ctx.py('lottie/prep', { lottie, output: outPath, fps: Math.round(num(a.fps, 24)) })
  return toolAddImageOverlay(ctx, { ...a, asset: outPath })
}

function toolAddAnimation(ctx, a) {
  const known = ['zoom_in', 'zoom_out', 'pan', 'spin', 'pulse', 'shake']
  const type = str(a.type, 'zoom_in')
  if (!known.includes(type)) throw new Error(`add_animation: type must be one of ${known.join('|')}`)
  return toolAddEffect(ctx, {
    clipId: a.clipId,
    effect: { type: 'animation', anim: type, duration: num(a.duration, 1), loop: !!a.loop },
  })
}

function toolAddTransition(ctx, { clipId, type, duration }) {
  const t = timeline.addTransition(ctx.tl, str(clipId), { type, duration: num(duration, 0.3) })
  ctx.changed = true
  return { transition: t }
}

function toolAddVideoEffect(ctx, { clipId, type, ...rest }) {
  const allowed = ['grayscale', 'sepia', 'blur', 'brightness', 'contrast', 'saturation', 'vignette', 'hue', 'noise', 'sharpen', 'mirror', 'flip', 'rotate', 'color']
  if (!allowed.includes(type)) throw new Error(`add_video_effect: type must be one of ${allowed.join('|')}`)
  const fx = { type, amount: num(rest.amount, 1) }
  return toolAddEffect(ctx, { clipId, effect: fx })
}

function toolAddEffect(ctx, { clipId, effect }) {
  const c = timeline.addEffect(ctx.tl, str(clipId), effect)
  ctx.changed = true
  return { clip: clipOut(c) }
}

function toolAdjustPosition(ctx, { clipId, x, y }) {
  for (const tr of ctx.tl.tracks) {
    const c = tr.clips.find((c) => c.id === clipId)
    if (!c) continue
    c.pos = [num(x, (c.pos && c.pos[0]) ?? 0.5), num(y, (c.pos && c.pos[1]) ?? 0.5)]
    ctx.changed = true
    return { clip: clipOut(c) }
  }
  throw new Error(`no such clip: ${clipId}`)
}

function toolAdjustScale(ctx, { clipId, scale }) {
  const s = num(scale, null)
  if (!(s > 0 && s <= 10)) throw new Error('adjust_scale needs scale within (0,10]')
  for (const tr of ctx.tl.tracks) {
    const c = tr.clips.find((c) => c.id === clipId)
    if (!c) continue
    c.scale = Math.round(s * 1000) / 1000
    ctx.changed = true
    return { clip: clipOut(c) }
  }
  throw new Error(`no such clip: ${clipId}`)
}

function toolAdjustOpacity(ctx, { clipId, opacity }) {
  const o = num(opacity, null)
  if (o == null || o < 0 || o > 1) throw new Error('adjust_opacity needs opacity within 0..1')
  for (const tr of ctx.tl.tracks) {
    const c = tr.clips.find((c) => c.id === clipId)
    if (!c) continue
    c.opacity = Math.round(o * 1000) / 1000
    ctx.changed = true
    return { clip: clipOut(c) }
  }
  throw new Error(`no such clip: ${clipId}`)
}

// --- analysis tools ------------------------------------------------------------

function toolDetectBeats(ctx, { asset, src, offset }) {
  const file = fileRef(ctx.dir, asset || src) || ctx.meta.versionName
  const res = ctx.py('audio/analyze', { input: file })
  const beats = res.beats && res.beats.length ? res.beats : []
  const base = num(offset ?? beats[0], 0)
  if (beats.length) {
    for (let i = 0; i < beats.length; i += 1) {
      if (ctx.tl.markers.length > 800) break
      ctx.tl.markers.push({ time: beats[i], label: '[beat]' })
    }
    ctx.changed = true
  }
  return { tempo: res.tempo, beat_count: beats.length, beats: beats.slice(0, 240), offset: base }
}

function toolSynchronizeAudio(ctx, { trackId, toTime = 0 }) {
  const audioTracks = trackId
    ? [ctx.tl.tracks.find((t) => t.id === trackId)].filter(Boolean)
    : ctx.tl.tracks.filter((t) => t.kind === 'audio')
  if (!ctx.tl.markers.length) throw new Error('synchronize_audio needs a beat grid: run detect_beats first')
  const anchor = ctx.tl.markers.map((m) => (m.label || '').startsWith('[beat')
    ? m.time : -1).filter((t) => t >= 0)[0]
  if (anchor == null) throw new Error('synchronize_audio needs a beat grid: run detect_beats first')
  const moved = []
  for (const tr of audioTracks) {
    for (const c of tr.clips) {
      const firstBeat = ctx.tl.markers.map((m) => m.time).find((t) => t >= (toTime ?? 0)) ?? toTime ?? 0
      const old = c.timelineStart
      c.timelineStart = Math.max(0, timeline.round6(firstBeat))
      moved.push({ clip: c.id, from: old, to: c.timelineStart, track: tr.id })
    }
  }
  if (moved.length) ctx.changed = true
  else throw new Error('no audio clips on the audio track(s) to synchronize')
  return { anchor, moved }
}

function toolTranscribeAudio(ctx, { asset, src, model = 'base', language = null, job: keep }) {
  const file = fileRef(ctx.dir, asset || src || ctx.meta.versionName)
  const res = ctx.py('stt/start', { input: file, model, language })
  return { stt_job: res.job, note: 'poll GET /api/py/stt/status?job=<id> for the transcript' }
}

function toolDetectScenes(ctx, { asset, src, threshold, offset }) {
  const file = fileRef(ctx.dir, asset || src || ctx.meta.versionName)
  const res = ctx.py('cv/scenes', { input: file, threshold })
  const out = {
    scenes: res.scenes.map((s) => ({ time: s.time, score: s.score })),
    count: res.count,
  }
  if (res.scenes.length) {
    for (const s of res.scenes) {
      if (ctx.tl.markers.length > 800) break
      ctx.tl.markers.push({ time: s.time, label: `[scene] score=${s.score}` })
    }
    ctx.changed = true
  }
  return out
}

function toolAnalyzeVideo(ctx, { asset, src }) {
  const file = fileRef(ctx.dir, asset || src || ctx.meta.versionName)
  const res = ctx.py('cv/analyze', { input: file })
  return { width: res.width, height: res.height, fps: res.fps, avg_motion: res.avg_motion, avg_brightness: res.avg_brightness, samples: res.samples }
}

function toolAnalyzeAudio(ctx, a) {
  return toolDetectBeats(ctx, a)
}

function toolExtractFrames(ctx, { asset, src, count = 8, outputDir }) {
  const file = fileRef(ctx.dir, asset || src || ctx.meta.versionName)
  const outDir = `${ctx.dir}/${outputDir || `frames-${Math.random().toString(36).slice(2, 7)}`}`
  // python writes inside the job dir; paths come back absolute — keep jail
  if (!outDir.startsWith(ctx.dir)) throw new Error('outputDir must be relative to the job')
  return ctx.py('cv/frames', { input: file, count, outDir, prefix: 'f' })
}

// --- caption replacement (CaptionRemovalEngine, py/caption_ops.py) ------------

function mainVideoClip(ctx) {
  const tr = mainVideoTrack(ctx.tl)
  return tr.clips && tr.clips[tr.clips.length - 1]
}

function toolDetectExistingCaptions(ctx, a) {
  const file = fileRef(ctx.dir, a.asset || a.src || ctx.meta.versionName)
  const res = ctx.py('captions/detect', {
    input: file,
    useOcr: a.useOcr !== false,
    ...(a.manual ? { manual: a.manual } : {}),
  }, 600000)
  return {
    regions: (res.regions || []).map((r) => ({
      start: r.start, end: r.end, x: r.x, y: r.y, width: r.width, height: r.height,
      confidence: r.confidence, samples: r.samples,
    })),
    count: res.count,
    width: res.width, height: res.height,
    band: res.band,
    ocr: res.ocr,
    note: 'regions are pixel coords in the source resolution; xN/yN/wN/hN are the same boxes normalized 0..1',
  }
}

function toolRemoveCaptionRegions(ctx, a) {
  // detection is mandatory: never blur the whole frame as a silent fallback
  const regions = Array.isArray(a.regions) && a.regions.length ? a.regions : []
  if (!regions.length) {
    throw new Error('remove_caption_regions needs regions from detect_existing_captions ' +
      '(or explicit regions:[]) — never runs a blind full-frame fallback')
  }
  const method = ['blur', 'gaussian', 'solid', 'inpaint'].includes(a.method) ? (a.method === 'gaussian' ? 'blur' : a.method) : 'blur'
  const clampRegion = (r) => ({
    start: Math.max(0, +r.start || 0), end: Math.max(0.1, +r.end || 0.1),
    x: Math.max(0, Math.round(+r.x || 0)), y: Math.max(0, Math.round(+r.y || 0)),
    width: Math.max(4, Math.round(+r.width || 4)), height: Math.max(4, Math.round(+r.height || 4)),
    confidence: +r.confidence || 0.75,
  })
  const eff = { type: 'caption_remove', method, radius: Math.max(2, Math.min(40, Math.round(+a.radius || 14))), regions: regions.map(clampRegion), lowConfFailsafe: a.lowConfFailsafe !== false }
  return toolAddEffect(ctx, { clipId: a.clipId || (mainVideoClip(ctx) || {}).id, effect: eff })
}

function toolReplaceExistingSubtitles(ctx, a) {
  // full pipeline: detect → (optional transcript) → translate → region remove
  // → Thai ASS burn → audio copy. Server expands the effect at render/chat.
  const language = String(a.language || 'th').slice(0, 2).toLowerCase()
  const method = ['blur', 'gaussian', 'solid', 'inpaint'].includes(a.method) ? a.method : 'blur'
  const eff = {
    type: 'caption_replace', language, method,
    radius: Math.max(2, Math.min(40, Math.round(+a.radius || 14))),
    manual: a.manual && typeof a.manual === 'object' ? a.manual : null,
  }
  return toolAddEffect(ctx, { clipId: a.clipId || (mainVideoClip(ctx) || {}).id, effect: eff })
}

function toolGenerateTranslatedSubtitles(ctx, a) {
  // records the translation intent + language; the server chat pipeline does
  // the LLM translation and builds the timed .ass (timing comes from STT)
  const language = String(a.language || 'th').slice(0, 2).toLowerCase()
  const eff = { type: 'translated_subtitles', language, source: a.source || 'stt' }
  return toolAddEffect(ctx, { clipId: a.clipId || (mainVideoClip(ctx) || {}).id, effect: eff })
}

function toolValidateCaptionReplacement(ctx, a) {
  const before = fileRef(ctx.dir, a.before || ctx.meta.versionName)
  const after = fileRef(ctx.dir, a.after)
  if (!after) throw new Error('validate_caption_replacement needs "after" (the rendered output name)')
  const res = ctx.py('captions/validate', { before, after, regions: a.regions || [] }, 300000)
  return {
    ok: res.ok, checks: res.checks, inside_avg: res.inside_avg,
    outside_avg: res.outside_avg, samples: res.samples,
    note: 'regions_changed=false → removal did not land; outside_unchanged=false → frame damaged elsewhere',
  }
}

// --- render ---------------------------------------------------------------------

function toolRenderTimeline(ctx, { wait = true } = {}) {
  const outName = `timeline-${ctx.tl.rev || Date.now()}.mp4`
  const outPath = `${ctx.dir}/${outName}`
  ctx.py('video/render_timeline', {
    timeline: timeline.summarize(ctx.tl),
    output: outPath,
    dir: ctx.dir.replace(/\\/g, '/'),
  })
  return { rendered: outPath, name: outName, note: 'the rendered file registers itself as a new version automatically' }
}

// --- preview (Remotion timeline JSON round trip) -------------------------------

function toolExportTimeline(ctx, { path: rel } = {}) {
  const out = rel ? `${ctx.dir}/${rel}` : `${ctx.dir}/timeline.otio`
  const res = ctx.py('timeline/to_otio', { timeline: timeline.sanitize(ctx.tl) })
  return { otio: res.otio, suggestedPath: out }
}

function toolImportTimeline(ctx, { otio }) {
  const res = ctx.py('timeline/from_otio', { otio })
  ctx.tl = timeline.sanitize(res.timeline)
  ctx.changed = true
  return { summary: timeline.summarize(ctx.tl) }
}

// --- catalog ----------------------------------------------------------------------

const CATALOG = [
  T('add_clip', 'video', 'add a clip (or image/audio) on a track at a time position',
    { trackId: 'str?', asset: 'str?', kind: 'video|audio|image', timelineStart: 'sec?', sourceStart: 'sec?', duration: 'sec', speed: '>0', volume: '0..4' }, toolAddClip),
  T('remove_clip', 'video', 'remove a clip from every timeline track',
    { clipId: 'str' }, toolRemoveClip),
  T('split_clip', 'video', 'split one clip at a timeline time', { clipId: 'str', at: 'sec' }, toolSplitClip),
  T('trim_clip', 'video', 'trim a clip: move it, change its source window and/or length',
    { clipId: 'str', timelineStart: 'sec?', sourceStart: 'sec?', duration: 'sec?' }, toolTrimClip),
  T('move_clip', 'video', 'move a clip in time and/or to another track', { clipId: 'str', timelineStart: 'sec?', trackId: 'str?' }, toolMoveClip),
  T('reorder_clips', 'video', 'reorder a track: pass the full clip id order', { trackId: 'str?', order: 'str[]' }, toolReorderClips),
  T('change_playback_speed', 'video', 're-time a clip (speeds up or slows both video and audio)',
    { clipId: 'str', rate: '>0,≠1' }, toolChangeSpeed),
  T('crop_video', 'video', 'non-destructive pixel crop on a clip', { clipId: 'str', x: 'int', y: 'int', w: 'int', h: 'int' }, toolCropVideo),
  T('resize_video', 'video', 'near-destructive scale effect on a clip', { clipId: 'str', width: 'px?', height: 'px?', scale: '>0?' }, toolResizeVideo),
  T('render_timeline', 'video', 'render the current timeline to a new MP4 version (heavy)',
    { wait: 'bool?' }, toolRenderTimeline),

  T('add_audio', 'audio', 'add an audio asset on an audio track at a time position',
    { asset: 'str', trackId: 'str?', timelineStart: 'sec?', sourceStart: 'sec?', duration: 'sec?', volume: '0..4', muted: 'bool?' }, toolAddAudio),
  T('add_sound_effect', 'audio', 'add a short sound effect asset like add_audio', { asset: 'str', timelineStart: 'sec?', duration: 'sec?', volume: '0..4' }, toolAddSoundEffect),
  T('adjust_volume', 'audio', 'set volume factor on an audio clip', { clipId: 'str', volume: '0..4' }, toolAdjustVolume),
  T('fade_audio', 'audio', 'fade in/out an audio clip', { clipId: 'str', in: 'sec?', out: 'sec?' }, toolFadeAudio),
  T('remove_audio', 'audio', 'remove audio clips inside a time window', { startPos: 'sec?', endPos: 'sec?' }, toolRemoveAudio),
  T('detect_beats', 'audio', 'librosa beat/tempo analysis; markers land on the timeline', { asset: 'str?' }, toolDetectBeats),
  T('synchronize_audio', 'audio', 'snap audio clips onto the beat grid / video start', { trackId: 'str?', toTime: 'sec?' }, toolSynchronizeAudio),

  T('add_caption', 'visual', 'add caption cue(s) on markers at a time', { text: 'str?', start: 'sec?', end: 'sec?', segments: 'list?' }, toolAddCaption),
  T('add_text_overlay', 'visual', 'add a text overlay PNG clip over time', { text: 'str', from: 'sec?', until: 'sec?', pos: 'top|center|bottom', size: 'px?', color: '#hex' }, toolAddTextOverlay),
  T('add_image_overlay', 'visual', 'add an image/PNG overlay clip', { asset: 'str', from: 'sec?', until: 'sec?', x: '0..1?', y: '0..1?', scale: '>0?', opacity: '0..1?' }, toolAddImageOverlay),
  T('add_sticker', 'visual', 'add a sticker (Pillow-processed PNG) as an overlay', { asset: 'str' }, toolAddSticker),
  T('add_lottie', 'visual', 'rasterize a Lottie JSON to a GIF sticker and overlay it', { lottie: 'json|path', from: 'sec?', until: 'sec?', fps: 'int?' }, toolAddLottie),
  T('add_animation', 'visual', 'attach an animation effect to a clip', { clipId: 'str', type: 'zoom_in|zoom_out|pan|spin|pulse|shake', duration: 'sec?' }, toolAddAnimation),
  T('add_transition', 'visual', 'attach a transition to the clip start', { clipId: 'str', type: 'cut|dip_to_color|cross_dissolve|slide|wipe', duration: 'sec?' }, toolAddTransition),
  T('add_video_effect', 'visual', 'attach a visual effect to a clip', { clipId: 'str', type: 'grayscale|sepia|blur|...', amount: '>0?' }, toolAddVideoEffect),
  T('adjust_position', 'visual', 'move an overlay clip', { clipId: 'str', x: '0..1', y: '0..1' }, toolAdjustPosition),
  T('adjust_scale', 'visual', 'resize an overlay clip', { clipId: 'str', scale: '>0,≤10' }, toolAdjustScale),
  T('adjust_opacity', 'visual', 'change overlay/transparency', { clipId: 'str', opacity: '0..1' }, toolAdjustOpacity),

  T('transcribe_audio', 'analysis', 'faster-whisper STT: returns a job handle, results via /api/py/stt',
    { asset: 'str?', model: 'tiny|base|small', language: 'ISO code?' }, toolTranscribeAudio),
  T('detect_scenes', 'analysis', 'OpenCV scene-cut detection; markers land on the timeline', { asset: 'str?', threshold: '0.05..0.95?' }, toolDetectScenes),
  T('analyze_video', 'analysis', 'OpenCV whole-video stats (motion/brightness/size)', { asset: 'str?' }, toolAnalyzeVideo),
  T('extract_frames', 'analysis', 'OpenCV evenly-spaced frame extraction into the job dir',
    { asset: 'str?', count: '1..240', outputDir: 'str?' }, toolExtractFrames),
  T('analyze_audio', 'analysis', 'librosa audio stats (tempo/beats/RMS)', { asset: 'str?' }, toolAnalyzeAudio),

  T('export_timeline', 'timeline', 'serialize the timeline as OpenTimelineIO JSON', { path: 'str?' }, toolExportTimeline),
  T('import_timeline', 'timeline', 'load an OTIO JSON string into the internal timeline', { otio: 'str|obj' }, toolImportTimeline),

  T('detect_existing_captions', 'captions', 'CaptionRemovalEngine: find burned-in subtitle boxes (OpenCV + optional OCR refine); returns regions {start,end,x,y,width,height,confidence}',
    { asset: 'str?', useOcr: 'bool?', manual: '{x:int,y:int,w:int,h:int}?' }, toolDetectExistingCaptions),
  T('remove_caption_regions', 'captions', 'remove ONLY the detected caption regions (blur/gaussian/solid/inpaint); never a full-frame fallback — regions come from detect_existing_captions',
    { regions: 'list', method: 'blur|gaussian|solid|inpaint?', radius: 'int?', clipId: 'str?' }, toolRemoveCaptionRegions),
  T('generate_translated_subtitles', 'captions', 'translate the spoken transcript (stt) into subtitles; timing follows the original voiceover',
    { language: 'ISO code (th default)', source: 'stt?', clipId: 'str?' }, toolGenerateTranslatedSubtitles),
  T('replace_existing_subtitles', 'captions', 'full pipeline: remove existing burned-in captions AND burn translated subtitles timed to the original speech; original audio copied untouched',
    { language: 'ISO code (th default)', method: 'blur|gaussian|solid|inpaint?', radius: 'int?', manual: '{x,y,w,h}?', clipId: 'str?' }, toolReplaceExistingSubtitles),
  T('validate_caption_replacement', 'captions', 'verify the render: caption regions changed, rest of frame intact, audio still present',
    { after: 'str (output file name)', before: 'str?', regions: 'list?' }, toolValidateCaptionReplacement),
]

const NAMES = new Map(CATALOG.map((t) => [t.name, t]))

function getTool(name) {
  return NAMES.get(String(name || ''))
}

// LLM-facing catalog description (compact lines, one tool each)
function catalogHint() {
  return CATALOG.map((t) => `${t.name}(${t.args}) — ${t.summary}`).join('\n')
}

module.exports = { CATALOG, NAMES, getTool, catalogHint }
