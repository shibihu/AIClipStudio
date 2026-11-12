// test/fixtures/fake-py-service.js — tiny stand-in for py/service.py used by
// test/py-lifecycle.test.js. Speaks the same /health identity contract and
// supports failure modes via FAKE_PY_MODE so lifecycle tests are fast and do
// not need the real Python dependency stack.
'use strict'

const fs = require('fs')
const http = require('http')
const path = require('path')
const { installIdForRoot } = require('../../py/service_lifecycle')

const host = process.env.PY_SERVICE_HOST || '127.0.0.1'
const port = Number(process.env.PY_SERVICE_PORT) || 0
const root = process.env.AICLIP_ROOT || path.join(__dirname, '..', '..')
const mode = process.env.FAKE_PY_MODE || 'normal'
const healthFile = process.env.FAKE_PY_HEALTH_FILE || ''
const pidFile = process.env.FAKE_PY_PIDFILE || ''

if (mode === 'crash') {
  process.stderr.write('fake-py: crashing on purpose\n')
  process.exit(3)
}

if (pidFile) {
  try { fs.writeFileSync(pidFile, String(process.pid)) } catch { /* test fixture */ }
}

function identity() {
  return {
    service: 'aiclipstudio-py',
    protocol: 2,
    version: 2,
    pid: process.pid,
    py_pid: process.pid,
    root,
    install_id: installIdForRoot(root),
    instance_id: process.env.AICLIP_INSTANCE_ID || null,
    host,
    port,
    started_at: Date.now(),
    started_at_iso: new Date().toISOString(),
    python: 'fake',
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/health' || url.pathname === '/') {
    // Optional "unhealthy but still listening" mode used by the recovery test.
    const unhealthy = healthFile && fs.existsSync(healthFile)
    const body = JSON.stringify(unhealthy
      ? { ok: false, service: 'aiclipstudio-py', error: 'fake unhealthy', identity: identity() }
      : { ok: true, service: 'aiclipstudio-py', version: 2, protocol: 2, modules: {}, endpoints: [], identity: identity() })
    res.writeHead(unhealthy ? 503 : 200, { 'content-type': 'application/json' })
    res.end(body)
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"ok":false,"error":"unknown route"}')
})

if (mode === 'noisy-die') {
  // Exercise Node's guarded stream forwarding: write a lot, then exit before
  // the health check can ever succeed.
  for (let i = 0; i < 2000; i++) process.stdout.write(`fake-py noisy line ${i}\n`)
  process.stderr.write('fake-py: noisy-die exiting\n')
  process.exit(9)
}

server.on('error', (e) => {
  process.stderr.write(`fake-py: bind failed: ${e.message}\n`)
  process.exit(2)
})

server.listen(port, host, () => {
  process.stdout.write(`fake-py: listening ${host}:${port} pid ${process.pid}\n`)
  if (mode === 'die-after-ready') {
    setTimeout(() => {
      process.stderr.write('fake-py: dying after ready\n')
      process.exit(7)
    }, 400)
  }
})

if (process.env.FAKE_PY_IGNORE_TERM === '1') {
  process.on('SIGTERM', () => {
    process.stderr.write('fake-py: ignoring SIGTERM\n')
  })
} else {
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  })
}
process.on('SIGINT', () => process.exit(0))
