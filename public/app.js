const $ = (id) => document.getElementById(id)

const store = {
  get (key, fallback) {
    try {
      const value = localStorage.getItem(`fx.${key}`)

      return value === null ? fallback : JSON.parse(value)
    } catch (error) {
      return fallback
    }
  },
  set (key, value) {
    try {
      localStorage.setItem(`fx.${key}`, JSON.stringify(value))
    } catch (error) {}
  }
}

const PAGE_SIZE = 200
const FAVORITE = 'favorite'
const MIME_TYPES = {
  wav: 'audio/wav', mp3: 'audio/mpeg', aif: 'audio/aiff', aiff: 'audio/aiff', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus', flac: 'audio/flac', m4a: 'audio/mp4', wma: 'audio/x-ms-wma'
}

const state = {
  q: store.get('q', ''),
  sort: store.get('sort', 'name'),
  order: store.get('order', 'asc'),
  files: [],
  total: 0,
  loading: false,
  request: 0,
  selected: -1,
  playing: null,
  status: null
}

const audio = new Audio()

// ---------- helpers

async function api (url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`)

  return data
}

function esc (text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function formatSize (bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }

  return `${unit ? value.toFixed(1) : value} ${units[unit]}`
}

function formatClock (seconds) {
  if (!Number.isFinite(seconds)) return '0:00'

  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')

  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function formatDuration (seconds) {
  if (seconds === null || seconds === undefined) return '...'
  if (seconds === 0) return '0 s'
  if (seconds < 10) return `${seconds.toFixed(2)} s`
  if (seconds < 60) return `${seconds.toFixed(1)} s`

  return formatClock(seconds)
}

function formatLongDuration (seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)

  if (seconds < 60) return `${Math.round(seconds)} s`

  return h ? `${h} h ${m} min` : `${m} min`
}

function formatChannels (channels) {
  return { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' }[channels] || (channels ? `${channels} ch` : '')
}

function formatInfo (file) {
  return [
    file.ext.toUpperCase(),
    file.sampleRate && `${+(file.sampleRate / 1000).toFixed(1)} kHz`,
    file.bits && `${file.bits}-bit`,
    formatChannels(file.channels)
  ].filter(Boolean).join(' · ')
}

function formatDate (ms) {
  return new Date(ms).toLocaleString(undefined, { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

let toastTimer = null

function toast (message, isError = false) {
  const element = $('toast')

  element.textContent = message
  element.classList.toggle('error', isError)
  element.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { element.hidden = true }, isError ? 5000 : 2500)
}

function gain () {
  const volume = parseInt($('volume').value, 10) / 100

  // Squared so the slider feels linear to the ear
  return volume * volume
}

function isFavorite (file) {
  return file.tags.some((tag) => !tag.auto && tag.name.toLowerCase() === FAVORITE)
}

function canPlay (file) {
  return audio.canPlayType(MIME_TYPES[file.ext] || '') !== ''
}

function streamUrl (file, transcode = !canPlay(file)) {
  return `/api/files/${file.id}/stream${transcode ? '?transcode=1' : ''}`
}

async function copyText (text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch (error) {
    // The clipboard API needs https, fallback for plain http on the LAN
    const area = document.createElement('textarea')

    area.value = text
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }

  toast('Path copied')
}

function triggerDownload (url, name) {
  const link = document.createElement('a')

  link.href = url
  if (name) link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
}

// ---------- list

function renderRow (file, index) {
  const folders = file.dir ? file.dir.split('/') : []
  const userTags = file.tags.filter((tag) => !tag.auto && tag.name.toLowerCase() !== FAVORITE)
  const isPlaying = state.playing && state.playing.id === file.id
  const classes = [index === state.selected && 'selected', isPlaying && 'playing'].filter(Boolean).join(' ')

  return `<tr data-index="${index}" class="${classes}" draggable="true">
    <td>
      <button class="icon play-btn" data-action="play" title="Play"><svg><use href="#i-${isPlaying && !audio.paused ? 'pause' : 'play'}"/></svg></button>
      <button class="icon ${isFavorite(file) ? 'starred' : ''}" data-action="star" title="Favorite (F)"><svg><use href="#i-star"/></svg></button>
    </td>
    <td>
      <div class="name ellipsis" title="${esc(file.name)}">${esc(file.name)}</div>
      <div class="meta">
        ${folders.map((folder) => `<span class="folder" data-action="tag" data-tag="${esc(folder)}" title="Filter on this folder">${esc(folder)}</span>`).join('<span class="sep">/</span>')}
        ${userTags.map((tag) => `<span class="chip" data-action="tag" data-tag="${esc(tag.name)}">${esc(tag.name)}<span class="remove" data-action="remove-tag" data-tag="${esc(tag.name)}" title="Remove tag">&times;</span></span>`).join('')}
        <button class="icon add-tag" data-action="add-tag" title="Add a tag"><svg><use href="#i-tag"/></svg></button>
      </div>
    </td>
    <td class="num" title="${file.probed && file.duration === null ? 'ffprobe could not read this file' : ''}">${file.probed && file.duration === null ? '?' : formatDuration(file.duration)}</td>
    <td class="format ellipsis" title="${esc(file.codec || '')}">${esc(formatInfo(file))}</td>
    <td class="num" title="${file.size} bytes">${formatSize(file.size)}</td>
    <td class="date">${formatDate(file.mtime)}</td>
    <td class="actions">
      <button class="icon" data-action="edit" title="Cut / convert (E)"><svg><use href="#i-cut"/></svg></button>
      <button class="icon" data-action="download" title="Download (D)"><svg><use href="#i-download"/></svg></button>
      <button class="icon" data-action="copy" title="Copy the path"><svg><use href="#i-copy"/></svg></button>
      <button class="icon danger" data-action="delete" title="Delete (Del)"><svg><use href="#i-trash"/></svg></button>
    </td>
  </tr>`
}

function render () {
  $('files').innerHTML = state.files.map(renderRow).join('')
  renderFooter()
}

function updateRow (index) {
  const row = $('files').querySelector(`tr[data-index="${index}"]`)

  if (row) row.outerHTML = renderRow(state.files[index], index)
}

function renderFooter () {
  const remaining = state.total - state.files.length

  $('sentinel').textContent = state.loading ? 'Loading...' : remaining > 0 ? `${remaining} more` : state.total ? '' : 'No file found'
}

function renderSortHeaders () {
  $('sort').value = state.sort
  $('order').textContent = state.order === 'asc' ? 'Ascending' : 'Descending'

  for (const th of document.querySelectorAll('th[data-sort]')) {
    const sorted = th.dataset.sort === state.sort

    th.classList.toggle('sorted', sorted)
    th.dataset.arrow = sorted ? (state.order === 'asc' ? ' ↑' : ' ↓') : ''
    th.textContent = th.textContent.replace(/ [↑↓]$/, '') + th.dataset.arrow
  }
}

async function load (reset = true) {
  if (!reset && (state.loading || state.files.length >= state.total)) return

  const request = ++state.request
  const params = new URLSearchParams({
    q: state.q,
    sort: state.sort,
    order: state.order,
    offset: reset ? 0 : state.files.length,
    limit: PAGE_SIZE
  })

  state.loading = true
  renderFooter()

  try {
    const data = await api(`/api/files?${params}`)

    // A newer request was sent while this one was running
    if (request !== state.request) return

    $('summary').textContent = `${data.total} files · ${formatSize(data.totalSize)} · ${formatLongDuration(data.totalDuration)}`
    state.total = data.total

    if (reset) {
      state.files = data.files
      state.selected = -1
      render()
      window.scrollTo(0, 0)
    } else {
      const start = state.files.length

      state.files.push(...data.files)
      $('files').insertAdjacentHTML('beforeend', data.files.map((file, i) => renderRow(file, start + i)).join(''))
    }
  } catch (error) {
    toast(error.message, true)
  } finally {
    if (request === state.request) {
      state.loading = false
      renderFooter()
    }
  }
}

function setQuery (q) {
  state.q = q
  $('search').value = q
  store.set('q', q)
  load()
}

function addToQuery (term) {
  if (!state.q.includes(term)) setQuery(`${state.q} ${term}`.trim())
}

function setSort (sort, order) {
  state.sort = sort
  state.order = order
  store.set('sort', sort)
  store.set('order', order)
  renderSortHeaders()
  load()
}

// ---------- selection and playback

function select (index, { play = $('autoplay').checked } = {}) {
  if (index < 0 || index >= state.files.length) return

  const rows = $('files')
  const previous = rows.querySelector('tr.selected')

  if (previous) previous.classList.remove('selected')

  state.selected = index

  const row = rows.querySelector(`tr[data-index="${index}"]`)

  if (row) {
    row.classList.add('selected')
    row.scrollIntoView({ block: 'nearest' })
  }

  if (play) playFile(state.files[index])
}

function selectedFile () {
  return state.files[state.selected] || null
}

function refreshPlayingRow () {
  for (const row of $('files').querySelectorAll('tr.playing')) {
    row.classList.remove('playing')
    row.querySelector('.play-btn use').setAttribute('href', '#i-play')
  }

  if (!state.playing) return

  const index = state.files.findIndex((file) => file.id === state.playing.id)
  const row = $('files').querySelector(`tr[data-index="${index}"]`)

  if (row) {
    row.classList.add('playing')
    row.querySelector('.play-btn use').setAttribute('href', audio.paused ? '#i-play' : '#i-pause')
  }

  $('play').querySelector('use').setAttribute('href', audio.paused ? '#i-play' : '#i-pause')
}

function playFile (file) {
  if (typeof stopEditorPlayback === 'function') stopEditorPlayback()

  state.playing = file
  audio.dataset.transcoded = canPlay(file) ? '' : '1'
  audio.src = streamUrl(file)
  audio.play().catch(() => {})
  $('length').textContent = formatClock(file.duration)
  $('now-name').textContent = file.path
  $('now-name').classList.remove('muted')
  refreshPlayingRow()
}

function togglePlay () {
  const file = selectedFile()

  if (file && (!state.playing || state.playing.id !== file.id)) return playFile(file)
  if (!state.playing) return

  if (audio.paused) audio.play().catch(() => {})
  else audio.pause()
}

function stopMainPlayback () {
  audio.pause()
}

audio.addEventListener('play', refreshPlayingRow)
audio.addEventListener('pause', refreshPlayingRow)
audio.addEventListener('ended', refreshPlayingRow)
// A transcoded stream has no known duration, use the one from the database
function playingDuration () {
  return Number.isFinite(audio.duration) ? audio.duration : (state.playing && state.playing.duration) || 0
}

audio.addEventListener('loadedmetadata', () => {
  $('length').textContent = formatClock(playingDuration())
  $('seek').disabled = !Number.isFinite(audio.duration)
})
audio.addEventListener('timeupdate', () => {
  const length = playingDuration()

  $('time').textContent = formatClock(audio.currentTime)

  if (!seeking && length) $('seek').value = Math.min(1000, Math.round((audio.currentTime / length) * 1000))
})

// Some wav files use codecs the browser does not know (ADPCM...), ask the server for an mp3
audio.addEventListener('error', () => {
  if (!state.playing || audio.dataset.transcoded) return

  audio.dataset.transcoded = '1'
  audio.src = streamUrl(state.playing, true)
  audio.play().catch(() => {})
})

let seeking = false

$('seek').addEventListener('input', () => {
  seeking = true

  $('time').textContent = formatClock(($('seek').value / 1000) * playingDuration())
})

$('seek').addEventListener('change', () => {
  seeking = false

  if (audio.duration && Number.isFinite(audio.duration)) audio.currentTime = ($('seek').value / 1000) * audio.duration
})

$('play').addEventListener('click', togglePlay)

function applyVolume () {
  $('volume-value').textContent = `${$('volume').value}%`
  audio.volume = gain()

  if (typeof applyEditorVolume === 'function') applyEditorVolume()
}

$('volume').value = store.get('volume', 70)
$('volume').addEventListener('input', () => {
  store.set('volume', parseInt($('volume').value, 10))
  applyVolume()
})

audio.loop = store.get('loop', false)
$('loop').classList.toggle('on', audio.loop)
$('loop').addEventListener('click', () => {
  audio.loop = !audio.loop
  store.set('loop', audio.loop)
  $('loop').classList.toggle('on', audio.loop)
})

$('autoplay').checked = store.get('autoplay', true)
$('autoplay').addEventListener('change', () => store.set('autoplay', $('autoplay').checked))

// ---------- actions

async function toggleFavorite (index) {
  const file = state.files[index]
  const favorite = file.tags.find((tag) => !tag.auto && tag.name.toLowerCase() === FAVORITE)

  try {
    state.files[index] = favorite
      ? await api(`/api/files/${file.id}/tags/${encodeURIComponent(favorite.name)}`, { method: 'DELETE' })
      : await api(`/api/files/${file.id}/tags`, { method: 'POST', body: JSON.stringify({ tag: FAVORITE }) })
    updateRow(index)
  } catch (error) {
    toast(error.message, true)
  }
}

async function addTag (index) {
  const file = state.files[index]
  const tag = (prompt(`Tag for ${file.name}`) || '').trim()

  if (!tag) return

  try {
    state.files[index] = await api(`/api/files/${file.id}/tags`, { method: 'POST', body: JSON.stringify({ tag }) })
    updateRow(index)
  } catch (error) {
    toast(error.message, true)
  }
}

async function removeTag (index, tag) {
  const file = state.files[index]

  try {
    state.files[index] = await api(`/api/files/${file.id}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' })
    updateRow(index)
  } catch (error) {
    toast(error.message, true)
  }
}

async function deleteFile (index) {
  const file = state.files[index]
  const where = state.status && state.status.trash ? 'It will be moved to the trash folder.' : 'This cannot be undone.'

  if (!confirm(`Delete ${file.name}?\n${where}`)) return

  try {
    await api(`/api/files/${file.id}`, { method: 'DELETE' })

    if (state.playing && state.playing.id === file.id) {
      audio.pause()
      audio.removeAttribute('src')
      state.playing = null
    }

    state.files.splice(index, 1)
    state.total--
    state.selected = Math.min(index, state.files.length - 1)
    render()
    select(state.selected, { play: false })
    toast(`${file.name} deleted`)
  } catch (error) {
    toast(error.message, true)
  }
}

function runAction (action, index, element) {
  const file = state.files[index]

  switch (action) {
    case 'play':
      if (state.playing && state.playing.id === file.id) {
        select(index, { play: false })
        togglePlay()
      } else {
        select(index, { play: true })
      }
      break
    case 'star': return toggleFavorite(index)
    case 'tag': return addToQuery(`tag:"${element.dataset.tag.replace(/"/g, '')}"`)
    case 'remove-tag': return removeTag(index, element.dataset.tag)
    case 'add-tag': return addTag(index)
    case 'edit': return openEditor(file)
    case 'download': return triggerDownload(`/api/files/${file.id}/download`)
    case 'copy': return copyText(`${(state.status && state.status.copyPathPrefix) || ''}${file.path}`)
    case 'delete': return deleteFile(index)
  }
}

$('files').addEventListener('click', (event) => {
  const row = event.target.closest('tr')

  if (!row) return

  const index = parseInt(row.dataset.index, 10)
  const target = event.target.closest('[data-action]')

  if (target) {
    event.stopPropagation()
    return runAction(target.dataset.action, index, target)
  }

  select(index)
})

// Drag a row out of the browser to save the file (Chrome based browsers)
$('files').addEventListener('dragstart', (event) => {
  const row = event.target.closest('tr')
  const file = row && state.files[parseInt(row.dataset.index, 10)]

  if (!file) return

  const url = `${location.origin}/api/files/${file.id}/download`

  event.dataTransfer.setData('DownloadURL', `${MIME_TYPES[file.ext] || 'application/octet-stream'}:${file.name}:${url}`)
  event.dataTransfer.setData('text/uri-list', url)
})

// ---------- search, sort, infinite scroll

let searchTimer = null

$('search').value = state.q
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => setQuery($('search').value), 250)
})

$('help-toggle').addEventListener('click', () => { $('help').hidden = !$('help').hidden })

$('favorites').addEventListener('click', () => {
  const term = `tag:${FAVORITE}`

  setQuery(state.q.includes(term) ? state.q.replace(term, '').trim() : `${state.q} ${term}`.trim())
})

$('sort').addEventListener('change', () => setSort($('sort').value, state.order))
$('order').addEventListener('click', () => setSort(state.sort, state.order === 'asc' ? 'desc' : 'asc'))

for (const th of document.querySelectorAll('th[data-sort]')) {
  th.addEventListener('click', () => {
    const sort = th.dataset.sort

    setSort(sort, sort === state.sort && state.order === 'asc' ? 'desc' : 'asc')
  })
}

new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting) load(false)
}, { rootMargin: '400px' }).observe($('sentinel'))

// ---------- keyboard

document.addEventListener('keydown', async (event) => {
  if ($('editor').open || event.ctrlKey || event.metaKey || event.altKey) return

  const typing = event.target.matches('input[type="search"], input[type="text"], input[type="number"], select')

  if (typing) {
    if (event.key === 'Escape') event.target.blur()

    if (event.key === 'ArrowDown' && event.target === $('search')) {
      event.preventDefault()
      event.target.blur()
      select(Math.max(0, state.selected))
    }

    return
  }

  const index = state.selected

  switch (event.key) {
    case '/':
      event.preventDefault()
      $('search').focus()
      $('search').select()
      break
    case 'ArrowDown':
      event.preventDefault()

      if (index + 1 >= state.files.length) await load(false)

      select(index + 1)
      break
    case 'ArrowUp':
      event.preventDefault()
      select(Math.max(0, index - 1))
      break
    case ' ':
      event.preventDefault()
      togglePlay()
      break
    case 'Enter':
      if (selectedFile()) playFile(selectedFile())
      break
    case 'e':
      if (selectedFile()) openEditor(selectedFile())
      break
    case 'd':
      if (selectedFile()) runAction('download', index)
      break
    case 'f':
      if (selectedFile()) toggleFavorite(index)
      break
    case 'Delete':
      if (selectedFile()) deleteFile(index)
      break
  }
})

// ---------- scan status

let statusTimer = null
let lastPhase = null

function renderStatus (status) {
  const element = $('scan-status')
  const scan = status.scan
  const last = scan.last

  element.classList.remove('error')
  $('scan').disabled = scan.running

  if (scan.running) {
    const labels = {
      listing: `Scanning, ${scan.found} files found`,
      indexing: `Indexing ${scan.done} / ${scan.total}`,
      probing: `Reading durations ${scan.done} / ${scan.total}`
    }

    element.textContent = labels[scan.phase] || 'Scanning'
    element.title = ''
  } else if (last) {
    element.textContent = last.error ? last.error : `Last scan ${formatDate(last.finishedAt)}`
    element.classList.toggle('error', !!last.error)
    element.title = `+${last.added} new, ${last.updated} modified, -${last.removed} removed, ${last.errors} unreadable`
  } else {
    element.textContent = 'Never scanned'
  }
}

async function refreshStatus () {
  clearTimeout(statusTimer)

  try {
    const status = await api('/api/status')
    const wasRunning = state.status && state.status.scan.running

    state.status = status
    renderStatus(status)

    if (typeof setExportFormats === 'function') setExportFormats(status.formats)

    // Show the new files as soon as they are indexed, and again at the end
    if (status.scan.running && status.scan.phase === 'probing' && lastPhase !== 'probing') load()
    if (wasRunning && !status.scan.running) load()

    lastPhase = status.scan.running ? status.scan.phase : null

    if (status.scan.running) statusTimer = setTimeout(refreshStatus, 1500)
  } catch (error) {
    $('scan-status').textContent = 'Server unreachable'
    statusTimer = setTimeout(refreshStatus, 5000)
  }
}

$('scan').addEventListener('click', async (event) => {
  try {
    await api('/api/scan', { method: 'POST', body: JSON.stringify({ full: event.shiftKey }) })
  } catch (error) {
    toast(error.message, true)
  }

  refreshStatus()
})

// ---------- start

applyVolume()
renderSortHeaders()
refreshStatus()
load()
