// remotion/types.ts — TypeScript shapes matching timeline.summarize() JSON
// (see timeline.js). Kept open (index records) so the OTIO round-trip and
// future optional fields never break rendering.
export interface EffectJSON { type?: string; anim?: string; [k: string]: unknown }
export interface TransitionJSON { type?: string; duration?: number; [k: string]: unknown }
export interface ClipJSON {
  id: string
  asset: string
  kind?: string
  name?: string
  timelineStart?: number
  sourceStart?: number
  duration?: number
  speed?: number
  volume?: number
  muted?: boolean
  opacity?: number
  scale?: number
  pos?: number[]
  color?: string
  size?: number
  text?: string
  transitionIn?: TransitionJSON | null
  effects?: EffectJSON[]
}
export interface TrackJSON {
  id: string
  kind: 'video' | 'audio' | string
  name?: string
  locked?: boolean
  clips: ClipJSON[]
}
export interface TimelineJSON {
  fps: number
  width?: number | null
  height?: number | null
  tracks: TrackJSON[]
  markers?: { time: number; label?: string }[]
  duration?: number
  [k: string]: unknown
}
