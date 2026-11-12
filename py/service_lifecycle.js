// ---------------------------------------------------------------------------
// py/service_lifecycle.js — ownership-aware lifecycle manager for the
// AIClipStudio Python processing service (py/service.py).
//
// Why this exists: server.js used to spawn py/service.py with stdio:inherit,
// keep no child reference and install no signal handlers. If Node was killed
// (Ctrl+C in some shells, crash, IDE stop button, SIGKILL) the Python child
// stayed alive holding 127.0.0.1:8611. The next `node server.js` spawned a
// second Python, which died with `OSError: [Errno 98] Address already in use`.
//
// Policy implemented here:
//   • a healthy service that proves it belongs to THIS installation is reused;
//   • a port owned by anything else is never killed — startup fails with a
//     diagnostic;
//   • we only ever signal a PID whose /proc cmdline still points at our
//     service.py (or our own spawned child handle);
//   • an app-wide singleton lock stops two Node instances from racing;
//   • owned Python children are terminated gracefully on shutdown.
//
// Linux, Android/Termux and Ubuntu all expose /proc, so ownership checks are
// exact there. On platforms without /proc the manager falls back to a live-PID
// check plus the state file, and never kills a "maybe ours" process.
// ---------------------------------------------------------------------------
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const SERVICE_NAME = 'aiclipstudio-py'
const SERVICE_PROTOCOL = 2
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8611

class PythonServiceError extends Error {
  constructor(message, code = 'PY_SERVICE_ERROR') {
    super(message)
    this.name = 'PythonServiceError'
    this.code = code
  }
}

class AlreadyRunningError extends PythonServiceError {
  constructor(info) {
    const where = info && info.port ? ` (web port ${info.port})` : ''
    super(
      `AIClipStudio is already running for this installation${where}: pid ${info && info.pid}` +
      `${info && info.started_at ? `, started ${info.started_at}` : ''}. ` +
      'Stop that process first. Two Node instances would fight over the same Python service.',
      'ALREADY_RUNNING',
    )
    this.info = info || {}
  }
}

function realpathOr(p) {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

// Deterministic installation identity. Must stay byte-for-byte compatible with
// install_id() in py/service.py.
function installIdForRoot(root) {
  return crypto.createHash('sha256')
    .update(realpathOr(root) + '|aiclipstudio-py|2')
    .digest('hex')
    .slice(0, 24)
}

function roughTimestamp(ms = Date.now()) {
  try { return new Date(ms).toISOString() } catch { return String(ms) }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    // EPERM means the process exists but belongs to another user.
    return e && e.code === 'EPERM'
  }
}

function readProcCmdline(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return raw.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

function readProcCwd(pid) {
  try { return fs.realpathSync(`/proc/${pid}/cwd`) } catch { return null }
}

// Resolve every argv entry against the process cwd so `node server.js` and
// `python /abs/py/service.py` can both be matched safely.
function resolvedArgv(pid) {
  const args = readProcCmdline(pid)
  if (!args) return null
  const cwd = readProcCwd(pid)
  return args.map((arg) => {
    if (path.isAbsolute(arg)) return realpathOr(arg)
    if (!cwd) return arg
    return realpathOr(path.join(cwd, arg))
  })
}

// Positive ownership proof: the process argv must reference the expected
// script inside this repository. Returns 'cmdline' | 'state' | null.
function verifyPidOwnsScript(pid, scriptPath, root) {
  const target = realpathOr(scriptPath)
  const args = resolvedArgv(pid)
  if (args) {
    const inRoot = root ? realpathOr(root) : null
    if (args.some((arg) => arg === target)) return 'cmdline'
    // A shebang/relative invocation can leave the script argument unresolved on
    // exotic systems; accept an exact suffix plus cwd inside the repo.
    const cwd = readProcCwd(pid)
    if (cwd && inRoot && (cwd === inRoot || cwd.startsWith(inRoot + path.sep))) {
      if (args.some((arg) => arg.endsWith(path.sep + path.basename(target)) ||
                              arg === path.basename(target))) return 'cmdline'
    }
    // The path is right but a wrapper (e.g. `python -m`) obscures it.
    return null
  }
  // No /proc: only a live PID is checked; callers treat this as a weak proof
  // and never use it to kill anything.
  return isPidAlive(pid) ? 'state' : null
}

// /proc/net/tcp parser → inode(s) in LISTEN state for a local port.
function listeningSocketInodes(port) {
  const wanted = Number(port).toString(16).toUpperCase().padStart(4, '0')
  const inodes = new Set()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f.length < 10) continue
      const local = f[1] || ''
      const state = (f[3] || '').toUpperCase()
      const inode = f[9]
      if (state !== '0A') continue // TCP_LISTEN
      const localPort = local.includes(':') ? local.split(':').pop().toUpperCase() : ''
      if (localPort === wanted && inode && inode !== '0') inodes.add(inode)
    }
  }
  return inodes
}

function pidHoldsSocket(pid, inodes) {
  if (!inodes.size) return false
  let fds
  try { fds = fs.readdirSync(`/proc/${pid}/fd`) } catch { return false }
  for (const fd of fds) {
    let link
    try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`) } catch { continue }
    const m = /^socket:\[(\d+)\]$/.exec(link)
    if (m && inodes.has(m[1])) return true
  }
  return false
}

// Best-effort: who is listening on this port? Linux/Termux only. Returns a pid
// whose fd points at the LISTEN socket, or null. Never throws.
function findPortOwnerPid(port) {
  const inodes = listeningSocketInodes(port)
  if (!inodes.size) return null
  let names
  try { names = fs.readdirSync('/proc') } catch { return null }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === process.pid) continue
    if (pidHoldsSocket(pid, inodes)) return pid
  }
  return null
}

function probePort(host, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function requestHealth(host, port, timeoutMs = 2500) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: ctl.signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json().catch(() => null)
    if (!body || typeof body !== 'object') return { ok: false, error: 'non-JSON health response' }
    return { ok: true, body }
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'health check timed out' : (e && e.message) || String(e) }
  } finally {
    clearTimeout(timer)
  }
}

function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function safeWrite(stream, text) {
  if (!stream || stream.destroyed || stream.writableEnded) return false
  try {
    return stream.write(text)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Application singleton lock (.runtime/app.lock). Never trusts a PID file:
// every live PID is re-validated against /proc argv before it is respected,
// and a stale lock is removed only when its inode has not changed under us.
// ---------------------------------------------------------------------------
class ApplicationLock {
  constructor({ root, runtimeDir, port = null, instanceId = null, log = null } = {}) {
    this.root = realpathOr(root || process.cwd())
    this.runtimeDir = runtimeDir || path.join(this.root, '.runtime')
    this.path = path.join(this.runtimeDir, 'app.lock')
    this.port = port
    this.instanceId = instanceId || crypto.randomUUID()
    this.scriptPath = path.join(this.root, 'server.js')
    this.fd = null
    this.acquired = false
    this.log = log || (() => {})
  }

  info() {
    return {
      service: 'aiclipstudio',
      install_id: installIdForRoot(this.root),
      instance_id: this.instanceId,
      pid: process.pid,
      port: this.port,
      cwd: process.cwd(),
      argv: process.argv.slice(0, 6),
      started_at: new Date().toISOString(),
      host: os.hostname(),
    }
  }

  // Returns the lock info, or throws AlreadyRunningError.
  async acquire({ retries = 12, retryMs = 50 } = {}) {
    if (process.env.AICLIP_SINGLETON_DISABLED === '1') {
      this.log('[ai-studio] singleton lock disabled by AICLIP_SINGLETON_DISABLED=1')
      return null
    }
    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        this.fd = fs.openSync(this.path, 'wx', 0o600)
        const data = this.info()
        fs.writeSync(this.fd, JSON.stringify(data, null, 2) + '\n')
        try { fs.fsyncSync(this.fd) } catch { /* not fsync-able on every FS */ }
        this.acquired = true
        return data
      } catch (e) {
        if (!e || e.code !== 'EEXIST') throw e
        let stat = null
        try { stat = fs.statSync(this.path) } catch { continue }
        const existing = readJson(this.path)
        if (existing && this._isLiveOwner(existing)) throw new AlreadyRunningError(existing)
        // Invalid or stale. Give a writer a moment to finish before unlinking,
        // and only unlink the exact inode we inspected.
        const ageMs = Date.now() - Number(stat.mtimeMs || 0)
        if (!existing && ageMs < 1000 && attempt < retries) {
          await sleep(retryMs)
          continue
        }
        try {
          const again = fs.statSync(this.path)
          if (again.ino !== stat.ino || again.mtimeMs !== stat.mtimeMs) {
            await sleep(retryMs)
            continue
          }
          fs.unlinkSync(this.path)
        } catch { /* another process cleaned it first */ }
        await sleep(retryMs)
      }
    }
    throw new PythonServiceError(
      `could not acquire ${this.path} after ${retries + 1} attempts; ` +
      'remove the file only if no AIClipStudio process is running.',
      'LOCK_BUSY',
    )
  }

  _isLiveOwner(info) {
    if (!info || info.service !== 'aiclipstudio') return false
    if (info.install_id && info.install_id !== installIdForRoot(this.root)) return false
    if (!isPidAlive(info.pid)) return false
    // Two lock objects in one process (tests, embedded use) are still a
    // conflict; no PID-reuse ambiguity exists when the PID is our own.
    if (Number(info.pid) === process.pid) return true
    // PID reuse protection: the pid must still be running *this* server.js.
    // On non-/proc systems verifyPidOwnsScript returns 'state' for a live pid,
    // which is too weak to justify blocking startup forever.
    return verifyPidOwnsScript(info.pid, this.scriptPath, this.root) === 'cmdline'
  }

  release() {
    if (!this.acquired) return false
    this.acquired = false
    try {
      const current = readJson(this.path)
      if (!current || current.instance_id === this.instanceId) fs.unlinkSync(this.path)
    } catch { /* already gone */ }
    if (this.fd !== null) {
      try { fs.closeSync(this.fd) } catch { /* already closed */ }
      this.fd = null
    }
    return true
  }
}

// ---------------------------------------------------------------------------
// PythonServiceManager
// ---------------------------------------------------------------------------
class PythonServiceManager {
  constructor(options = {}) {
    this.root = realpathOr(options.root || process.cwd())
    this.host = options.host || DEFAULT_HOST
    this.port = Number(options.port) || DEFAULT_PORT
    this.script = options.script || path.join(this.root, 'py', 'service.py')
    this.python = options.python || null // string or () => string
    this.runtimeDir = options.runtimeDir || path.join(this.root, '.runtime')
    this.statePath = path.join(this.runtimeDir, 'py-service.json')
    this.stdout = options.stdout || process.stdout
    this.stderr = options.stderr || process.stderr
    this.log = options.log || ((line) => safeWrite(this.stdout, line + '\n'))
    this.warn = options.warn || ((line) => safeWrite(this.stderr, line + '\n'))
    this.startupTimeoutMs = Number(options.startupTimeoutMs) || 45000
    this.stopTimeoutMs = Number(options.stopTimeoutMs) || 8000
    this.killTimeoutMs = Number(options.killTimeoutMs) || 3000
    this.instanceId = options.instanceId || crypto.randomUUID()
    this.installId = installIdForRoot(this.root)
    this.child = null
    this.owned = false
    this.reused = false
    this.status = 'stopped' // stopped|disabled|starting|healthy|unhealthy|failed|stopping
    this.identity = null
    this.lastError = null
    this.startedAt = null
    this.shuttingDown = false
    this.spawnCount = 0
    this._exitHandled = false
  }

  enabled() {
    return process.env.PY_SERVICE_DISABLED !== '1'
  }

  getStatus() {
    return {
      up: this.status === 'healthy',
      status: this.status,
      mode: this.owned ? 'owned' : (this.reused ? 'reused' : 'disabled'),
      owned: this.owned,
      reused: this.reused,
      pid: this.child ? this.child.pid : (this.identity && this.identity.pid) || null,
      instanceId: this.instanceId,
      installId: this.installId,
      port: this.port,
      host: this.host,
      identity: this.identity,
      error: this.lastError,
      spawnCount: this.spawnCount,
      startedAt: this.startedAt,
    }
  }

  async init() {
    if (this.shuttingDown) throw new PythonServiceError('service manager is shutting down', 'SHUTTING_DOWN')
    if (!this.enabled()) {
      this.status = 'disabled'
      this.log('[ai-studio] python service disabled (PY_SERVICE_DISABLED=1)')
      return this.getStatus()
    }
    this.status = 'starting'
    this.startedAt = new Date().toISOString()

    const existing = await this.inspectExisting()
    if (existing.kind === 'healthy' || existing.kind === 'owned-healthy') {
      this._adoptExisting(existing)
      this.log(`[ai-studio] python service: reusing existing healthy instance ` +
        `(pid ${this.identity && this.identity.pid}) on ${this.host}:${this.port}`)
      return this.getStatus()
    }
    if (existing.kind === 'foreign') {
      this.status = 'failed'
      const err = new PythonServiceError(existing.message, 'PY_PORT_FOREIGN')
      this.lastError = err.message
      throw err
    }
    if (existing.kind === 'owned-unhealthy') {
      this.warn(`[ai-studio] python service on ${this.host}:${this.port} belongs to this ` +
        `installation (pid ${existing.pid}) but failed its health check (${existing.reason}). ` +
        'Stopping the verified owned process before recovery.')
      const stopped = await this._terminateVerifiedPid(existing.pid, 'unhealthy owned service')
      if (!stopped) {
        this.status = 'failed'
        const err = new PythonServiceError(
          `existing AIClipStudio python service (pid ${existing.pid}) is unhealthy and could not be stopped. ` +
          `Stop it manually after verifying it, or choose another PY_SERVICE_PORT.`,
          'PY_OWNED_UNRESPONSIVE',
        )
        this.lastError = err.message
        throw err
      }
      this._removeStateIfPid(existing.pid)
    }

    // Port is closed (or was just recovered). Start exactly one owned child.
    return this._spawnAndWait()
  }

  async inspectExisting() {
    const open = await probePort(this.host, this.port)
    if (!open) return { kind: 'none' }

    const health = await requestHealth(this.host, this.port, 4000)
    if (health.ok) {
      const body = health.body
      if (body.service === SERVICE_NAME) {
        const identity = body.identity && typeof body.identity === 'object' ? body.identity : null
        if (identity && identity.install_id) {
          if (identity.install_id === this.installId) {
            if (!isPidAlive(identity.pid)) {
              // Health answered but its recorded pid is dead — trust only a
              // positively identified listener, never the stale identity.
              const ownerPid = findPortOwnerPid(this.port)
              if (ownerPid && verifyPidOwnsScript(ownerPid, this.script, this.root) === 'cmdline') {
                return { kind: 'owned-unhealthy', pid: ownerPid, reason: 'health identity pid is not alive' }
              }
              return {
                kind: 'foreign',
                message: `port ${this.port} answers like AIClipStudio but its advertised pid ` +
                  `${identity.pid} is not alive, and the listener could not be proven to belong to this ` +
                  'installation. Refusing to kill it; stop it manually or set PY_SERVICE_PORT.',
              }
            }
            return { kind: 'healthy', health: body, identity }
          }
          return {
            kind: 'foreign',
            message: `port ${this.port} is owned by a DIFFERENT AIClipStudio installation ` +
              `(${identity.root || 'unknown path'}, install ${identity.install_id}). ` +
              'Refusing to kill or reuse it. Stop that installation or set PY_SERVICE_PORT.',
          }
        }
        // Legacy service (protocol 1): health alone is not enough. Prove
        // ownership through the listening PID before trusting it.
        const ownerPid = findPortOwnerPid(this.port)
        if (ownerPid && verifyPidOwnsScript(ownerPid, this.script, this.root) === 'cmdline') {
          return { kind: 'owned-healthy', health: body, identity: { ...(body.identity || {}), pid: ownerPid, legacy: true } }
        }
        return {
          kind: 'foreign',
          message: `port ${this.port} is occupied by a legacy AIClipStudio python service that does not ` +
            'expose an installation identity, and its process ownership could not be proven. ' +
            'Stop that service once, then restart. Refusing to kill it automatically.',
        }
      }
      return {
        kind: 'foreign',
        message: `port ${this.port} is occupied by an unrelated HTTP service ` +
          `(health identity: ${String(body.service || body.name || 'unknown')}). ` +
          'Refusing to kill it. Stop that service or set PY_SERVICE_PORT.',
      }
    }

    // TCP is open but health is failing. Only a positively identified owned
    // process may be recovered.
    const state = this._readState()
    if (state && state.pid && state.install_id === this.installId &&
        verifyPidOwnsScript(state.pid, this.script, this.root) === 'cmdline') {
      return { kind: 'owned-unhealthy', pid: state.pid, reason: health.error || 'unresponsive' }
    }
    const ownerPid = findPortOwnerPid(this.port)
    if (ownerPid && verifyPidOwnsScript(ownerPid, this.script, this.root) === 'cmdline') {
      return { kind: 'owned-unhealthy', pid: ownerPid, reason: health.error || 'unresponsive' }
    }
    return {
      kind: 'foreign',
      message: `port ${this.port} is in use by an unresponsive process that could NOT be identified ` +
        `as this AIClipStudio installation (${health.error || 'health check failed'}). ` +
        'Refusing to kill it. Investigate with: ss -ltnp | grep ' + this.port +
        ', then stop it or set PY_SERVICE_PORT.',
    }
  }

  _adoptExisting({ health, identity }) {
    this.reused = true
    this.owned = false
    this.status = 'healthy'
    this.identity = {
      ...identity,
      pid: Number(identity.pid),
      install_id: identity.install_id || this.installId,
      service: SERVICE_NAME,
      protocol: Number(identity.protocol) || SERVICE_PROTOCOL,
      legacy: !!identity.legacy,
    }
    this.child = null
    this.lastError = null
  }

  resolvePython() {
    const value = typeof this.python === 'function' ? this.python() : this.python
    if (!value) throw new PythonServiceError('no python interpreter configured', 'PY_NO_INTERPRETER')
    return value
  }

  async _spawnAndWait() {
    const bin = this.resolvePython()
    const env = {
      ...process.env,
      PY_SERVICE_HOST: this.host,
      PY_SERVICE_PORT: String(this.port),
      AICLIP_ROOT: this.root,
      AICLIP_INSTALL_ID: this.installId,
      AICLIP_INSTANCE_ID: this.instanceId,
      AICLIP_RUNTIME_DIR: this.runtimeDir,
    }
    this.spawnCount++
    let child
    try {
      child = spawn(bin, [this.script], {
        cwd: this.root,
        env,
        // Pipes (not inherit): on shutdown the pipe ends are ours to close and
        // we never write to a destroyed stream. stdout/stderr forwarding is
        // guarded by safeWrite().
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      this.status = 'failed'
      this.lastError = `could not spawn python (${bin}): ${e.message}`
      throw new PythonServiceError(this.lastError, 'PY_SPAWN_FAILED')
    }

    this.child = child
    this.owned = true
    this.reused = false
    this._exitHandled = false

    child.stdout && child.stdout.on('data', (chunk) => safeWrite(this.stdout, chunk))
    child.stderr && child.stderr.on('data', (chunk) => safeWrite(this.stderr, chunk))
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue
      stream.on('error', () => { /* child pipe torn down; never rethrow */ })
    }

    let spawnError = null
    child.on('error', (e) => {
      spawnError = e
      this.lastError = `python service spawn error: ${e.message}`
      if (this.status === 'starting') this.status = 'failed'
      this.warn(`[ai-studio] python service spawn error: ${e.message}`)
    })

    child.on('exit', (code, signal) => {
      if (this._exitHandled) return
      this._exitHandled = true
      const wasOwned = this.owned && this.child === child
      this.child = null
      if (this.shuttingDown || this.status === 'stopping') {
        this.status = 'stopped'
        return
      }
      if (wasOwned) {
        this.owned = false
        this.status = 'unhealthy'
        this.lastError = `python service exited (code ${code}, signal ${signal || 'none'})`
        this.warn(`[ai-studio] python service exited unexpectedly (code ${code}, signal ${signal || 'none'}) ` +
          '— python features are unavailable until the next restart. Node stays up.')
        this._removeStateIfPid(child.pid)
      }
    })

    const deadline = Date.now() + this.startupTimeoutMs
    let lastReason = 'not accepting connections'
    while (Date.now() < deadline) {
      if (this.shuttingDown) break
      if (spawnError) break
      if (!isPidAlive(child.pid)) {
        lastReason = child.exitCode !== null ? `process exited with code ${child.exitCode}` : 'process exited'
        break
      }
      const health = await requestHealth(this.host, this.port, 2500)
      if (health.ok) {
        const identity = health.body && health.body.identity
        if (health.body.service === SERVICE_NAME && identity &&
            identity.install_id === this.installId &&
            Number(identity.pid) === Number(child.pid)) {
          this.status = 'healthy'
          this.identity = { ...identity }
          this.lastError = null
          this._writeState(child.pid)
          this.log(`[ai-studio] python service: started (pid ${child.pid}) on ${this.host}:${this.port} ` +
            `[install ${this.installId}]`)
          return this.getStatus()
        }
        if (health.body.service === SERVICE_NAME && !identity) {
          lastReason = 'python service does not expose an installation identity (old service.py?)'
          break
        }
        lastReason = 'health endpoint answered but identity did not match the spawned child'
      } else {
        lastReason = health.error || lastReason
      }
      await sleep(200)
    }

    this.status = 'failed'
    this.lastError = `python service did not become healthy on ${this.host}:${this.port}: ${lastReason}`
    await this._stopChild(child, 'startup failed')
    throw new PythonServiceError(this.lastError, 'PY_START_FAILED')
  }

  _writeState(pid) {
    const state = {
      service: SERVICE_NAME,
      protocol: SERVICE_PROTOCOL,
      install_id: this.installId,
      instance_id: this.instanceId,
      pid,
      port: this.port,
      host: this.host,
      script: realpathOr(this.script),
      root: this.root,
      started_at: new Date().toISOString(),
    }
    try {
      writeJsonAtomic(this.statePath, state)
    } catch (e) {
      this.warn(`[ai-studio] could not write ${this.statePath}: ${e.message}`)
    }
  }

  _readState() {
    const state = readJson(this.statePath)
    if (!state || state.service !== SERVICE_NAME) return null
    if (state.install_id !== this.installId) return null
    return state
  }

  _removeStateIfPid(pid) {
    const state = this._readState()
    if (!state || Number(state.pid) !== Number(pid)) return
    try { fs.unlinkSync(this.statePath) } catch { /* already gone */ }
  }

  // Accepts only a PID whose live argv still points at our service.py.
  async _terminateVerifiedPid(pid, reason) {
    if (!isPidAlive(pid)) return true
    if (verifyPidOwnsScript(pid, this.script, this.root) !== 'cmdline') {
      this.warn(`[ai-studio] refusing to signal pid ${pid}: ownership check failed (${reason})`)
      return false
    }
    try { process.kill(pid, 'SIGTERM') } catch (e) { if (e.code !== 'ESRCH') return false }
    const gracefulDeadline = Date.now() + this.stopTimeoutMs
    while (Date.now() < gracefulDeadline) {
      if (!isPidAlive(pid)) return true
      await sleep(100)
    }
    // Re-verify immediately before force-kill: the PID may have been reused.
    if (verifyPidOwnsScript(pid, this.script, this.root) !== 'cmdline') return !isPidAlive(pid)
    this.warn(`[ai-studio] python service (pid ${pid}) ignored SIGTERM; sending SIGKILL to the verified owned process`)
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    const killDeadline = Date.now() + this.killTimeoutMs
    while (Date.now() < killDeadline) {
      if (!isPidAlive(pid)) return true
      await sleep(100)
    }
    return false
  }

  async _stopChild(child, reason) {
    if (!child) return true
    if (child.exitCode !== null || child.signalCode !== null) {
      this.child = null
      return true
    }
    const exited = new Promise((resolve) => {
      child.once('exit', () => resolve(true))
    })
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    const graceful = await Promise.race([exited, sleep(this.stopTimeoutMs).then(() => false)])
    if (!graceful && child.exitCode === null && child.signalCode === null) {
      this.warn(`[ai-studio] python service (pid ${child.pid}) did not exit after SIGTERM ` +
        `during ${reason}; sending SIGKILL to the owned child`)
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      await Promise.race([exited, sleep(this.killTimeoutMs)])
    }
    const gone = child.exitCode !== null || child.signalCode !== null
    if (gone) this._removeStateIfPid(child.pid)
    this._closeChildStreams(child)
    if (this.child === child) this.child = null
    return gone
  }

  _closeChildStreams(child) {
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue
      try {
        if (!stream.destroyed) stream.destroy()
      } catch { /* ignore */ }
    }
  }

  async health() {
    if (!this.enabled()) return { up: false, disabled: true, error: 'PY_SERVICE_DISABLED=1' }
    const health = await requestHealth(this.host, this.port, 2000)
    if (!health.ok) {
      return {
        up: false,
        error: health.error || 'python service unavailable',
        mode: this.getStatus().mode,
        pid: this.getStatus().pid,
      }
    }
    const body = health.body
    const identity = body.identity || null
    const matches = body.service === SERVICE_NAME && identity && identity.install_id === this.installId
    if (!matches && this.status === 'healthy') {
      return {
        up: false,
        error: `port ${this.port} now answers with a service that is not this installation`,
        mode: this.getStatus().mode,
      }
    }
    return {
      up: matches || body.service === SERVICE_NAME,
      modules: body.modules || {},
      identity,
      mode: this.getStatus().mode,
      pid: identity ? identity.pid : this.getStatus().pid,
    }
  }

  async stop(reason = 'shutdown') {
    this.shuttingDown = true
    this.status = 'stopping'
    const child = this.child
    if (this.owned && child) {
      const ok = await this._stopChild(child, reason)
      if (!ok) this.warn(`[ai-studio] owned python service pid ${child.pid} may still be running`)
      this.owned = false
    } else if (this.reused) {
      // Reused service belongs to another live/previous AIClipStudio process.
      // Never stop it here.
      this.log(`[ai-studio] leaving reused python service running (pid ` +
        `${this.identity && this.identity.pid}) — not owned by this Node process`)
      this.reused = false
    }
    this._closeChildStreams(child || {})
    this.child = null
    this.status = 'stopped'
    return this.getStatus()
  }
}

module.exports = {
  SERVICE_NAME,
  SERVICE_PROTOCOL,
  DEFAULT_HOST,
  DEFAULT_PORT,
  PythonServiceError,
  AlreadyRunningError,
  ApplicationLock,
  PythonServiceManager,
  installIdForRoot,
  verifyPidOwnsScript,
  findPortOwnerPid,
  probePort,
  requestHealth,
  isPidAlive,
  readProcCmdline,
}
