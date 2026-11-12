const crypto = require('crypto')
const express = require('express')

const config = require('./config')
const Library = require('./database')
const Scanner = require('./scanner')
const createRouter = require('./routes')
const { FFmpeg } = require('./ffmpeg')

function sameString (a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest()
  const right = crypto.createHash('sha256').update(String(b)).digest()

  return crypto.timingSafeEqual(left, right)
}

function basicAuth ({ user, password }) {
  return (req, res, next) => {
    const encoded = (req.headers.authorization || '').replace(/^Basic /, '')
    const decoded = Buffer.from(encoded, 'base64').toString()
    const separator = decoded.indexOf(':')

    if (separator > 0 && sameString(decoded.slice(0, separator), user) && sameString(decoded.slice(separator + 1), password)) {
      return next()
    }

    res.set('WWW-Authenticate', 'Basic realm="FX Explorer"').status(401).end()
  }
}

const library = new Library(config.paths.database)
const ffmpeg = new FFmpeg({ ...config.ffmpeg, tmp: config.paths.tmp })
const scanner = new Scanner(library, ffmpeg, { root: config.paths.audioLibrary, ...config.scanner })
const app = express()

if (config.server.auth && config.server.auth.user) app.use(basicAuth(config.server.auth))

app.use(express.json())
app.use('/api', createRouter({ library, scanner, ffmpeg, config }))
app.use(express.static(config.paths.public))

const server = app.listen(config.server.port, config.server.host, () => {
  console.log(`FX Explorer listening on http://${config.server.host}:${config.server.port}`)
  console.log(`Library: ${config.paths.audioLibrary}`)
  console.log(`Database: ${config.paths.database}`)

  if (config.scanner.scanOnFirstStart && !library.getMeta('lastScan')) {
    console.log('Database never scanned, starting the first scan')
    scanner.start()
  }
})

function shutdown () {
  scanner.stop()
  server.close()
  library.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
