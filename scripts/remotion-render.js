// scripts/remotion-render.js — Remotion render entry the app drives.
//   node scripts/remotion-render.js <timeline.json> <out.mp4> [--studio]
// timeline.json = { timeline: <summarize()>, dir: <job dir> } (same shape the
// /api/tool render_timeline tool gets). `remotion studio` (web preview) is
// started with --studio on the same props. Exits non-zero on render failure.
const cp = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const REMOTION = path.join(ROOT, 'remotion', 'index.ts')

// Headless Chrome resolves fonts through fontconfig on Linux/Termux. Mirror
// vendor/fonts into the user font dir + refresh the cache so Remotion text
// clips (incl. Thai in Root.tsx's fontFamily fallback chain) render with the
// bundled Noto Sans Thai even on a bare container. Idempotent, best-effort.
function ensureVendoredFontsVisible() {
  const vendorDir = path.join(ROOT, 'vendor', 'fonts')
  const home = process.env.HOME
  if (!home || !fs.existsSync(vendorDir)) return
  const target = path.join(home, '.fonts')
  try {
    fs.mkdirSync(target, { recursive: true })
    for (const f of fs.readdirSync(vendorDir)) {
      if (!/\.tt[fc]$/i.test(f)) continue
      const dst = path.join(target, f)
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(vendorDir, f), dst)
    }
    cp.execFileSync('fc-cache', ['-f', target], { timeout: 30000, stdio: 'ignore' })
  } catch (e) {
    console.warn('[remotion-render] font sync skipped:', e.message)
  }
}

ensureVendoredFontsVisible()

const args = process.argv.slice(2)
if (args.includes('--studio')) {
  const propsFile = args[0]
  if (!propsFile) {
    console.error('usage: node scripts/remotion-render.js <props.json> --studio')
    process.exit(2)
  }
  const child = cp.spawn('npx', [
    'remotion', 'studio', REMOTION,
    '--props', fs.readFileSync(propsFile, 'utf8'),
  ], { stdio: 'inherit', cwd: ROOT, env: process.env })
  child.on('exit', (c) => process.exit(c || 0))
} else {
  const [propsFile, outPath] = args
  if (!propsFile || !outPath) {
    console.error('usage: node scripts/remotion-render.js <props.json> <out.mp4>')
    process.exit(2)
  }
  const maxIndex = 3600 * 5 // up to 5 minutes at 30fps unless the timeline says more
  const props = JSON.parse(fs.readFileSync(propsFile, 'utf8'))
  const dur = maxTimelineDurationSec(props.timeline) || 10
  const fps = props.timeline.fps || 30
  const child = cp.spawn('npx', [
    'remotion', 'render', REMOTION, 'TimelineComposition', outPath,
    '--props', JSON.stringify(props),
    '--duration-in-frames', String(Math.ceil(dur * fps)),
    '--fps', String(fps),
    '--codec', 'h264',
    '--concurrency', String(Math.max(1, Math.min(4, require('os').cpus ? require('os').cpus().length - 1 : 2))),
  ], { stdio: 'inherit', cwd: ROOT, env: process.env })
  child.on('exit', (c) => process.exit(c || 0))
}

function maxTimelineDurationSec(tl) {
  let d = 0
  for (const tr of (tl.tracks || [])) {
    for (const c of (tr.clips || [])) {
      d = Math.max(d, (c.timelineStart || 0) + (c.duration || 0))
    }
  }
  return d
}
