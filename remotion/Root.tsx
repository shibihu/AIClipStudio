// remotion/Root.tsx — timeline composition renderer (Remotion).
// Input props (JSON, via `--props` on `remotion render`):
//   { timeline: <timeline.summarize() JSON>, dir: <job dir abs path> }
// Mapping rules (shared with py/otio_bridge.py — see docs/INTEGRATION.md):
//   • video clips → OffthreadVideo (file:// source), startFrom = sourceStart
//   • image/overlay clips (stickers, text PNGs, GIFs) → Img with fractional
//     pos/scale/opacity
//   • text overlays (asset "text:<content>") → styled inline HTML
//   • transitionIn: dip_to_color/cross_dissolve → fade-in for its duration
//   • effects → CSS filter equivalents; rotate via transform
//   • animation effect → eased keyframes (zoom/pan/spin/pulse/shake)
//   • audio tracks → <Audio> with volume faders incl. fade in/out effects
// Every timestamp maps exactly: timelineStart * fps = start frame.
import React from 'react'
import {
  Audio, Composition, AbsoluteFill, Easing, Img, OffthreadVideo,
  interpolate, useCurrentFrame, useVideoConfig,
} from 'remotion'
import type { TrackJSON, ClipJSON, TimelineJSON } from './types'

type JsonProps = { timeline: TimelineJSON; dir: string }

const cssEffect = (type: string, amount = 1): string | null => {
  switch (type) {
    case 'grayscale': return 'grayscale(100%)'
    case 'sepia': return `sepia(${Math.min(1, amount)})`
    case 'blur': return `blur(${amount}px)`
    case 'brightness': return `brightness(${Math.max(0.2, amount)})`
    case 'contrast': return `contrast(${Math.max(0.2, amount)})`
    case 'saturation': return `saturate(${Math.max(0.2, amount)})`
    case 'mirror': return 'scaleX(-1)'
    case 'flip': return 'scaleY(-1)'
    default: return null
  }
}

const animTransform = (phase: number, anim: string, loop = false): string => {
  const p = loop ? (phase - Math.floor(phase)) : Math.min(1, Math.max(0, phase))
  const e = Easing.outCubic(Easing.bezier(0.22, 1, 0.36, 1)(p))
  switch (anim) {
    case 'zoom_in': return `scale(${1 + 0.25 * e})`
    case 'zoom_out': return `scale(${1.25 - 0.25 * e})`
    case 'pulse': return `scale(${1 + 0.05 * Math.sin(p * Math.PI * 4)})`
    case 'spin': return `rotate(${360 * e}deg)`
    case 'shake': return `translate(${6 * Math.sin(p * Math.PI * 8)}px, ${3 * Math.cos(p * Math.PI * 6)}px)`
    case 'pan': return `translateX(${-8 + 16 * e}%)`
    default: return ''
  }
}

const imgSrc = (dir: string, asset: string): string =>
  `file://${dir}/${String(asset).replace(/^\//, '')}`

// --- video clip ------------------------------------------------------------
const VideoClip: React.FC<{ clip: ClipJSON; dir: string; relFrame: number; fps: number }> =
({ clip, dir, relFrame, fps }) => {
  const filters = (clip.effects || []).map((fx) => cssEffect(fx.type, fx.amount)).filter(Boolean) as string[]
  const anim = (clip.effects || []).find((f) => f.type === 'animation')
  const rot = (clip.effects || []).find((f) => f.type === 'rotate')
  const fadeDur = (clip.transitionIn && clip.transitionIn.type !== 'cut')
    ? (clip.transitionIn.duration ?? 0.3) : 0
  const fade = fadeDur
    ? interpolate(relFrame / fps, [0, fadeDur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 1
  const transform = rot ? `rotate(${rot.amount ?? 90}deg)` : undefined
  return (
    <AbsoluteFill
      style={{
        filter: filters.join(' ') || undefined,
        opacity: fade,
        transform,
        transformOrigin: 'center center',
      }}
    >
      <OffthreadVideo
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        src={imgSrc(dir, clip.asset)}
        startFrom={Math.round((clip.sourceStart ?? 0) * fps)}
      />
    </AbsoluteFill>
  )
}

// --- overlay clip (image/gif/sticker/external text PNG) ---------------------
const OverlayClip: React.FC<{ clip: ClipJSON; dir: string; relFrame: number; fps: number }> =
({ clip, dir, relFrame, fps }) => {
  const asset = String(clip.asset)
  if (asset.startsWith('text:')) return <TextClip clip={clip} relFrame={relFrame} fps={fps} />
  const pos = (Array.isArray(clip.pos) ? clip.pos : [0.5, 0.5])
  const fadeDur = (clip.transitionIn && clip.transitionIn.type !== 'cut')
    ? (clip.transitionIn.duration ?? 0.3) : 0
  const fade = fadeDur
    ? interpolate(relFrame / fps, [0, fadeDur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 1
  const anim = (clip.effects || []).find((f) => f.type === 'animation')
  const op = (clip.opacity != null ? clip.opacity : 1) * fade
  return (
    <Img
      src={imgSrc(dir, asset)}
      style={{
        position: 'absolute',
        left: `${pos[0] * 100}%`,
        top: `${pos[1] * 100}%`,
        transform: `translate(-50%, -50%) scale(${clip.scale ?? 1})${anim ? ' ' + animTransform(relFrame / fps / Math.max(0.01, anim.duration ?? 1), anim.anim ?? anim.type ?? 'zoom_in', !!anim.loop) : ''}`,
        opacity: op,
        maxWidth: '92%',
        maxHeight: '92%',
      }}
    />
  )
}

// --- inline text overlay (asset "text:<content>") --------------------------
const TextClip: React.FC<{ clip: ClipJSON; relFrame: number; fps: number }> = ({ clip, relFrame, fps }) => {
  const text = String(clip.asset).slice(5)
  const pos = (Array.isArray(clip.pos) ? clip.pos : [0.5, 0.5])
  const size = clip.size ?? 48
  const fadeDur = (clip.transitionIn && clip.transitionIn.type !== 'cut')
    ? (clip.transitionIn.duration ?? 0.3) : 0
  const fade = fadeDur
    ? interpolate(relFrame / fps, [0, fadeDur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 1
  return (
    <div style={{
      position: 'absolute',
      left: `${pos[0] * 100}%`,
      top: `${pos[1] * 100}%`,
      transform: 'translate(-50%, -50%)',
      width: '86%', textAlign: 'center',
      fontFamily: 'DejaVu Sans, sans-serif', fontWeight: 'bold',
      fontSize: size, color: clip.color ?? '#FFFFFF',
      textShadow: '0 2px 6px rgba(0,0,0,.8)', opacity: fade,
      whiteSpace: 'pre-wrap',
    }}>
      {text}
    </div>
  )
}

// --- track layer: renders only the clip active at the current frame --------
const TrackLayers: React.FC<{ track: TrackJSON; dir: string }> = ({ track, dir }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  if (track.locked) return null
  return (
    <>
      {track.clips.map((c) => {
        const startF = Math.round((c.timelineStart ?? 0) * fps)
        const durF = Math.max(1, Math.round((c.duration ?? 1) * fps))
        if (frame < startF || frame >= startF + durF) return null
        const relFrame = frame - startF
        if (c.kind === 'video') {
          return <VideoClip key={c.id} clip={c} dir={dir} relFrame={relFrame} fps={fps} />
        }
        if (c.kind === 'image') {
          return <OverlayClip key={c.id} clip={c} dir={dir} relFrame={relFrame} fps={fps} />
        }
        return null
      })}
    </>
  )
}

// --- audio tracks -----------------------------------------------------------
const AudioClips: React.FC<{ timeline: TimelineJSON; dir: string }> = ({ timeline, dir }) => {
  const { fps } = useVideoConfig()
  const clips = timeline.tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.clips)
  return (
    <>
      {clips.map((c) => {
        if (c.muted) return null
        const fin = (c.effects || []).find((f) => f.type === 'audio_fade')
        const inS = fin ? (fin.fin ?? 0.5) : 0
        const outS = fin ? (fin.fout ?? 0.5) : 0
        return (
          <Audio
            key={c.id}
            src={imgSrc(dir, c.asset)}
            startFrom={Math.round((c.sourceStart ?? 0) * fps)}
            volume={(f: number) => {
              let v = c.volume != null ? c.volume : 1
              const t = f / fps
              if (inS > 0 && t < inS) v *= t / inS
              if (outS > 0 && (c.duration ?? 0) > 0 && (c.duration! - t) < outS) {
                v *= Math.max(0, (c.duration! - t) / outS)
              }
              return v
            }}
          />
        )
      })}
    </>
  )
}

// --- main composition --------------------------------------------------------
const TimelineComposition: React.FC<JsonProps> = ({ timeline, dir }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#000', overflow: 'hidden' }}>
      {timeline.tracks.filter((t) => t.kind === 'video').map((tr) => (
        <TrackLayers key={tr.id} track={tr} dir={dir} />
      ))}
      <AudioClips timeline={timeline} dir={dir} />
    </AbsoluteFill>
  )
}

export const RemotionRoot: React.FC = () => {
  const fallback = {
    timeline: { fps: 30, width: 1080, height: 1920, tracks: [], markers: [] },
    dir: '.',
  }
  return (
    <Composition
      id="TimelineComposition"
      component={(p: JsonProps) => <TimelineComposition {...p} />}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={30 * 10}
      defaultProps={fallback}
    />
  )
}
