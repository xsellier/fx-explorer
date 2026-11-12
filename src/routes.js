const fs = require('fs')
const path = require('path')
const express = require('express')
const { FORMATS } = require('./ffmpeg')

const MIME_TYPES = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  wma: 'audio/x-ms-wma'
}

function number (value) {
  const parsed = parseFloat(value)

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

async function moveFile (source, target) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true })

  try {
    await fs.promises.rename(source, target)
  } catch (error) {
    // The trash lives on another disk
    if (error.code !== 'EXDEV') throw error

    await fs.promises.copyFile(source, target)
    await fs.promises.unlink(source)
  }
}

module.exports = function createRouter ({ library, scanner, ffmpeg, config }) {
  const router = express.Router()
  const root = config.paths.audioLibrary

  const absolute = (file) => {
    const full = path.join(root, file.path)
    const relative = path.relative(root, full)

    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid path')

    return full
  }

  // Loads the file of /files/:id into req.file
  router.param('id', (req, res, next, id) => {
    req.file = library.getFile(parseInt(id, 10))

    if (!req.file) return res.status(404).json({ error: 'File not found' })

    next()
  })

  router.get('/files', (req, res) => {
    res.json(library.list({
      q: req.query.q,
      sort: req.query.sort,
      order: req.query.order,
      offset: Math.max(0, parseInt(req.query.offset, 10) || 0),
      limit: Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200))
    }))
  })

  router.get('/files/:id', (req, res) => res.json(req.file))

  router.get('/files/:id/stream', (req, res, next) => {
    const file = absolute(req.file)

    if (req.query.transcode) return ffmpeg.transcode(file, req, res).catch(next)

    res.sendFile(file, {
      dotfiles: 'allow',
      headers: { 'Content-Type': MIME_TYPES[req.file.ext] || 'application/octet-stream' }
    }, (error) => error && !res.headersSent && next(error))
  })

  router.get('/files/:id/download', (req, res, next) => {
    res.download(absolute(req.file), req.file.name, { dotfiles: 'allow' }, (error) => error && !res.headersSent && next(error))
  })

  // Cut and/or convert with ffmpeg, then send the result
  router.get('/files/:id/export', async (req, res, next) => {
    const format = String(req.query.format || req.file.ext).toLowerCase()

    if (!FORMATS[format]) return res.status(400).json({ error: `Unsupported format: ${format}` })

    const options = {
      format,
      start: number(req.query.start) || 0,
      end: number(req.query.end),
      channels: parseInt(req.query.channels, 10) || null,
      sampleRate: parseInt(req.query.rate, 10) || null,
      fadeIn: number(req.query.fadeIn) || 0,
      fadeOut: number(req.query.fadeOut) || 0
    }

    try {
      const output = await ffmpeg.export(absolute(req.file), req.file, options)
      const isCut = options.start > 0 || options.end !== null
      const name = `${path.parse(req.file.name).name}${isCut ? '_cut' : ''}.${format}`

      res.download(output, name, () => fs.unlink(output, () => {}))
    } catch (error) {
      next(error)
    }
  })

  router.delete('/files/:id', async (req, res, next) => {
    try {
      const file = absolute(req.file)

      if (config.paths.trash) await moveFile(file, path.join(config.paths.trash, req.file.path))
      else await fs.promises.unlink(file)
    } catch (error) {
      if (error.code !== 'ENOENT') return next(error)
    }

    library.deleteFiles([req.file.id])
    res.json({ deleted: req.file.id, trash: !!config.paths.trash })
  })

  router.post('/files/:id/tags', (req, res) => {
    const tag = String((req.body || {}).tag || '').trim()

    if (!tag || tag.length > 100) return res.status(400).json({ error: 'Invalid tag' })

    library.addTag(req.file.id, tag)
    res.json(library.getFile(req.file.id))
  })

  router.delete('/files/:id/tags/:tag', (req, res) => {
    library.removeTag(req.file.id, req.params.tag)
    res.json(library.getFile(req.file.id))
  })

  router.get('/tags', (req, res) => res.json(library.tags()))

  router.get('/status', (req, res) => {
    res.json({
      stats: library.stats(),
      scan: scanner.status(),
      formats: Object.keys(FORMATS),
      trash: !!config.paths.trash,
      copyPathPrefix: config.ui.copyPathPrefix || ''
    })
  })

  router.post('/scan', (req, res) => {
    const started = scanner.start({ full: !!(req.body || {}).full })

    res.status(started ? 202 : 409).json(scanner.status())
  })

  router.use((error, req, res, next) => {
    console.error(`${req.method} ${req.originalUrl}: ${error.message}`)

    if (res.headersSent) return res.end()

    res.status(error.status || 500).json({ error: error.message })
  })

  return router
}
