// remotion/index.ts — Remotion entry: registers the timeline-driven
// compositions. server.js renders through `npx remotion render` (see
// scripts/remotion-render.js); `npx remotion studio remotion/index.ts` gives a
// live editing preview of the same composition.
import { registerRoot } from 'remotion'
import { RemotionRoot } from './Root'

registerRoot(RemotionRoot)
