const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CONFIG_DIR = path.join(ROOT, 'config')

function readJson (name) {
  const file = path.join(CONFIG_DIR, name)

  if (!fs.existsSync(file)) return {}

  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function merge (target, source) {
  const result = { ...target }

  for (const [key, value] of Object.entries(source)) {
    const isObject = value && typeof value === 'object' && !Array.isArray(value)

    result[key] = isObject ? merge(target[key] || {}, value) : value
  }

  return result
}

function resolvePath (value) {
  if (!value) return null
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))

  return path.resolve(ROOT, value)
}

// default.json -> <NODE_ENV>.json -> local.json -> environment variables
const env = process.env.NODE_ENV
let config = readJson('default.json')

if (env && env !== 'default') config = merge(config, readJson(`${env}.json`))
if (env !== 'local') config = merge(config, readJson('local.json'))

if (process.env.PORT) config.server.port = parseInt(process.env.PORT, 10)
if (process.env.HOST) config.server.host = process.env.HOST
if (process.env.LIBRARY_PATH) config.paths.audioLibrary = process.env.LIBRARY_PATH
if (process.env.DATABASE_PATH) config.paths.database = process.env.DATABASE_PATH

config.paths.audioLibrary = resolvePath(config.paths.audioLibrary)
config.paths.database = resolvePath(config.paths.database)
config.paths.trash = resolvePath(config.paths.trash)
config.paths.tmp = resolvePath(config.paths.tmp) || os.tmpdir()
config.paths.public = path.join(ROOT, 'public')
config.scanner.acceptedExtensions = config.scanner.acceptedExtensions.map((ext) => ext.toLowerCase())

module.exports = config
