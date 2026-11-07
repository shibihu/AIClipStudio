/* app.js — AI Clip Studio frontend */
const $ = (id) => document.getElementById(id)

const drop = $('drop'), video = $('video'), chat = $('chat'), form = $('chatForm'),
  input = $('chatInput'), sendBtn = $('sendBtn'), thinking = $('thinking'),
  playerWrap = $('playerWrap'), metaRow = $('metaRow'), downloadBtn = $('downloadBtn'),
  dlOriginal = $('dlOriginal'), newBtn = $('newBtn'), engineBadge = $('engineBadge'),
  deleteBtn = $('deleteBtn'), versionStrip = $('versionStrip'),
  projectsBtn = $('projectsBtn'), projectsModal = $('projectsModal'), projList = $('projList'),
  projClose = $('projClose'), authGate = $('authGate'), authForm = $('authForm'),
  authTokenInput = $('authToken'), authErr = $('authErr'),
  trimWrap = $('trimWrap'), trimStrip = $('trimStrip'), stripImg = $('stripImg'),
  trimRange = $('trimRange'), trimIn = $('trimIn'), trimOut = $('trimOut'),
  tLabelA = $('tLabelA'), tLabelB = $('tLabelB'),
  trimApply = $('trimApply'), trimClear = $('trimClear'),
  capChip = $('capChip'), capWrap = $('capWrap'), capText = $('capText'), capSend = $('capSend'), capAuto = $('capAuto')

let jobId = null
let busy = false
let versions = []      // [{name, desc, thumb, meta}] mirrors the server
let base = 0
let previewIdx = null  // version shown in the player
let stripDur = null    // filmstrip duration
let tA = 0, tB = 1     // trim handles, fractions of the strip
let dragHandle = null

/* ---------- auth (only active when the server sets AUTH_TOKEN) ---------- */

function authHeaders() {
  return { 'x-auth-token': localStorage.getItem('auth') || '' }
}

async function fetchA(url, opts = {}) {
  opts.headers = { ...authHeaders(), ...(opts.headers || {}) }
  const r = await fetch(url, opts)
  if (r.status === 401) { authGate.classList.remove('hidden'); throw new Error('locked — enter the access token') }
  return r
}

// boot: probe health; show the gate if the server is locked
;(async () => {
  try {
    const r = await fetch('/api/health', { headers: authHeaders() })
    if (r.status === 401) { authGate.classList.remove('hidden'); return }
    const h = await r.json()
    updateEngineBadge(h)
  } catch { /* server down — everything else will error visibly */ }
})()

function updateEngineBadge(h) {
  if (!h) return
  if (h.aiKey) {
    if (h.llm && h.llm.reachable === false && Date.now() - (h.llm.lastErrorAt || 0) < 5 * 60000) {
      engineBadge.textContent = '⚠ LLM offline → local engine'
      engineBadge.classList.add('warn')
      engineBadge.title = 'The LLM provider is unreachable right now; the built-in rule engine is answering. ' + (h.llm.lastError || '')
    } else {
      engineBadge.textContent = h.ai ? `🧠 ${h.ai.provider}` : '🧠 LLM engine'
      if (h.ai) engineBadge.title = `Using ${h.ai.provider} — ${h.ai.model}`
    }
  }
  if (h.renders && h.renders.queued) engineBadge.title = `${h.renders.queued} render(s) queued`
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  authErr.textContent = ''
  try {
    const r = await fetch('/api/auth', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: authTokenInput.value }),
    })
    const j = await r.json()
    if (r.ok && j.ok) {
      localStorage.setItem('auth', authTokenInput.value)
      authTokenInput.value = ''
      location.reload()
    } else {
      authErr.textContent = j.error || 'wrong token'
    }
  } catch {
    authErr.textContent = 'server unreachable'
  }
})

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
  const note = addMsg('ai', `⬆️ Uploading <b>${esc(file.name)}</b> (${fmtMB(file.size)}) …`)
  const fd = new FormData()
  fd.append('file', file)
  try {
    const r = await fetchA('/api/upload', { method: 'POST', body: fd })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || 'upload failed')
    jobId = j.id
    note.remove()
    previewIdx = 0
    dlOriginal.href = j.url
    dlOriginal.hidden = false
    showMedia(j.url, j.meta, j.original)
    addMsg('ai', `Loaded <b>${esc(j.original)}</b> — ${describeMeta(j.meta)}.\nTell me what to change 👇`)
    await loadVersions()
    loadStrip(j.url.split('/').pop(), j.meta)
  } catch (e) {
    note.textContent = `❌ ${e.message}`
  } finally {
    busy = false; sendBtn.disabled = false
  }
}

function showMedia(url, meta, label) {
  playerWrap.classList.remove('hidden')
  drop.classList.add('hidden')
  deleteBtn.hidden = false
  video.src = url
  if (meta) {
    metaRow.innerHTML = [
      meta.duration ? `<b>${fmtTime(meta.duration)}</b>` : '<b>?</b>', `${meta.width || '?'}×${meta.height || '?'}`,
      meta.hasAudio ? '🔊 audio' : '🔇 no audio', `${meta.fps || '?'} fps`,
    ].map(t => `<span class="chip">${t}</span>`).join('')
  }
  downloadBtn.href = url
  downloadBtn.hidden = false
  downloadBtn.textContent = '⬇ ' + (label ? `Download ${label}` : 'Download result')
  video.load(); video.play().catch(() => {})
}

newBtn.addEventListener('click', () => location.reload())

deleteBtn.addEventListener('click', async () => {
  if (!jobId) return
  if (!confirm('Delete this clip and all its versions? This cannot be undone.')) return
  try { await fetchA(`/api/job?id=${encodeURIComponent(jobId)}`, { method: 'DELETE' }) } catch { /* keep going */ }
  location.reload()
})

/* ---------- version strip ---------- */

async function loadVersions() {
  if (!jobId) return
  let j
  try {
    j = await (await fetchA(`/api/job?id=${encodeURIComponent(jobId)}`)).json()
  } catch { return }
  if (j.error) return
  versions = j.versions || []
  base = j.base ?? versions.length - 1
  versionStrip.classList.toggle('hidden', versions.length < 2)
  versionStrip.innerHTML = ''
  versions.forEach((v, i) => {
    const el = document.createElement('div')
    el.className = 'vthumb' + (i === previewIdx ? ' active' : '')
    el.title = `v${i + 1}${v.desc ? ' — ' + v.desc : ''} (click to preview)`
    if (v.thumb) {
      const img = document.createElement('img')
      img.src = v.thumb
      img.alt = 'v' + (i + 1)
      img.loading = 'lazy'
      el.appendChild(img)
    } else {
      const ph = document.createElement('div')
      ph.className = 'ph'
      ph.textContent = '🎞'
      el.appendChild(ph)
    }
    const foot = document.createElement('div')
    foot.className = 'vfoot'
    const vnum = document.createElement('span')
    vnum.textContent = 'v' + (i + 1)
    foot.appendChild(vnum)
    if (i === base) {
      const star = document.createElement('span')
      star.className = 'vstar'
      star.title = 'base version — new edits start here'
      star.textContent = '★ base'
      foot.appendChild(star)
    } else if (i !== previewIdx) {
      const pin = document.createElement('span')
      pin.className = 'vbase'
      pin.title = 'pin as base — new edits will start from this version'
      pin.textContent = '★'
      pin.addEventListener('click', async (e) => {
        e.stopPropagation()
        try { await fetchA('/api/version', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: jobId, index: i }) }) } catch { return }
        base = i
        addMsg('ai', `📌 Base version set to <b>v${i + 1}</b> — next edits start there (older versions are kept).`)
        loadVersions()
      })
      foot.appendChild(pin)
    }
    el.appendChild(foot)
    el.addEventListener('click', () => previewVersion(i))
    versionStrip.appendChild(el)
  })
}

function previewVersion(i) {
  const v = versions[i]
  if (!v) return
  previewIdx = i
  showMedia(`/media/${jobId}/${encodeURIComponent(v.name)}`, v.meta, `v${i + 1}`)
  loadVersions()
  loadStrip(v.name, v.meta)
}

/* ---------- filmstrip / visual trim picker ---------- */

async function loadStrip(versionName, meta) {
  if (!jobId) return
  const q = versionName ? `&v=${encodeURIComponent(versionName)}` : ''
  try {
    const r = await fetchA(`/api/strip?id=${encodeURIComponent(jobId)}${q}`)
    const j = await r.json()
    if (!r.ok || j.error) { trimWrap.classList.add('hidden'); return }
    stripImg.src = j.url
    stripDur = j.duration || (meta && meta.duration) || null
    tA = 0; tB = 1; dragHandle = null
    trimWrap.classList.remove('hidden')
    updateTrim()
  } catch {
    trimWrap.classList.add('hidden')
  }
}

function updateTrim() {
  if (!stripDur) return
  const left = tA * 100, width = (tB - tA) * 100
  trimRange.style.left = left + '%'
  trimRange.style.width = width + '%'
  trimIn.style.left = `calc(${left}% - 5px)`
  trimOut.style.left = `calc(${tB * 100}% - 5px)`
  tLabelA.textContent = fmtTime(tA * stripDur)
  tLabelB.textContent = fmtTime(tB * stripDur)
  tLabelA.style.left = `clamp(0px, calc(${left}% - 14px), calc(100% - 42px))`
  tLabelB.style.left = `clamp(0px, calc(${tB * 100}% - 28px), calc(100% - 42px))`
}

trimStrip.addEventListener('pointerdown', (e) => {
  if (!stripDur) return
  e.preventDefault()
  if (!video.paused) video.pause()
  const rect = trimStrip.getBoundingClientRect()
  const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  dragHandle = Math.abs(t - tA) <= Math.abs(t - tB) ? 'a' : 'b'
  trimStrip.setPointerCapture(e.pointerId)
  applyDrag(t)
})
trimStrip.addEventListener('pointermove', (e) => {
  if (!dragHandle) return
  const rect = trimStrip.getBoundingClientRect()
  applyDrag(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)))
})
trimStrip.addEventListener('pointerup', () => {
  video.currentTime = (dragHandle === 'a' ? tA : tB) * stripDur
  dragHandle = null
})
trimStrip.addEventListener('pointercancel', () => { dragHandle = null })

function applyDrag(t) {
  const minGap = 0.02
  if (dragHandle === 'a') tA = Math.min(t, tB - minGap)
  else tB = Math.max(t, tA + minGap)
  tA = Math.max(0, tA); tB = Math.min(1, tB)
  video.currentTime = t * stripDur
  updateTrim()
}

trimApply.addEventListener('click', () => {
  if (!stripDur) return
  const a = tA * stripDur, b = tB * stripDur
  send(`keep from ${fmtTime(a)} to ${fmtTime(b)}`)
})
trimClear.addEventListener('click', () => { tA = 0; tB = 1; updateTrim() })

/* ---------- chat ---------- */

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const text = input.value.trim()
  if (!text || busy) return
  if (!jobId) { addMsg('ai', '⬆️ Upload a clip first — drop any video (or audio) file on the left.'); return }
  send(text)
})

document.querySelectorAll('.chips button').forEach(b =>
  b.addEventListener('click', () => {
    if (b.id === 'capChip') { capWrap.classList.toggle('hidden'); capText.focus(); return }
    if (!jobId) { addMsg('ai', '⬆️ Upload a clip first — drop any video file on the left.'); return }
    send(b.dataset.q)
  })
)

async function send(text) {
  if (!jobId || busy) return
  addMsg('user', esc(text))
  input.value = ''
  capWrap.classList.add('hidden')
  busy = true; sendBtn.disabled = true
  thinking.classList.remove('hidden')
  const holder = addMsg('ai', busyHTML('thinking…'))
  chat.scrollTop = chat.scrollHeight
  try {
    const r = await fetchA('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: jobId, message: text }),
    })
    const j = await r.json()
    if (j.error) throw new Error(j.error)
    if (j.renderId) {
      await pollRender(j, holder)
    } else {
      thinking.classList.add('hidden')
      holder.remove()
      finishReply(j)
    }
  } catch (e) {
    holder.remove()
    addMsg('ai', '⚠️ ' + e.message, true)
  } finally {
    busy = false; sendBtn.disabled = false
    thinking.classList.add('hidden')
    chat.scrollTop = chat.scrollHeight
  }
}

/* ---------- render polling (async renders + progress) ---------- */

function busyHTML(label) {
  return `<span class="dots"><span></span><span></span><span></span></span> ${esc(label)}
<div class="pbar"><div class="pfill"></div></div><div class="plab">…</div>`
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

async function pollRender(j, holder) {
  holder.innerHTML = `<div>${md(j.reply || '🛠 rendering…')}</div>\n` + busyHTML('ffmpeg is running')
  const lab = holder.querySelector('.plab')
  const fill = holder.querySelector('.pfill')
  chat.scrollTop = chat.scrollHeight
  let misses = 0
  for (;;) {
    await sleep(700)
    let s
    try {
      const r = await fetchA(`/api/render?id=${encodeURIComponent(jobId)}&rid=${encodeURIComponent(j.renderId)}`)
      if (r.status === 404) {
        s = { status: 'lost' }
      } else {
        s = await r.json() // {status: queued|running|done|failed, progress,...}
      }
      misses = 0
    } catch {
      if (++misses > 8) { s = { status: 'lost' } } else continue
    }
    if (s.status === 'queued') {
      lab.textContent = `⏳ queued${(s.queuedAhead ?? 0) ? ` — ${s.queuedAhead} render(s) ahead` : ''}`
    } else if (s.status === 'running') {
      fill.style.width = (s.progress || 0) + '%'
      lab.textContent = `ffmpeg running — ${s.progress || 0}%`
    } else if (s.status === 'done') {
      fill.style.width = '100%'
      holder.remove()
      finishReply({ ...j, ...s })
      if (s.media && s.media.url) {
        showMedia(s.media.url, s.media, s.summary || 'result')
        await loadVersions()
        previewIdx = versions.length - 1 // the new render is now the latest+base
        loadVersions()
        loadStrip(s.media.name)
      }
      break
    } else { // failed | lost
      holder.classList.add('error')
      holder.innerHTML = md(s.reply || '⚠️ render was lost (server restarted?) — send the edit again.')
      break
    }
  }
  chat.scrollTop = chat.scrollHeight
}

function finishReply(j) {
  let html = md(j.reply)
  if (j.ops && j.ops.length) html = `<span class="ops">🔧 ${j.ops.map(esc).join(' + ')}</span>\n` + html
  addMsg('ai', html, j.error)
  chat.scrollTop = chat.scrollHeight
}

/* ---------- captions ---------- */

capSend.addEventListener('click', async () => {
  const text = capText.value.trim()
  if (!jobId || !text || busy) return
  busy = true; sendBtn.disabled = true
  addMsg('user', esc(text.slice(0, 600)))
  capWrap.classList.add('hidden')
  const holder = addMsg('ai', busyHTML('timing captions to your speech…'))
  try {
    const r = await fetchA('/api/captions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: jobId, text }),
    })
    const j = await r.json()
    if (j.error) throw new Error(j.error)
    if (j.renderId) await pollRender(j, holder)
    else { holder.remove(); finishReply(j) }
  } catch (e) {
    holder.remove()
    addMsg('ai', '⚠️ ' + e.message, true)
  } finally {
    busy = false; sendBtn.disabled = false
    chat.scrollTop = chat.scrollHeight
  }
})

// one-click auto-transcribe → burn in the SPOKEN words, timed by the LLM
capAuto.addEventListener('click', async () => {
  if (!jobId || busy) { if (!jobId) addMsg('ai', '⬆️ Upload a clip first — auto-transcribe needs the clip\'s audio.'); return }
  busy = true; sendBtn.disabled = true
  addMsg('user', '🎙 Auto-transcribe captions')
  capWrap.classList.add('hidden')
  const holder = addMsg('ai', busyHTML('listening and transcribing the speech…'))
  try {
    const r = await fetchA('/api/captions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: jobId, auto: true }),
    })
    const j = await r.json()
    if (j.error) throw new Error(j.error)
    if (j.renderId) await pollRender(j, holder)
    else { holder.remove(); finishReply(j) }
  } catch (e) {
    holder.remove()
    addMsg('ai', '⚠️ ' + e.message, true)
  } finally {
    busy = false; sendBtn.disabled = false
    chat.scrollTop = chat.scrollHeight
  }
})

/* ---------- recent projects ---------- */

projectsBtn.addEventListener('click', openProjects)
projClose.addEventListener('click', () => projectsModal.classList.add('hidden'))
projectsModal.addEventListener('click', (e) => { if (e.target === projectsModal) projectsModal.classList.add('hidden') })

function age(ms) {
  const s = Math.max(1, (Date.now() - ms) / 1000)
  if (s < 3600) return Math.round(s / 60) + ' min ago'
  if (s < 86400) return Math.round(s / 3600) + ' h ago'
  return Math.round(s / 86400) + ' d ago'
}

async function openProjects() {
  projectsModal.classList.remove('hidden')
  projList.innerHTML = '<div class="projload">loading…</div>'
  let j
  try { j = await (await fetchA('/api/jobs')).json() } catch (e) { projList.innerHTML = `<div class="projload">⚠️ ${esc(e.message)}</div>`; return }
  projList.innerHTML = ''
  if (!j.jobs || !j.jobs.length) {
    projList.innerHTML = '<div class="projload">No saved projects yet — upload a clip and it will appear here.</div>'
    return
  }
  for (const pr of j.jobs) {
    const card = document.createElement('div')
    card.className = 'projcard'
    card.title = 'open this project'
    const thumb = document.createElement('div')
    thumb.className = 'pthumb'
    thumb.innerHTML = pr.thumb ? `<img src="${esc(pr.thumb)}" alt="" loading="lazy" />` : '<div class="ph">🎞</div>'
    const info = document.createElement('div')
    info.className = 'pinfo'
    info.innerHTML = `<b>${esc(String(pr.original || '').replace(/\.[^.]+$/, ''))}</b><span>${pr.versionCount} version${pr.versionCount === 1 ? '' : 's'}${pr.duration ? ' · ' + fmtTime(pr.duration) : ''} · ${age(pr.mtime)}</span>`
    const del = document.createElement('button')
    del.className = 'pdel'
    del.title = 'delete this project'
    del.textContent = '🗑'
    del.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm('Delete this project and all its versions?')) return
      try { await fetchA(`/api/job?id=${encodeURIComponent(pr.id)}`, { method: 'DELETE' }) } catch { return }
      card.remove()
    })
    card.append(thumb, info, del)
    card.addEventListener('click', () => { location.href = `/?id=${encodeURIComponent(pr.id)}` })
    projList.appendChild(card)
  }
}

/* ---------- restore a saved session (/?id=…) ---------- */

const restoreId = new URLSearchParams(location.search).get('id')
if (restoreId) restore(restoreId).catch(() => {})

async function restore(id) {
  try {
    const r = await fetchA(`/api/job?id=${encodeURIComponent(id)}`)
    const j = await r.json()
    if (j.error) { addMsg('ai', '⚠️ ' + esc(j.error), true); return }
    jobId = id
    history.replaceState(null, '', '/') // clean the ?id= out of the address bar
    versions = j.versions || []
    base = j.base ?? versions.length - 1
    if (!versions.length) { addMsg('ai', '⚠️ This project has no versions.'); return }
    const bv = versions[base]
    previewIdx = base
    showMedia(`/media/${jobId}/${encodeURIComponent(bv.name)}`, bv.meta, `v${base + 1}`)
    dlOriginal.href = `/media/${jobId}/${encodeURIComponent(versions[0].name)}`
    dlOriginal.hidden = false
    if (j.msgs && j.msgs.length) {
      addMsg('ai', '— previous conversation —')
      for (const m of j.msgs.slice(-16)) {
        addMsg(m.role === 'user' ? 'user' : 'ai', m.role === 'user' ? esc(m.content).replace(/\n/g, '<br>') : md(m.content))
      }
    }
    addMsg('ai', `📂 Project restored — <b>v${base + 1}</b> is the pinned base (${versions.length} version${versions.length === 1 ? '' : 's'} kept). What's next?`)
    await loadVersions()
    loadStrip(bv.name, bv.meta)
  } catch (e) {
    addMsg('ai', '⚠️ Could not restore the project — ' + esc(e.message), true)
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
  if (m.duration) bits.push(fmtTime(m.duration))
  if (m.width) bits.push(`${m.width}×${m.height}`)
  bits.push(m.hasAudio ? 'with audio' : 'silent')
  return bits.join(', ')
}

function fmtTime(s) {
  const t = Math.max(0, +s || 0)
  const m = Math.floor(t / 60)
  const sec = Math.round(t % 60)
  return `${m}:${String(sec % 60).padStart(2, '0')}`
}

function fmtMB(bytes) {
  return bytes > 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB'
}
