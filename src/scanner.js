const fs = require('fs/promises')
const path = require('path')

async function mapLimit (items, limit, task) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++

      await task(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

function chunks (items, size) {
  const result = []

  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))

  return result
}

// Scans the library folder and syncs the database with it. Files that did not
// change (same size and modification date) are skipped, only new or modified
// files go through ffprobe.
class Scanner {
  constructor (library, ffmpeg, options) {
    this.library = library
    this.ffmpeg = ffmpeg
    this.root = options.root
    this.extensions = new Set(options.acceptedExtensions)
    this.ignoreHidden = options.ignoreHidden !== false
    this.ignoreFolders = new Set(options.ignoreFolders || [])
    this.statConcurrency = options.statConcurrency || 8
    this.probeConcurrency = options.probeConcurrency || 2
    this.stopped = false
    this.state = { running: false }
  }

  status () {
    return { ...this.state, last: this.library.getMeta('lastScan') }
  }

  stop () {
    this.stopped = true
  }

  start ({ full = false } = {}) {
    if (this.state.running) return false

    this.run(full)

    return true
  }

  async list () {
    const files = []
    const failed = []
    const stack = ['']

    while (stack.length && !this.stopped) {
      const relative = stack.pop()
      let entries

      try {
        entries = await fs.readdir(path.join(this.root, relative), { withFileTypes: true })
      } catch (error) {
        console.error(`Cannot read ${relative || '/'}: ${error.message}`)
        failed.push(relative)
        continue
      }

      for (const entry of entries) {
        if (this.ignoreHidden && entry.name.startsWith('.')) continue

        const child = relative ? `${relative}/${entry.name}` : entry.name

        if (entry.isDirectory()) {
          if (!this.ignoreFolders.has(entry.name)) stack.push(child)
        } else if (entry.isFile() && this.extensions.has(path.extname(entry.name).toLowerCase())) {
          files.push(child)
        }
      }

      this.state.found = files.length
    }

    return { files, failed }
  }

  async run (full) {
    const startedAt = Date.now()

    this.stopped = false
    this.state = { running: true, phase: 'listing', startedAt, found: 0, total: 0, done: 0, added: 0, updated: 0, removed: 0, errors: 0 }

    try {
      const rootStat = await fs.stat(this.root).catch(() => null)

      if (!rootStat || !rootStat.isDirectory()) throw new Error(`Library folder not found: ${this.root}`)

      const { files, failed } = await this.list()
      const index = this.library.index()

      if (this.stopped) return

      // An unmounted NAS looks like an empty folder, do not wipe the database
      if (!files.length && index.size) {
        throw new Error('No audio file found, is the NAS mounted? The database was left untouched.')
      }

      this.state.phase = 'indexing'
      this.state.total = files.length

      const added = []
      const updated = []

      await mapLimit(files, this.statConcurrency, async (file) => {
        try {
          const stat = await fs.stat(path.join(this.root, file))
          const mtime = Math.floor(stat.mtimeMs)
          const known = index.get(file)

          if (!known) added.push({ path: file, size: stat.size, mtime })
          else if (known.size !== stat.size || known.mtime !== mtime) updated.push({ id: known.id, size: stat.size, mtime })
        } catch (error) {
          this.state.errors++
        }

        index.delete(file)
        this.state.done++
      })

      if (this.stopped) return

      for (const chunk of chunks(added, 500)) this.library.insertFiles(chunk)

      this.library.updateStats(updated)

      // Whatever is left in the index is gone from the disk. When a folder
      // could not be read, keep its files, the NAS may just have hiccuped.
      const removed = [...index.entries()]
        .filter(([file]) => !failed.some((dir) => dir === '' || file.startsWith(`${dir}/`)))
        .map(([, row]) => row.id)

      this.library.deleteFiles(removed)

      Object.assign(this.state, { added: added.length, updated: updated.length, removed: removed.length })

      await this.probe(full)

      if (failed.length) this.state.error = `${failed.length} folder(s) could not be read, check the server logs`
    } catch (error) {
      this.state.error = error.message
      this.state.aborted = true
    } finally {
      const finishedAt = Date.now()
      const { running, phase, aborted, ...summary } = this.state

      this.state = { running: false }

      if (!this.stopped) {
        this.library.setMeta('lastScan', { ...summary, finishedAt })

        if (aborted) console.error(`Scan failed: ${summary.error}`)
        else console.log(`Scan done in ${((finishedAt - startedAt) / 1000).toFixed(1)}s: ${summary.added} added, ${summary.updated} updated, ${summary.removed} removed, ${summary.errors} errors${summary.error ? `, ${summary.error}` : ''}`)
      }
    }
  }

  async probe (full) {
    if (full) this.library.resetProbes()

    const pending = this.library.unprobed()
    let buffer = []
    let missing = false

    this.state.phase = 'probing'
    this.state.total = pending.length
    this.state.done = 0

    const flush = () => {
      this.library.updateProbes(buffer)
      buffer = []
    }

    await mapLimit(pending, this.probeConcurrency, async (file) => {
      if (missing || this.stopped) return

      try {
        const info = await this.ffmpeg.probe(path.join(this.root, file.path))

        if (!info) this.state.errors++

        buffer.push({ id: file.id, duration: null, sampleRate: null, channels: null, bits: null, codec: null, ...info })
      } catch (error) {
        missing = true
        this.state.error = 'ffprobe not found, install ffmpeg to get durations'
        return
      }

      this.state.done++

      if (buffer.length >= 25) flush()
    })

    flush()
  }
}

module.exports = Scanner
