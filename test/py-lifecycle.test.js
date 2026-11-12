// ---------------------------------------------------------------------------
// test/py-lifecycle.test.js — regression tests for the Python service lifecycle.
//
// Scenarios (A–G from the incident report):
//   A fresh startup starts exactly one service
//   B normal stop + restart works, no EADDRINUSE
//   C orphaned service is detected and safely reused (incl. real SIGKILL)
//   D duplicate startup is blocked by the installation lock
//   E unrelated/foreign port owners are never killed and produce diagnostics
//   F python crash / noisy exit cannot crash Node with a stream error
//   G graceful shutdown removes owned processes, state and locks
//
// Fake service = test/fixtures/fake-py-service.js (same identity contract).
// Run with: node --test test/py-lifecycle.test.js
// ---------------------------------------------------------------------------
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')

const {
  PythonServiceManager,
  ApplicationLock,
  AlreadyRunningError,
  installIdForRoot,
  probePort,
  verifyPidOwnsScript,
  isPidAlive,
} = require('../py/service_lifecycle')

const ROOT = path.join(__dirname, '..')
const FAKE = path.join(__dirname, 'fixtures', 'fake-py-service.js')
const ORPHAN_HOST = path.join(__dirname, 'fixtures', 'orphan-host.js')
const TMP_BASE = '/tmp/opencode'

const sink = {
  writable: true,
  destroyed: false,
  writableEnded: false,
  write() { return true },
}

let tmpCounter = 0
function tempRoot() {
  fs.mkdirSync(TMP_BASE, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TMP_BASE, `py-life-${process.pid}-${tmpCounter++}-`))
  return dir
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function managerFor(root, port, overrides = {}) {
  return new PythonServiceManager({
    root,
    port,
    host: '127.0.0.1',
    script: FAKE,
    python: process.execPath,
    runtimeDir: path.join(root, '.runtime'),
    startupTimeoutMs: 10000,
    stopTimeoutMs: 600,
    killTimeoutMs: 1500,
    log: () => {},
    warn: () => {},
    stdout: sink,
    stderr: sink,
    ...overrides,
  })
}

async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function waitExit(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit in time')), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

function setEnv(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

// --- A: fresh startup ---------------------------------------------------------

test('A. fresh startup starts exactly one verified python service', async (t) => {
  const root = tempRoot()
  const port = await freePort()
  const manager = managerFor(root, port)
  t.after(async () => { await manager.stop('test teardown') })

  assert.equal(await probePort('127.0.0.1', port), false)
  const status = await manager.init()

  assert.equal(status.status, 'healthy')
  assert.equal(status.mode, 'owned')
  assert.equal(status.spawnCount, 1)
  assert.ok(isPidAlive(status.pid))
  assert.equal(status.identity.install_id, installIdForRoot(root))

  const health = await manager.health()
  assert.equal(health.up, true)
  assert.equal(health.identity.install_id, installIdForRoot(root))
  assert.equal(Number(health.identity.pid), Number(status.pid))

  // state file records enough to recover after a Node crash
  const state = JSON.parse(fs.readFileSync(path.join(root, '.runtime', 'py-service.json'), 'utf8'))
  assert.equal(state.pid, status.pid)
  assert.equal(state.install_id, installIdForRoot(root))
  assert.equal(state.instance_id, manager.instanceId)
})

// --- B: normal restart --------------------------------------------------------

test('B. normal stop then restart does not hit Address already in use', async (t) => {
  const root = tempRoot()
  const port = await freePort()

  const first = managerFor(root, port)
  t.after(async () => { await first.stop('test teardown') })
  const firstStatus = await first.init()
  const firstPid = firstStatus.pid
  await first.stop('normal-stop')
  assert.equal(await probePort('127.0.0.1', port), false, 'port must be released on normal stop')
  await waitFor(() => !isPidAlive(firstPid), 3000, 'old python pid to exit')

  const second = managerFor(root, port)
  t.after(async () => { await second.stop('test teardown') })
  const secondStatus = await second.init()
  assert.equal(secondStatus.status, 'healthy')
  assert.equal(secondStatus.mode, 'owned')
  assert.notEqual(secondStatus.pid, firstPid)
  assert.equal(secondStatus.spawnCount, 1)
  assert.equal(await probePort('127.0.0.1', port), true)
})

// --- C: orphan recovery -------------------------------------------------------

test('C1. surviving service is reused (not duplicated) after owner disappears', async (t) => {
  const root = tempRoot()
  const port = await freePort()
  const first = managerFor(root, port)
  t.after(async () => { await first.stop('test teardown') })

  const status = await first.init()
  const orphanPid = status.pid

  // Simulate a Node owner that died without cleanup: "first" never calls stop.
  const second = managerFor(root, port)
  t.after(async () => { await second.stop('test teardown') })
  const reused = await second.init()

  assert.equal(reused.mode, 'reused')
  assert.equal(reused.spawnCount, 0)
  assert.equal(Number(reused.pid), Number(orphanPid))
  assert.equal(await probePort('127.0.0.1', port), true)

  // A non-owner must never stop the shared service.
  await second.stop('restarting-node')
  assert.equal(await probePort('127.0.0.1', port), true, 'reused service must survive non-owner shutdown')
  assert.ok(isPidAlive(orphanPid))

  // The original owner (simulated here) still cleans up in the end.
  await first.stop('final cleanup')
  await waitFor(() => !isPidAlive(orphanPid), 3000, 'restored owner to stop service')
  await waitFor(async () => !(await probePort('127.0.0.1', port)), 3000, 'port release')
})

test('C2. real SIGKILL of the Node owner leaves python running; next start reuses it', async (t) => {
  const root = tempRoot()
  const port = await freePort()
  const runtimeDir = path.join(root, '.runtime')

  const helper = spawn(process.execPath, [ORPHAN_HOST], {
    cwd: ROOT,
    env: {
      ...process.env,
      AICLIP_ROOT: root,
      PY_SERVICE_PORT: String(port),
      AICLIP_RUNTIME_DIR: runtimeDir,
      FAKE_PY_SCRIPT: FAKE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let helperOut = ''
  let helperErr = ''
  helper.stdout.on('data', (c) => { helperOut += c })
  helper.stderr.on('data', (c) => { helperErr += c })

  t.after(() => {
    try { helper.kill('SIGKILL') } catch { /* gone */ }
    try {
      const info = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'py-service.json'), 'utf8'))
      if (isPidAlive(info.pid) && verifyPidOwnsScript(info.pid, FAKE, root) === 'cmdline') {
        process.kill(info.pid, 'SIGTERM')
      }
    } catch { /* no state */ }
  })

  await waitFor(() => helperOut.includes('READY '), 12000, 'orphan host to become ready')
  const status = JSON.parse(helperOut.slice(helperOut.indexOf('READY ') + 6).trim())
  assert.equal(status.status, 'healthy')
  const pythonPid = status.pid

  // Kill the Node owner exactly like a crash/SIGKILL — no signal handlers run.
  helper.kill('SIGKILL')
  const exit = await waitExit(helper)
  assert.equal(exit.signal, 'SIGKILL')
  assert.ok(isPidAlive(pythonPid), 'orphaned python service should still be alive')
  assert.equal(await probePort('127.0.0.1', port), true)
  assert.equal(helperErr.includes('ORPHAN-HOST-FAILED'), false, helperErr)

  const next = managerFor(root, port)
  t.after(async () => {
    await next.stop('test teardown')
    if (isPidAlive(pythonPid) && verifyPidOwnsScript(pythonPid, FAKE, root) === 'cmdline') {
      try { process.kill(pythonPid, 'SIGTERM') } catch { /* gone */ }
    }
  })
  const reused = await next.init()
  assert.equal(reused.mode, 'reused')
  assert.equal(reused.spawnCount, 0)
  assert.equal(Number(reused.pid), Number(pythonPid))
})

// --- D: duplicate startup / singleton lock -----------------------------------

test('D1. application lock blocks a second instance and recovers stale/foreign locks', async () => {
  const root = tempRoot()
  const runtimeDir = path.join(root, '.runtime')
  const lockPath = path.join(runtimeDir, 'app.lock')

  const a = new ApplicationLock({ root, runtimeDir, port: 1111, instanceId: 'instance-a' })
  const b = new ApplicationLock({ root, runtimeDir, port: 2222, instanceId: 'instance-b' })
  await a.acquire()
  await assert.rejects(b.acquire(), (e) => e instanceof AlreadyRunningError && e.code === 'ALREADY_RUNNING')
  a.release()
  await b.acquire()
  b.release()
  assert.equal(fs.existsSync(lockPath), false, 'lock file must be removed on release')

  // stale PID (dead process) is recovered
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(lockPath, JSON.stringify({
    service: 'aiclipstudio',
    install_id: installIdForRoot(root),
    instance_id: 'dead',
    pid: 999999,
    port: 3333,
    started_at: new Date().toISOString(),
  }))
  const c = new ApplicationLock({ root, runtimeDir, instanceId: 'instance-c' })
  await c.acquire()
  c.release()

  // PID reuse protection: a live PID that is not this repo's server.js must
  // never be trusted as the lock owner.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    fs.writeFileSync(lockPath, JSON.stringify({
      service: 'aiclipstudio',
      install_id: installIdForRoot(root),
      instance_id: 'reused-pid',
      pid: bystander.pid,
      port: 4444,
      started_at: new Date().toISOString(),
    }))
    assert.notEqual(verifyPidOwnsScript(bystander.pid, path.join(root, 'server.js'), root), 'cmdline')
    const d = new ApplicationLock({ root, runtimeDir, instanceId: 'instance-d' })
    await d.acquire()
    d.release()
  } finally {
    try { bystander.kill('SIGKILL') } catch { /* gone */ }
  }
})

test('D2. two real node server.js starts cannot create two services', async (t) => {
  const runtimeDir = tempRoot()
  const port1 = await freePort()
  const port2 = await freePort()
  const baseEnv = {
    ...process.env,
    PY_SERVICE_DISABLED: '1',
    AUTH_TOKEN: '',
    AICLIP_RUNTIME_DIR: runtimeDir,
  }
  delete baseEnv.AICLIP_SINGLETON_DISABLED

  const first = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...baseEnv, PORT: String(port1) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let firstErr = ''
  first.stderr.on('data', (c) => { firstErr += c })
  first.stdout.on('data', () => {})
  t.after(() => { try { first.kill('SIGKILL') } catch { /* gone */ } })

  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port1}/api/health`, { signal: AbortSignal.timeout(1000) })
      return res.status === 200
    } catch { return false }
  }, 20000, 'first server to be ready')

  const second = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...baseEnv, PORT: String(port2) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let secondErr = ''
  second.stderr.on('data', (c) => { secondErr += c })
  second.stdout.on('data', () => {})
  const exit = await waitExit(second, 20000)
  assert.equal(exit.code, 1, `second instance should exit 1, stderr=${secondErr}`)
  assert.match(secondErr, /already running/i)
  assert.match(secondErr, /pid \d+/)

  // clean normal shutdown releases the lock
  first.kill('SIGTERM')
  const firstExit = await waitExit(first, 15000)
  assert.equal(firstExit.code, 0, `first shutdown failed, stderr=${firstErr}`)
  assert.equal(fs.existsSync(path.join(runtimeDir, 'app.lock')), false)
})

// --- E: unrelated / foreign port owners ---------------------------------------

test('E1. unrelated HTTP service on the port is never killed; startup explains why', async (t) => {
  const root = tempRoot()
  const port = await freePort()
  const foreign = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ service: 'some-other-app', hello: 'world' }))
  })
  await new Promise((resolve) => foreign.listen(port, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => foreign.close(resolve)))

  const manager = managerFor(root, port)
  await assert.rejects(manager.init(), (e) => {
    assert.equal(e.code, 'PY_PORT_FOREIGN')
    assert.match(e.message, /unrelated|Refusing to kill/i)
    return true
  })
  assert.equal(manager.getStatus().spawnCount, 0, 'must not spawn a duplicate')

  // the foreign process is still alive and serving
  const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).service, 'some-other-app')
})

test('E2. a different AIClipStudio installation is not reused or killed', async (t) => {
  const rootA = tempRoot()
  const rootB = tempRoot()
  const port = await freePort()
  const owner = managerFor(rootA, port)
  t.after(async () => { await owner.stop('test teardown') })
  const ownerStatus = await owner.init()

  const other = managerFor(rootB, port)
  await assert.rejects(other.init(), (e) => {
    assert.equal(e.code, 'PY_PORT_FOREIGN')
    assert.match(e.message, /DIFFERENT AIClipStudio installation/i)
    return true
  })
  assert.equal(await probePort('127.0.0.1', port), true)
  assert.ok(isPidAlive(ownerStatus.pid))
  assert.equal((await owner.health()).up, true)
})

test('E3. owned-but-unhealthy service is recovered only after cmdline proof', async (t) => {
  const root = tempRoot()
  const port = await freePort()
  const healthFile = path.join(root, 'unhealthy.flag')

  setEnv('FAKE_PY_HEALTH_FILE', healthFile)
  const first = managerFor(root, port)
  t.after(async () => {
    setEnv('FAKE_PY_HEALTH_FILE', undefined)
    await first.stop('test teardown')
  })
  const firstStatus = await first.init()
  fs.writeFileSync(healthFile, '1')
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      return res.status === 503
    } catch { return false }
  }, 3000, 'fake service to report unhealthy')

  // New children must be healthy again; keep the flag only for the old child.
  setEnv('FAKE_PY_HEALTH_FILE', undefined)
  const recovery = managerFor(root, port, { startupTimeoutMs: 12000 })
  t.after(async () => { await recovery.stop('test teardown') })
  const recovered = await recovery.init()
  assert.equal(recovered.mode, 'owned')
  assert.equal(recovered.status, 'healthy')
  assert.notEqual(recovered.pid, firstStatus.pid, 'unhealthy owned process must be replaced')
  await waitFor(() => !isPidAlive(firstStatus.pid), 4000, 'unhealthy old process to be stopped')
  assert.ok(isPidAlive(recovered.pid))
})

// --- F: python crash / stream failures ---------------------------------------

test('F1. python that exits immediately fails startup with a clear error', async (t) => {
  const root = tempRoot()
  const port = await freePort()
  setEnv('FAKE_PY_MODE', 'crash')
  t.after(() => setEnv('FAKE_PY_MODE', undefined))

  const manager = managerFor(root, port)
  await assert.rejects(manager.init(), (e) => {
    assert.equal(e.code, 'PY_START_FAILED')
    assert.match(e.message, /did not become healthy/i)
    assert.match(e.message, /exited with code 3|exited/i)
    return true
  })
  assert.equal(manager.spawnCount, 1)
  assert.equal(await probePort('127.0.0.1', port), false)
})

test('F2. service dying after a healthy start is reported, Node does not crash', async (t) => {
  const root = tempRoot()
  const port = await freePort()
  setEnv('FAKE_PY_MODE', 'die-after-ready')
  t.after(() => setEnv('FAKE_PY_MODE', undefined))

  const manager = managerFor(root, port)
  t.after(async () => { await manager.stop('test teardown') })
  const started = await manager.init()
  assert.equal(started.status, 'healthy')
  await waitFor(() => manager.getStatus().up === false, 4000, 'manager to notice child death')
  const status = manager.getStatus()
  assert.equal(status.status, 'unhealthy')
  assert.match(status.error, /exited/i)
  assert.equal((await manager.health()).up, false)
  assert.equal(await probePort('127.0.0.1', port), false)
})

test('F3. noisy child stdout/stderr on crash cannot raise stream errors', async (t) => {
  const root = tempRoot()
  const port = await freePort()
  setEnv('FAKE_PY_MODE', 'noisy-die')
  t.after(() => setEnv('FAKE_PY_MODE', undefined))

  const manager = managerFor(root, port)
  await assert.rejects(manager.init(), (e) => e.code === 'PY_START_FAILED')
  assert.equal(await probePort('127.0.0.1', port), false)
})

// --- G: normal shutdown cleanup ----------------------------------------------

test('G. shutdown removes owned process, state file and lock; force-kill only as last resort', async (t) => {
  const root = tempRoot()
  const runtimeDir = path.join(root, '.runtime')
  const port = await freePort()

  setEnv('FAKE_PY_IGNORE_TERM', '1') // forces the SIGKILL fallback
  t.after(() => setEnv('FAKE_PY_IGNORE_TERM', undefined))

  const lock = new ApplicationLock({ root, runtimeDir, instanceId: 'shutdown-test' })
  await lock.acquire()
  assert.equal(fs.existsSync(path.join(runtimeDir, 'app.lock')), true)

  const manager = managerFor(root, port, { stopTimeoutMs: 500, killTimeoutMs: 2000 })
  const status = await manager.init()
  assert.equal(status.status, 'healthy')
  assert.equal(fs.existsSync(path.join(runtimeDir, 'py-service.json')), true)

  const stopped = await manager.stop('normal shutdown')
  assert.equal(stopped.status, 'stopped')
  assert.equal(isPidAlive(status.pid), false, 'owned child must be gone')
  assert.equal(await probePort('127.0.0.1', port), false)
  assert.equal(fs.existsSync(path.join(runtimeDir, 'py-service.json')), false)

  lock.release()
  assert.equal(fs.existsSync(path.join(runtimeDir, 'app.lock')), false)
})

// --- real py/service.py identity + SIGTERM (skipped if no venv) ---------------

const REAL_PY = path.join(ROOT, '.venv', 'bin', 'python')
const REAL_SERVICE = path.join(ROOT, 'py', 'service.py')

test('real py/service.py exposes identity and shuts down on SIGTERM', {
  skip: !fs.existsSync(REAL_PY) && 'no .venv python available',
}, async (t) => {
  const root = tempRoot()
  const runtimeDir = path.join(root, '.runtime')
  const port = await freePort()
  const manager = new PythonServiceManager({
    root,
    host: '127.0.0.1',
    port,
    script: REAL_SERVICE,
    python: REAL_PY,
    runtimeDir,
    startupTimeoutMs: 60000,
    stopTimeoutMs: 8000,
    log: () => {},
    warn: () => {},
    stdout: sink,
    stderr: sink,
  })
  t.after(async () => { await manager.stop('test teardown') })

  const status = await manager.init()
  assert.equal(status.status, 'healthy')
  assert.equal(status.mode, 'owned')
  assert.equal(status.identity.install_id, installIdForRoot(root))
  assert.equal(Number(status.identity.pid), Number(status.pid))
  assert.match(String(status.identity.python), /^\d+\.\d+/)

  const state = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'py-service.json'), 'utf8'))
  assert.equal(state.pid, status.pid)

  await manager.stop('sigterm-test')
  assert.equal(isPidAlive(status.pid), false)
  assert.equal(await probePort('127.0.0.1', port), false)
  assert.equal(fs.existsSync(path.join(runtimeDir, 'py-service.json')), false)
  assert.equal(fs.existsSync(path.join(runtimeDir, 'py-service.lock')), false,
    'python must release its own single-instance lock on SIGTERM')
})
