// Waveform editor: select a part of a sound, preview it, then let the server
// cut / convert it with ffmpeg. Decoding happens in the browser so the
// Raspberry Pi only has to send the file.

const editor = {
  file: null,
  buffer: null,
  context: null,
  gainNode: null,
  source: null,
  playback: null,
  view: [0, 0],
  selection: null,
  cursor: 0,
  loop: false,
  drag: null,
  cache: document.createElement('canvas'),
  abort: null
}

const wave = $('wave')

function setExportFormats (formats) {
  const select = $('export-format')

  if (select.options.length) return

  select.innerHTML = formats.map((format) => `<option value="${format}">${format.toUpperCase()}</option>`).join('')
}

function duration () {
  return editor.buffer ? editor.buffer.duration : 0
}

function timeAt (event) {
  const [start, end] = editor.view
  const ratio = Math.min(1, Math.max(0, event.offsetX / wave.clientWidth))

  return start + ratio * (end - start)
}

function xAt (time) {
  const [start, end] = editor.view

  return ((time - start) / (end - start)) * wave.width
}

function pixelsToTime (pixels) {
  return (pixels / wave.clientWidth) * (editor.view[1] - editor.view[0])
}

function niceStep (span, width) {
  const target = span / Math.max(1, width / 110)
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]

  return steps.find((step) => step >= target) || 3600
}

function formatTick (seconds, step) {
  if (step >= 1) return formatClock(seconds)

  return `${seconds.toFixed(step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3)}s`
}

// ---------- drawing

function resizeCanvas () {
  const ratio = window.devicePixelRatio || 1

  wave.width = Math.round(wave.clientWidth * ratio)
  wave.height = Math.round(wave.clientHeight * ratio)
  editor.cache.width = wave.width
  editor.cache.height = wave.height
}

// Draws the waveform of the visible range in an offscreen canvas, the
// selection and the playhead are drawn on top of it
function renderWave () {
  const canvas = editor.cache
  const g = canvas.getContext('2d')
  const { width, height } = canvas
  const ratio = window.devicePixelRatio || 1
  const style = getComputedStyle(document.body)

  g.clearRect(0, 0, width, height)

  if (!editor.buffer) return draw()

  const buffer = editor.buffer
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
  const rate = buffer.sampleRate
  const [viewStart, viewEnd] = editor.view
  const first = viewStart * rate
  const perPixel = ((viewEnd - viewStart) * rate) / width
  const stride = Math.max(1, Math.floor(perPixel / 2000))
  const top = 18 * ratio
  const middle = top + (height - top) / 2
  const amplitude = (height - top) / 2 - 2

  g.fillStyle = style.getPropertyValue('--muted')
  g.fillRect(0, middle, width, 1)
  g.fillStyle = '#9da3c0'

  for (let x = 0; x < width; x++) {
    const from = Math.floor(first + x * perPixel)
    const to = Math.min(buffer.length, Math.max(from + 1, Math.floor(first + (x + 1) * perPixel)))
    let min = 1
    let max = -1

    for (const data of channels) {
      for (let i = from; i < to; i += stride) {
        const value = data[i]

        if (value < min) min = value
        if (value > max) max = value
      }
    }

    if (max < min) continue

    g.fillRect(x, middle - max * amplitude, 1, Math.max(1, (max - min) * amplitude))
  }

  // Time ruler
  const step = niceStep(viewEnd - viewStart, wave.clientWidth)

  g.font = `${11 * ratio}px system-ui, sans-serif`
  g.fillStyle = style.getPropertyValue('--muted')

  for (let t = Math.ceil(viewStart / step) * step; t <= viewEnd; t += step) {
    const x = xAt(t)

    g.fillRect(x, 0, 1, 6 * ratio)
    g.fillText(formatTick(t, step), x + 3 * ratio, 12 * ratio)
  }

  draw()
}

function playheadTime () {
  const playback = editor.playback

  if (!playback) return null

  const elapsed = editor.context.currentTime - playback.startedAt

  if (playback.loop) {
    const length = playback.loopEnd - playback.loopStart
    const position = playback.offset + elapsed

    return position < playback.loopEnd ? position : playback.loopStart + ((position - playback.loopStart) % length)
  }

  return Math.min(playback.end, playback.offset + elapsed)
}

function draw () {
  if (!wave.width || !editor.cache.width) return

  const g = wave.getContext('2d')
  const style = getComputedStyle(document.body)
  const accent = style.getPropertyValue('--accent').trim()
  const ratio = window.devicePixelRatio || 1

  g.clearRect(0, 0, wave.width, wave.height)
  g.drawImage(editor.cache, 0, 0)

  if (editor.selection) {
    const left = xAt(editor.selection[0])
    const right = xAt(editor.selection[1])

    g.fillStyle = `${accent}40`
    g.fillRect(left, 0, right - left, wave.height)
    g.fillStyle = accent
    g.fillRect(left - ratio, 0, 2 * ratio, wave.height)
    g.fillRect(right - ratio, 0, 2 * ratio, wave.height)
  }

  g.fillStyle = '#ffffff80'
  g.fillRect(xAt(editor.cursor), 0, ratio, wave.height)

  const playhead = playheadTime()

  if (playhead !== null) {
    g.fillStyle = '#ffffff'
    g.fillRect(xAt(playhead), 0, 2 * ratio, wave.height)
  }
}

function animate () {
  if (!editor.playback) return draw()

  draw()
  requestAnimationFrame(animate)
}

function setView (start, end) {
  const total = duration()
  const minimum = Math.min(total, 0.005)
  let length = Math.max(minimum, Math.min(total, end - start))
  let from = Math.max(0, Math.min(start, total - length))

  if (!Number.isFinite(from)) from = 0
  if (!Number.isFinite(length)) length = total

  editor.view = [from, from + length]
  renderWave()
}

// ---------- selection

function updateSelectionUi () {
  const selection = editor.selection

  $('sel-start').value = selection ? selection[0].toFixed(3) : ''
  $('sel-end').value = selection ? selection[1].toFixed(3) : ''
  $('sel-length').textContent = selection
    ? `Selection: ${(selection[1] - selection[0]).toFixed(3)} s`
    : 'No selection, the whole sound is exported'
  $('export-label').textContent = selection ? 'Download selection' : 'Download'
  $('zoom-selection').disabled = !selection
  draw()
}

function setSelection (start, end) {
  const total = duration()
  const from = Math.max(0, Math.min(start, end, total))
  const to = Math.min(total, Math.max(start, end, 0))

  editor.selection = to - from >= 0.001 ? [from, to] : null
  updateSelectionUi()
}

wave.addEventListener('pointerdown', (event) => {
  if (!editor.buffer) return

  wave.setPointerCapture(event.pointerId)

  const time = timeAt(event)
  const tolerance = pixelsToTime(6)
  const selection = editor.selection

  if (selection && Math.abs(time - selection[0]) < tolerance) editor.drag = { edge: 0 }
  else if (selection && Math.abs(time - selection[1]) < tolerance) editor.drag = { edge: 1 }
  else editor.drag = { anchor: time, x: event.offsetX, moved: false }
})

wave.addEventListener('pointermove', (event) => {
  if (!editor.buffer) return

  const time = timeAt(event)
  const drag = editor.drag

  if (!drag) {
    const selection = editor.selection
    const tolerance = pixelsToTime(6)
    const onEdge = selection && (Math.abs(time - selection[0]) < tolerance || Math.abs(time - selection[1]) < tolerance)

    wave.style.cursor = onEdge ? 'ew-resize' : 'crosshair'
    return
  }

  if (drag.edge !== undefined) {
    const other = editor.selection[1 - drag.edge]

    setSelection(other, time)
    drag.edge = time < other ? 0 : 1
  } else if (drag.moved || Math.abs(event.offsetX - drag.x) > 3) {
    drag.moved = true
    setSelection(drag.anchor, time)
  }
})

wave.addEventListener('pointerup', (event) => {
  const drag = editor.drag

  editor.drag = null

  if (!drag || !editor.buffer) return

  // A simple click places the cursor
  if (drag.edge === undefined && !drag.moved) {
    editor.cursor = timeAt(event)
    setSelection(0, 0)

    if (editor.playback) play()
  }
})

wave.addEventListener('wheel', (event) => {
  if (!editor.buffer) return

  event.preventDefault()

  const [start, end] = editor.view
  const length = end - start

  if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    const delta = event.shiftKey ? event.deltaY || event.deltaX : event.deltaX
    const shift = (delta / wave.clientWidth) * length

    return setView(start + shift, end + shift)
  }

  const time = timeAt(event)
  const factor = event.deltaY > 0 ? 1.25 : 0.8
  const newLength = length * factor

  setView(time - (time - start) * factor, time - (time - start) * factor + newLength)
}, { passive: false })

$('sel-start').addEventListener('change', () => {
  const start = parseFloat($('sel-start').value) || 0
  const end = editor.selection ? editor.selection[1] : duration()

  setSelection(start, end)
})

$('sel-end').addEventListener('change', () => {
  const end = parseFloat($('sel-end').value) || 0
  const start = editor.selection ? editor.selection[0] : 0

  setSelection(start, end)
})

$('select-all').addEventListener('click', () => setSelection(0, duration()))
$('select-none').addEventListener('click', () => setSelection(0, 0))
$('zoom-all').addEventListener('click', () => setView(0, duration()))
$('zoom-selection').addEventListener('click', () => {
  if (!editor.selection) return

  const [start, end] = editor.selection
  const margin = (end - start) * 0.05

  setView(start - margin, end + margin)
})

// ---------- playback

function applyEditorVolume () {
  if (editor.gainNode) editor.gainNode.gain.value = gain()
}

function stopEditorPlayback () {
  if (editor.source) {
    editor.source.onended = null

    try {
      editor.source.stop()
    } catch (error) {}

    editor.source.disconnect()
  }

  editor.source = null
  editor.playback = null
  $('editor-play').querySelector('use').setAttribute('href', '#i-play')
  $('editor-play').querySelector('span').textContent = 'Play'
  draw()
}

function play () {
  stopEditorPlayback()

  if (!editor.buffer) return

  const selection = editor.selection
  const end = selection ? selection[1] : duration()
  let start = selection ? selection[0] : editor.cursor

  if (start >= end - 0.001) start = 0

  const source = editor.context.createBufferSource()

  source.buffer = editor.buffer
  source.connect(editor.gainNode)

  const loop = editor.loop && !!selection

  if (loop) {
    source.loop = true
    source.loopStart = selection[0]
    source.loopEnd = selection[1]
    source.start(0, start)
  } else {
    source.start(0, start, end - start)
  }

  source.onended = () => {
    if (editor.source === source) stopEditorPlayback()
  }

  editor.source = source
  editor.playback = { startedAt: editor.context.currentTime, offset: start, end, loop, loopStart: start, loopEnd: end }
  $('editor-play').querySelector('use').setAttribute('href', '#i-stop')
  $('editor-play').querySelector('span').textContent = 'Stop'
  stopMainPlayback()
  animate()
}

$('editor-play').addEventListener('click', () => (editor.playback ? stopEditorPlayback() : play()))

$('editor-loop').addEventListener('click', () => {
  editor.loop = !editor.loop
  $('editor-loop').classList.toggle('on', editor.loop)

  if (editor.playback) play()
})

// ---------- loading

async function fetchBuffer (url, signal, onProgress) {
  const response = await fetch(url, { signal })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))

    throw new Error(data.error || `${response.status} ${response.statusText}`)
  }

  const total = parseInt(response.headers.get('content-length'), 10) || 0
  const reader = response.body.getReader()
  const chunks = []
  let received = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break

    chunks.push(value)
    received += value.length
    onProgress(received, total)
  }

  const bytes = new Uint8Array(received)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }

  return bytes.buffer
}

async function decode (file, signal) {
  const message = $('wave-message')
  const progress = (received, total) => {
    message.textContent = total
      ? `Loading ${formatSize(received)} / ${formatSize(total)}`
      : `Loading ${formatSize(received)}`
  }

  // The browser cannot decode aiff, wma... the server converts them to wav first
  const sources = canPlay(file)
    ? [`/api/files/${file.id}/stream`, `/api/files/${file.id}/export?format=wav`]
    : [`/api/files/${file.id}/export?format=wav`]
  let lastError = null

  for (const url of sources) {
    try {
      if (url.includes('export')) message.textContent = 'Converting on the server...'

      const data = await fetchBuffer(url, signal, progress)

      message.textContent = 'Decoding...'

      return await editor.context.decodeAudioData(data)
    } catch (error) {
      if (error.name === 'AbortError') throw error

      lastError = error
    }
  }

  throw lastError
}

async function openEditor (file) {
  if (editor.abort) editor.abort.abort()

  stopMainPlayback()
  stopEditorPlayback()

  if (!editor.context) {
    editor.context = new AudioContext()
    editor.gainNode = editor.context.createGain()
    editor.gainNode.connect(editor.context.destination)
  }

  editor.context.resume()
  applyEditorVolume()

  Object.assign(editor, { file, buffer: null, selection: null, cursor: 0, view: [0, 0], abort: new AbortController() })

  const format = $('export-format')

  format.value = [...format.options].some((option) => option.value === file.ext) ? file.ext : 'wav'
  $('editor-name').textContent = file.name
  $('editor-name').title = file.path
  $('editor-info').textContent = `${formatInfo(file)} · ${formatDuration(file.duration)} · ${formatSize(file.size)}`
  $('export-status').textContent = ''
  $('wave-message').textContent = 'Loading...'

  if (!$('editor').open) $('editor').showModal()

  resizeCanvas()
  updateSelectionUi()
  renderWave()

  try {
    const buffer = await decode(file, editor.abort.signal)

    if (editor.file !== file) return

    editor.buffer = buffer
    $('wave-message').textContent = ''
    setView(0, buffer.duration)
    updateSelectionUi()
  } catch (error) {
    if (error.name !== 'AbortError') $('wave-message').textContent = `Cannot load this sound: ${error.message}`
  }
}

function closeEditor () {
  if (editor.abort) editor.abort.abort()

  stopEditorPlayback()
  editor.buffer = null
  editor.file = null

  if ($('editor').open) $('editor').close()
}

$('editor-close').addEventListener('click', closeEditor)
$('editor').addEventListener('close', closeEditor)

$('editor').addEventListener('keydown', (event) => {
  if (event.key !== ' ' || event.target.matches('input, select')) return

  event.preventDefault()

  if (editor.playback) stopEditorPlayback()
  else play()
})

window.addEventListener('resize', () => {
  if (!$('editor').open) return

  resizeCanvas()
  renderWave()
})

// ---------- export

function filenameFrom (header, fallback) {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header || '')

  if (encoded) return decodeURIComponent(encoded[1])

  const plain = /filename="([^"]+)"/i.exec(header || '')

  return plain ? plain[1] : fallback
}

$('export').addEventListener('click', async () => {
  const file = editor.file

  if (!file) return

  const params = new URLSearchParams({ format: $('export-format').value })

  if (editor.selection) {
    params.set('start', editor.selection[0].toFixed(3))
    params.set('end', editor.selection[1].toFixed(3))
  }

  if ($('export-channels').value) params.set('channels', $('export-channels').value)
  if ($('export-rate').value) params.set('rate', $('export-rate').value)
  if (parseFloat($('fade-in').value) > 0) params.set('fadeIn', $('fade-in').value)
  if (parseFloat($('fade-out').value) > 0) params.set('fadeOut', $('fade-out').value)

  const button = $('export')
  const status = $('export-status')

  button.disabled = true
  status.classList.remove('error')
  status.textContent = 'Exporting with ffmpeg on the server...'

  try {
    const response = await fetch(`/api/files/${file.id}/export?${params}`)

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))

      throw new Error(data.error || `${response.status} ${response.statusText}`)
    }

    const blob = await response.blob()
    const name = filenameFrom(response.headers.get('content-disposition'), `${file.name}.${params.get('format')}`)
    const url = URL.createObjectURL(blob)

    triggerDownload(url, name)
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    status.textContent = `${name} (${formatSize(blob.size)})`
  } catch (error) {
    status.textContent = error.message
    status.classList.add('error')
  } finally {
    button.disabled = false
  }
})
