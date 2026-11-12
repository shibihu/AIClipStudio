// test/fixtures/orphan-host.js — starts the lifecycle manager, prints READY,
// then waits to be SIGKILLed. Used to reproduce "Node died but Python survived"
// without involving the real Python dependency stack.
'use strict'

const { PythonServiceManager } = require('../../py/service_lifecycle')

const manager = new PythonServiceManager({
  root: process.env.AICLIP_ROOT,
  host: '127.0.0.1',
  port: Number(process.env.PY_SERVICE_PORT),
  script: process.env.FAKE_PY_SCRIPT,
  python: process.execPath,
  runtimeDir: process.env.AICLIP_RUNTIME_DIR,
  startupTimeoutMs: 10000,
  log: () => {},
  warn: () => {},
})

manager.init()
  .then((status) => {
    process.stdout.write('READY ' + JSON.stringify(status) + '\n')
  })
  .catch((e) => {
    process.stderr.write('ORPHAN-HOST-FAILED ' + (e && e.stack ? e.stack : e) + '\n')
    process.exit(1)
  })

process.on('SIGTERM', () => {
  manager.stop('helper').finally(() => process.exit(0))
})
