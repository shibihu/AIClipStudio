/* app.js — AI Clip Studio frontend */
const $ = (id) => document.getElementById(id)

const drop = $('drop'), video = $('video'), chat = $('chat'), form = $('chatForm'),
  input = $('chatInput'), sendBtn = $('sendBtn'), thinking = $('thinking'),
  playerWrap = $('playerWrap'), metaRow = $('metaRow'), downloadBtn = $('downloadBtn'),
  dlOriginal = $('dlOriginal'),   newBtn = $('newBtn'), engineBadge = $('engineBadge'), deleteBtn = $('deleteBtn')

let jobId = null
let busy = false

fetch('/api/health').then(r => r.json()).then(h => {
  if (h.aiKey) engineBadge.textContent = '🧠 LLM engine'
}).catch(() => {})

/* ---------- upload ---------- */

drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over') })
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over')
  const f = e.dataTransfer.files[0]
  if (f) upload(f)
})
drop.addEventListener('click', () => drop.querySelector('input')?.click() ?? dropInput().click())

let fileInput = null
function dropInput() {
  if (fileInput) return fileInput
  fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'video/*,audio/*'
  fileInput.addEventListener('change', () => fileInput.files[0] && upload(fileInput.files[0]))
  drop.appendChild(fileInput)
  return fileInput
}

async function upload(file) {
  busy = true; sendBtn.disabled = true
  const note = addMsg('ai', `⬆️ Uploading <b>${esc(file.name)}</b> …`)
  note.textContent = `⬆️ Uploading ${file.name} (${fmtMB(file.size)}) …`
  const fd = new FormData()
  fd.append('file', file)
  try {
    const r = await fetch('/api/upload', { method: 'POST', body: fd })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || 'upload failed')
    jobId = j.id
    note.remove()
    showMedia(j.url, j.meta, j.original)
    addMsg('ai', `Loaded <b>${esc(j.original)}</b> — ${describeMeta(j.meta)}.\nTell me what to change 👇`)
  } catch (e) {
    note.textContent = `❌ ${e.message}`
  } finally {
    busy = false; sendBtn.disabled = false
  }
}

function showMedia(url, meta, original) {
  playerWrap.classList.remove('hidden')
  drop.classList.add('hidden')
  deleteBtn.hidden = false
  video.src = url
  metaRow.innerHTML = [
    duration(meta), `${meta.width || '?'}×${meta.height || '?'}`,
    meta.hasAudio ? '🔊 audio' : '🔇 no audio', `${meta.fps || '?'} fps`,
  ].map(t => `<span class="chip">${t}</span>`).join('')
  downloadBtn.href = url
  downloadBtn.hidden = false
  downloadBtn.textContent = '⬇ Download ' + (original ? base(original) : 'result')
  dlOriginal.hidden = false
  dlOriginal.href = history_().first
  video.load(); video.play().catch(() => {})
}

let firstUrl = null
function history_() { return { first: firstUrl } }
const _origShow = showMedia
showMedia = function (url, meta, original) {
  // remember first version so users can jump back
  if (!jobId || !firstUrl) firstUrl = url
  return _origShow(url, meta, original)
}

newBtn.addEventListener('click', () => location.reload())

deleteBtn.addEventListener('click', async () => {
  if (!jobId) return
  if (!confirm('Delete this clip and all its versions? This cannot be undone.')) return
  try { await fetch(`/api/job?id=${encodeURIComponent(jobId)}`, { method: 'DELETE' }) } catch { /* keep going */ }
  location.reload()
})

/* ---------- chat ---------- */

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = input.value.trim()
  if (!text || busy) return
  if (!jobId) { addMsg('ai', '⬆️ Upload a clip first — drop any video (or audio) file on the left.') ; return }
  send(text)
})

document.querySelectorAll('.chips button').forEach(b =>
  b.addEventListener('click', () => {
    if (!jobId) { addMsg('ai', '⬆️ Upload a clip first — drop any video file on the left.'); return }
    send(b.dataset.q)
  })
)

async function send(text) {
  addMsg('user', esc(text))
  input.value = ''
  busy = true; sendBtn.disabled = true
  thinking.classList.remove('hidden')
  chat.scrollTop = chat.scrollHeight
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: jobId, message: text }),
    })
    const j = await r.json()
    if (j.error) throw new Error(j.error)
    let html = md(j.reply)
    if (j.ops && j.ops.length) html = `<span class="ops">🔧 ${j.ops.map(esc).join(' + ')}</span>\n` + html
    addMsg('ai', html, j.error)
    if (j.media && j.media.url) {
      showMedia(j.media.url, j.media)
      metaRow.insertAdjacentHTML('afterbegin', `<span class="chip"><b>${esc(j.summary || 'edited')}</b></span>`)
    }
  } catch (e) {
    addMsg('ai', '⚠️ ' + e.message, true)
  } finally {
    busy = false; sendBtn.disabled = false
    thinking.classList.add('hidden')
    chat.scrollTop = chat.scrollHeight
  }
}

/* ---------- small render helpers ---------- */

function addMsg(role, html, isError) {
  const el = document.createElement('div')
  el.className = 'msg ' + role + (isError ? ' error' : '')
  el.innerHTML = html
  chat.appendChild(el)
  chat.scrollTop = chat.scrollHeight
  return el
}

function md(text) {
  // escape then render `code` spans and newlines
  const escd = esc(text)
  return escd.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function describeMeta(m) {
  const bits = []
  if (m.duration) bits.push(m.duration + 's')
  if (m.width) bits.push(`${m.width}×${m.height}`)
  bits.push(m.hasAudio ? 'with audio' : 'silent')
  return bits.join(', ')
}

function duration(m) {
  return m.duration ? `<b>${m.duration}s</b>` : '<b>?</b>'
}

function fmtMB(bytes) {
  return bytes > 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB'
}

function base(p) { return String(p).split(/[\\/]/).pop() }
