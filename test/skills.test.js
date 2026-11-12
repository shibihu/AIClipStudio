// ---------------------------------------------------------------------------
// test/skills.test.js — Native Android Skills API contract tests.
// Covers: server-side Skill allowlist, conversation-context bounds, caption
// instruction bounds, GET /api/health capabilities and the live POST
// /api/chat + /api/captions route validation (backward compatibility for the
// existing website bodies included).
// Run with: node --test test/skills.test.js   (or npm test)
// ---------------------------------------------------------------------------

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const {
  SKILL_IDS, CAPTION_SKILL, HEALTH_CAPABILITIES,
  MAX_SKILLS, MAX_CONTEXT_MESSAGES, MAX_CONTEXT_CHARS, MAX_INSTRUCTION_CHARS,
  validateSkillList, validateConversationContext, validateCaptionInput,
} = require('../skills')

// --- pure validators (server-side allowlist + bounds) --------------------------

test('skill allowlist contains exactly the three documented stable IDs', () => {
  assert.deepEqual([...SKILL_IDS], ['automatic_subtitles', 'voice_cleanup', 'scene_detection'])
  assert.equal(CAPTION_SKILL, 'automatic_subtitles')
})

test('validateSkillList: empty and full lists are valid', () => {
  assert.equal(validateSkillList([]), null)
  assert.equal(validateSkillList(SKILL_IDS), null)
  assert.equal(validateSkillList(['scene_detection']), null)
})

test('validateSkillList: unsupported IDs rejected', () => {
  assert.match(validateSkillList(['made_up_skill']), /supported AIClipStudio Skill ids/)
  assert.match(validateSkillList(['automatic_subtitles', 'nope']), /supported AIClipStudio Skill ids/)
})

test('validateSkillList: malformed payloads rejected', () => {
  assert.equal(validateSkillList('automatic_subtitles'), 'skills must be an array of Skill ids')
  assert.equal(validateSkillList(null), 'skills must be an array of Skill ids')
  assert.match(validateSkillList([42]), /supported AIClipStudio Skill ids/)
  const tooMany = ['automatic_subtitles', 'voice_cleanup', 'scene_detection', 'automatic_subtitles']
  assert.ok(tooMany.length > MAX_SKILLS)
  assert.match(validateSkillList(tooMany), /at most 3 entries/)
})

test('validateConversationContext: valid user/assistant turns pass', () => {
  assert.equal(validateConversationContext([]), null)
  assert.equal(validateConversationContext([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi back' },
  ]), null)
})

test('validateConversationContext: more than 12 messages rejected', () => {
  const turns = Array.from({ length: MAX_CONTEXT_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' }))
  assert.match(validateConversationContext(turns), /at most 12 messages/)
})

test('validateConversationContext: invalid roles rejected', () => {
  assert.match(validateConversationContext([{ role: 'system', content: 'x' }]), /only user or assistant/)
  assert.match(validateConversationContext([{ role: 'tool', content: 'x' }]), /only user or assistant/)
  assert.match(validateConversationContext([{}]), /only user or assistant/)
})

test('validateConversationContext: non-string or oversized content rejected', () => {
  assert.match(validateConversationContext([{ role: 'user', content: 5 }]), /at most 2000 characters/)
  assert.match(validateConversationContext([{ role: 'user' }]), /at most 2000 characters/)
  assert.match(validateConversationContext([null]), /role, content/)
  assert.match(validateConversationContext(['hello']), /role, content/)
  assert.match(validateConversationContext([{ role: 'user', content: 'x'.repeat(MAX_CONTEXT_CHARS + 1) }]), /at most 2000 characters/)
  assert.equal(validateConversationContext([{ role: 'user', content: 'x'.repeat(MAX_CONTEXT_CHARS) }]), null)
})

test('validateCaptionInput: instructions bounds and Skill id', () => {
  assert.equal(validateCaptionInput(null, ''), null)
  assert.equal(validateCaptionInput(CAPTION_SKILL, 'Generate concise Thai subtitles.'), null)
  assert.equal(validateCaptionInput(CAPTION_SKILL, 'x'.repeat(MAX_INSTRUCTION_CHARS)), null)
  assert.match(validateCaptionInput(CAPTION_SKILL, 'x'.repeat(MAX_INSTRUCTION_CHARS + 1)), /at most 1000 characters/)
  assert.match(validateCaptionInput(CAPTION_SKILL, 42), /at most 1000 characters/)
  assert.match(validateCaptionInput('voice_cleanup', ''), /unsupported captions Skill id/)
})

test('HEALTH_CAPABILITIES advertises exactly the documented flags', () => {
  assert.deepEqual(HEALTH_CAPABILITIES, { androidSkills: true, captionInstructions: true })
})

// --- live route wiring (spawn the real server once) ----------------------------

const PORT = 18800 + Math.floor(Math.random() * 500)
const BASE = `http://127.0.0.1:${PORT}`
let server

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  })
  let j = null
  try { j = await r.json() } catch { /* non-JSON */ }
  return { status: r.status, body: j }
}

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      AUTH_TOKEN: '', // open mode for tests (set before .env load wins)
      PY_SERVICE_DISABLED: '1',
      AICLIP_SINGLETON_DISABLED: '1', // never collide with a developer's running app
      JOBS_TTL_HOURS: '100000', // never clean real job dirs during the test
    },
    stdio: 'ignore',
  })
  // wait for /api/health (bounded, fails loudly)
  const deadline = Date.now() + 20000
  for (;;) {
    try {
      const r = await api('GET', '/api/health')
      if (r.status === 200) return
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('test server did not come up on :' + PORT)
    await new Promise((ok) => setTimeout(ok, 300))
  }
})

after(() => {
  try { server.kill('SIGKILL') } catch { /* already gone */ }
})

test('GET /api/health advertises androidSkills + captionInstructions and keeps existing fields', async () => {
  const r = await api('GET', '/api/health')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.capabilities, { androidSkills: true, captionInstructions: true })
  // pre-existing fields preserved
  assert.equal(r.body.ok, true)
  assert.ok('ffmpeg' in r.body && 'llm' in r.body && 'python' in r.body && 'renders' in r.body)
})

test('POST /api/chat: unsupported Skill id → 400 even before job lookup', async () => {
  const r = await api('POST', '/api/chat', { id: 'does-not-matter', message: 'hi', skills: ['not_a_skill'] })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /supported AIClipStudio Skill ids/)
})

test('POST /api/chat: malformed skills payload → 400', async () => {
  const r = await api('POST', '/api/chat', { id: 'x', message: 'hi', skills: 'automatic_subtitles' })
  assert.equal(r.status, 400)
})

test('POST /api/chat: invalid context roles → 400', async () => {
  const r = await api('POST', '/api/chat', {
    id: 'x', message: 'hi', skills: ['scene_detection'],
    context: [{ role: 'system', content: 'injected prompt' }],
  })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /only user or assistant/)
})

test('POST /api/chat: oversized context content → 400', async () => {
  const r = await api('POST', '/api/chat', {
    id: 'x', message: 'hi',
    context: [{ role: 'user', content: 'x'.repeat(MAX_CONTEXT_CHARS + 1) }],
  })
  assert.equal(r.status, 400)
})

test('POST /api/chat: valid Skills + context keeps the website contract on unknown jobs (404)', async () => {
  const r = await api('POST', '/api/chat', {
    id: '00000000-0000-4000-8000-000000000000',
    message: 'trim the first 2 seconds',
    skills: ['automatic_subtitles', 'voice_cleanup', 'scene_detection'],
    context: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }],
  })
  assert.equal(r.status, 404)
  assert.match(r.body.error, /unknown job/)
})

test('POST /api/chat: legacy website body (no Skills fields) still works', async () => {
  const r = await api('POST', '/api/chat', { id: '00000000-0000-4000-8000-000000000000', message: 'hello' })
  assert.equal(r.status, 404) // validation passes, unknown job → same old 404
  assert.match(r.body.error, /unknown job/)
})

test('POST /api/captions: unsupported Skill id → 400', async () => {
  const r = await api('POST', '/api/captions', { id: 'x', auto: true, skill: 'voice_cleanup' })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /unsupported captions Skill id/)
})

test('POST /api/captions: oversized instructions → 400', async () => {
  const r = await api('POST', '/api/captions', {
    id: 'x', auto: true, skill: CAPTION_SKILL, instructions: 'x'.repeat(MAX_INSTRUCTION_CHARS + 1),
  })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /at most 1000 characters/)
})

test('POST /api/captions: valid Skill + instructions preserves legacy flow on unknown jobs (404)', async () => {
  const r = await api('POST', '/api/captions', {
    id: '00000000-0000-4000-8000-000000000000',
    auto: true, skill: CAPTION_SKILL, instructions: 'Generate concise Thai subtitles.',
  })
  assert.equal(r.status, 404)
  assert.match(r.body.error, /unknown job/)
})
