const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')
const { normalize, buildWhere } = require('./search')

// Bump it when the schema changes. The database is only a cache of the
// library, an outdated one is dropped and rebuilt by the next scan.
const SCHEMA_VERSION = 1

const SCHEMA = `
  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    dir TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    duration REAL,
    sample_rate INTEGER,
    channels INTEGER,
    bits INTEGER,
    codec TEXT,
    probed INTEGER NOT NULL DEFAULT 0,
    search_name TEXT NOT NULL,
    search_tags TEXT NOT NULL DEFAULT '|'
  );
  CREATE INDEX files_name ON files (name COLLATE NOCASE);
  CREATE INDEX files_size ON files (size);
  CREATE INDEX files_mtime ON files (mtime);
  CREATE INDEX files_duration ON files (duration);

  CREATE TABLE tags (
    file_id INTEGER NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    auto INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (file_id, tag)
  );
  CREATE INDEX tags_tag ON tags (tag);

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`

const SORT_COLUMNS = {
  name: 'name COLLATE NOCASE',
  date: 'mtime',
  size: 'size',
  duration: 'duration'
}

function reset (db) {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()

  db.transaction(() => {
    // Virtual tables first, they own their shadow tables
    for (const { name } of objects.filter((o) => /^CREATE VIRTUAL/i.test(o.sql || ''))) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`)
    }

    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`)
    }

    db.exec(SCHEMA)
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  })()
}

function dirTags (dir) {
  return dir ? dir.split('/').filter(Boolean) : []
}

function toFile (row, tags = []) {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    dir: row.dir,
    ext: row.ext,
    size: row.size,
    mtime: row.mtime,
    duration: row.duration,
    sampleRate: row.sample_rate,
    channels: row.channels,
    bits: row.bits,
    codec: row.codec,
    probed: !!row.probed,
    tags
  }
}

class Library {
  constructor (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })

    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')

    if (this.db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION) {
      console.log('Database schema outdated or missing, creating it')
      reset(this.db)
    }

    this.statements = {
      insertFile: this.db.prepare(`
        INSERT INTO files (path, name, dir, ext, size, mtime, search_name)
        VALUES (@path, @name, @dir, @ext, @size, @mtime, @searchName)
      `),
      insertTag: this.db.prepare('INSERT OR IGNORE INTO tags (file_id, tag, auto) VALUES (?, ?, ?)'),
      deleteTag: this.db.prepare('DELETE FROM tags WHERE file_id = ? AND tag = ? AND auto = 0'),
      fileTags: this.db.prepare('SELECT tag, auto FROM tags WHERE file_id = ? ORDER BY auto DESC, rowid'),
      searchTags: this.db.prepare('UPDATE files SET search_tags = ? WHERE id = ?'),
      updateStat: this.db.prepare('UPDATE files SET size = ?, mtime = ?, probed = 0 WHERE id = ?'),
      updateProbe: this.db.prepare(`
        UPDATE files SET duration = @duration, sample_rate = @sampleRate, channels = @channels,
          bits = @bits, codec = @codec, probed = 1
        WHERE id = @id
      `),
      deleteFile: this.db.prepare('DELETE FROM files WHERE id = ?'),
      getFile: this.db.prepare('SELECT * FROM files WHERE id = ?'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    }
  }

  close () {
    this.db.close()
  }

  getMeta (key) {
    const row = this.statements.getMeta.get(key)

    return row ? JSON.parse(row.value) : null
  }

  setMeta (key, value) {
    this.statements.setMeta.run(key, JSON.stringify(value))
  }

  // Path -> { id, size, mtime } for every indexed file
  index () {
    const map = new Map()

    for (const row of this.db.prepare('SELECT id, path, size, mtime FROM files').iterate()) {
      map.set(row.path, row)
    }

    return map
  }

  refreshSearchTags (fileId) {
    const tags = this.statements.fileTags.all(fileId).map((row) => normalize(row.tag)).filter(Boolean)

    this.statements.searchTags.run(`|${tags.join('|')}|`, fileId)
  }

  insertFiles (entries) {
    this.db.transaction(() => {
      for (const entry of entries) {
        const dir = path.posix.dirname(entry.path)
        const name = path.posix.basename(entry.path)
        const { lastInsertRowid } = this.statements.insertFile.run({
          path: entry.path,
          name,
          dir: dir === '.' ? '' : dir,
          ext: path.extname(name).slice(1).toLowerCase(),
          size: entry.size,
          mtime: entry.mtime,
          searchName: normalize(name)
        })

        for (const tag of dirTags(dir === '.' ? '' : dir)) {
          this.statements.insertTag.run(lastInsertRowid, tag, 1)
        }

        this.refreshSearchTags(lastInsertRowid)
      }
    })()
  }

  updateStats (entries) {
    this.db.transaction(() => {
      for (const { id, size, mtime } of entries) this.statements.updateStat.run(size, mtime, id)
    })()
  }

  updateProbes (results) {
    this.db.transaction(() => {
      for (const result of results) this.statements.updateProbe.run(result)
    })()
  }

  deleteFiles (ids) {
    this.db.transaction(() => {
      for (const id of ids) this.statements.deleteFile.run(id)
    })()
  }

  unprobed () {
    return this.db.prepare('SELECT id, path FROM files WHERE probed = 0').all()
  }

  resetProbes () {
    this.db.prepare('UPDATE files SET probed = 0').run()
  }

  tagsFor (ids) {
    const map = new Map(ids.map((id) => [id, []]))

    if (!ids.length) return map

    const rows = this.db.prepare(`
      SELECT file_id, tag, auto FROM tags WHERE file_id IN (${ids.map(() => '?').join(',')})
      ORDER BY auto DESC, rowid
    `).all(...ids)

    for (const row of rows) map.get(row.file_id).push({ name: row.tag, auto: !!row.auto })

    return map
  }

  getFile (id) {
    const row = this.statements.getFile.get(id)

    if (!row) return null

    return toFile(row, this.tagsFor([row.id]).get(row.id))
  }

  list ({ q = '', sort = 'name', order = 'asc', offset = 0, limit = 200 } = {}) {
    const where = buildWhere(q)
    const column = SORT_COLUMNS[sort] || SORT_COLUMNS.name
    const direction = order === 'desc' ? 'DESC' : 'ASC'
    // Files not probed yet always go at the end when sorting by duration
    const nulls = sort === 'duration' ? 'duration IS NULL, ' : ''

    const summary = this.db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(size), 0) AS size, COALESCE(SUM(duration), 0) AS duration
      FROM files ${where.sql}
    `).get(...where.params)

    const rows = this.db.prepare(`
      SELECT * FROM files ${where.sql}
      ORDER BY ${nulls}${column} ${direction}, id ${direction}
      LIMIT ? OFFSET ?
    `).all(...where.params, limit, offset)

    const tags = this.tagsFor(rows.map((row) => row.id))

    return {
      total: summary.total,
      totalSize: summary.size,
      totalDuration: summary.duration,
      files: rows.map((row) => toFile(row, tags.get(row.id)))
    }
  }

  addTag (fileId, tag) {
    this.statements.insertTag.run(fileId, tag, 0)
    this.refreshSearchTags(fileId)
  }

  removeTag (fileId, tag) {
    this.statements.deleteTag.run(fileId, tag)
    this.refreshSearchTags(fileId)
  }

  // User tags first, then the most used folder names
  tags (limit = 500) {
    return this.db.prepare(`
      SELECT tag AS name, COUNT(*) AS count, MIN(auto) = 0 AS user
      FROM tags GROUP BY tag
      ORDER BY user DESC, count DESC, tag
      LIMIT ?
    `).all(limit).map((row) => ({ ...row, user: !!row.user }))
  }

  stats () {
    return this.db.prepare(`
      SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS size, COALESCE(SUM(duration), 0) AS duration,
        SUM(probed = 0) AS unprobed
      FROM files
    `).get()
  }
}

module.exports = Library
