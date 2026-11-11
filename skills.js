// ---------------------------------------------------------------------------
// skills.js — Native Android "selectable Skills" API contract (pure logic).
// Backing the AIClipStudio-skills-api.md extension used by FirstMobileApp:
//   • POST /api/chat gains optional `skills` (allowlisted IDs) and `context`
//     (bounded user/assistant turns) fields.
//   • POST /api/captions gains an optional bounded `instructions` string and
//     the stable `automatic_subtitles` Skill id.
// Kept free of I/O so the server's route validation is unit-testable.
// ---------------------------------------------------------------------------

// Stable Skill IDs the Android client may select. Adding a new Skill here also
// requires wiring it to REAL backend behavior (tools / caption pipeline) and
// an AI-planner context entry — never advertise unimplemented Skills.
const SKILL_IDS = Object.freeze(['automatic_subtitles', 'voice_cleanup', 'scene_detection'])
const ALLOWED_SKILLS = new Set(SKILL_IDS)

// The captions route only accepts the stable subtitles Skill id.
const CAPTION_SKILL = 'automatic_subtitles'

// Contract bounds (AIClipStudio-skills-api.md).
const MAX_SKILLS = 3
const MAX_CONTEXT_MESSAGES = 12
const MAX_CONTEXT_CHARS = 2000
const MAX_INSTRUCTION_CHARS = 1000

// GET /api/health advertises these only when the corresponding behavior is
// actually implemented (both are, once these route changes ship). Older
// deployments omit the field, so the Android app can fail loudly with its
// "update the server" message instead of silently ignoring Skill context.
const HEALTH_CAPABILITIES = Object.freeze({
  androidSkills: true,
  captionInstructions: true,
})

// POST /api/chat — `skills` must be an array of at most MAX_SKILLS known IDs.
// Returns null when valid, else a client-safe error string (HTTP 400).
function validateSkillList(skills) {
  if (!Array.isArray(skills)) return 'skills must be an array of Skill ids'
  if (skills.length > MAX_SKILLS) return `skills must contain at most ${MAX_SKILLS} entries`
  for (const s of skills) {
    if (typeof s !== 'string' || !ALLOWED_SKILLS.has(s)) {
      return 'skills must contain only supported AIClipStudio Skill ids'
    }
  }
  return null
}

// POST /api/chat — `context` must be an array of at most 12 recent turns,
// each with a user/assistant role and ≤ 2000 characters of string content.
// Returns null when valid, else a client-safe error string (HTTP 400).
function validateConversationContext(context) {
  if (!Array.isArray(context)) return 'context must be an array of user/assistant messages'
  if (context.length > MAX_CONTEXT_MESSAGES) {
    return `context must contain at most ${MAX_CONTEXT_MESSAGES} messages`
  }
  for (const turn of context) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
      return 'context entries must be {role, content} objects'
    }
    if (turn.role !== 'user' && turn.role !== 'assistant') {
      return 'context roles must be only user or assistant'
    }
    if (typeof turn.content !== 'string' || turn.content.length > MAX_CONTEXT_CHARS) {
      return `context message content must be a string of at most ${MAX_CONTEXT_CHARS} characters`
    }
  }
  return null
}

// POST /api/captions — `skill` (when present) must be the stable subtitles
// Skill id; `instructions` must be a string of at most 1000 characters.
// Returns null when valid, else a client-safe error string (HTTP 400).
function validateCaptionInput(skill, instructions) {
  if (skill != null && skill !== CAPTION_SKILL) return 'unsupported captions Skill id'
  if (typeof instructions !== 'string' || instructions.length > MAX_INSTRUCTION_CHARS) {
    return `instructions must be a string of at most ${MAX_INSTRUCTION_CHARS} characters`
  }
  return null
}

module.exports = {
  SKILL_IDS, ALLOWED_SKILLS, CAPTION_SKILL,
  MAX_SKILLS, MAX_CONTEXT_MESSAGES, MAX_CONTEXT_CHARS, MAX_INSTRUCTION_CHARS,
  HEALTH_CAPABILITIES,
  validateSkillList, validateConversationContext, validateCaptionInput,
}
