const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

class Database {
  constructor(dbPath = './sfx_library.db') {
    this.dbPath = dbPath;
    this.db = null;
    this.init();
  }

  init() {
    // Ensure database directory exists
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new sqlite3.Database(this.dbPath, (err) => {
      if (err) {
        console.error('Error opening database:', err);
      } else {
        console.log('✅ Connected to SQLite database:', this.dbPath);
        this.createTables();
      }
    });

    // Enable foreign keys
    this.db.run('PRAGMA foreign_keys = ON');
  }

  createTables() {
    const createTablesSQL = `
      -- Files table
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        filepath TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL,
        extension TEXT NOT NULL,
        size INTEGER NOT NULL,
        size_formatted TEXT NOT NULL,
        date_modified INTEGER NOT NULL,
        date_accessed INTEGER NOT NULL,
        date_scanned INTEGER DEFAULT (strftime('%s', 'now')),
        is_active BOOLEAN DEFAULT 1,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      -- Tags table
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        usage_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      -- File-Tags junction table
      CREATE TABLE IF NOT EXISTS file_tags (
        file_id INTEGER,
        tag_id INTEGER,
        PRIMARY KEY (file_id, tag_id),
        FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
      );

      -- Indexes for better performance
      CREATE INDEX IF NOT EXISTS idx_files_filepath ON files(filepath);
      CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
      CREATE INDEX IF NOT EXISTS idx_files_active ON files(is_active);
      CREATE INDEX IF NOT EXISTS idx_files_date_modified ON files(date_modified);
      CREATE INDEX IF NOT EXISTS idx_files_size ON files(size);
      CREATE INDEX IF NOT EXISTS idx_tags_usage ON tags(usage_count DESC);
      CREATE INDEX IF NOT EXISTS idx_file_tags_file ON file_tags(file_id);
      CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);

      -- Full-text search virtual table
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        filename, 
        relative_path, 
        tags,
        content='',
        tokenize='porter'
      );

      -- Triggers to update usage counts and timestamps
      CREATE TRIGGER IF NOT EXISTS update_file_timestamp 
        AFTER UPDATE ON files
      BEGIN
        UPDATE files SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS update_tag_usage_count
        AFTER INSERT ON file_tags
      BEGIN
        UPDATE tags SET usage_count = usage_count + 1 WHERE id = NEW.tag_id;
      END;

      CREATE TRIGGER IF NOT EXISTS decrease_tag_usage_count
        AFTER DELETE ON file_tags
      BEGIN
        UPDATE tags SET usage_count = usage_count - 1 WHERE id = OLD.tag_id;
      END;
    `;

    this.db.exec(createTablesSQL, (err) => {
      if (err) {
        console.error('Error creating tables:', err);
      } else {
        console.log('✅ Database tables initialized');
      }
    });
  }

  // File operations
  insertOrUpdateFile(fileData) {
    return new Promise((resolve, reject) => {
      const {
        filename,
        filepath,
        relativePath,
        extension,
        size,
        sizeFormatted,
        dateModified,
        dateAccessed,
        tags = []
      } = fileData;

      const sql = `
        INSERT INTO files 
        (filename, filepath, relative_path, extension, size, size_formatted, date_modified, date_accessed, is_active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, strftime('%s', 'now'))
      `;

      this.db.run(sql, [
        filename,
        filepath,
        relativePath,
        extension,
        size,
        sizeFormatted,
        dateModified,
        dateAccessed
      ], function(err) {
        if (err) {
          reject(err);
        } else {
          const fileId = this.lastID;
          resolve({ fileId, changes: this.changes });
        }
      });
    });
  }

  // Get file by filepath to check if it already exists
  getFileByPath(filepath) {
    return this.get('SELECT * FROM files WHERE filepath = ?', [filepath]);
  }

  // Update existing file information
  updateExistingFile(fileId, fileData) {
    const {
      filename,
      size,
      sizeFormatted,
      dateModified,
      dateAccessed
    } = fileData;

    return this.run(`
      UPDATE files 
      SET filename = ?, size = ?, size_formatted = ?, date_modified = ?, 
          date_accessed = ?, is_active = 1, updated_at = strftime('%s', 'now')
      WHERE id = ?
    `, [filename, size, sizeFormatted, dateModified, dateAccessed, fileId]);
  }

  // Mark file as active without updating other fields
  markFileActive(fileId) {
    return this.run(
      'UPDATE files SET is_active = 1, updated_at = strftime(\'%s\', \'now\') WHERE id = ?', 
      [fileId]
    );
  }

  async insertFileTags(fileId, tags) {
    if (!tags || tags.length === 0) return;

    try {
      // First, remove existing tags for this file
      await this.run('DELETE FROM file_tags WHERE file_id = ?', [fileId]);

      // Insert or get tag IDs
      const tagIds = [];
      for (const tagName of tags) {
        if (tagName && tagName.trim()) {
          const tagId = await this.insertOrGetTag(tagName.trim().toLowerCase());
          tagIds.push(tagId);
        }
      }

      // Insert file-tag relationships
      const insertTagSQL = 'INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)';
      for (const tagId of tagIds) {
        await this.run(insertTagSQL, [fileId, tagId]);
      }

      // Update FTS table
      await this.updateFileFTS(fileId);
    } catch (error) {
      console.error('Error inserting file tags:', error);
      throw error;
    }
  }

  insertOrGetTag(tagName) {
    return new Promise((resolve, reject) => {
      // First try to get existing tag
      this.db.get('SELECT id FROM tags WHERE name = ?', [tagName], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          resolve(row.id);
        } else {
          // Insert new tag
          this.db.run('INSERT INTO tags (name) VALUES (?)', [tagName], function(err) {
            if (err) {
              reject(err);
            } else {
              resolve(this.lastID);
            }
          });
        }
      });
    });
  }

  updateFileFTS(fileId) {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT f.filename, f.relative_path, GROUP_CONCAT(t.name, ' ') as tags
        FROM files f
        LEFT JOIN file_tags ft ON f.id = ft.file_id
        LEFT JOIN tags t ON ft.tag_id = t.id
        WHERE f.id = ?
        GROUP BY f.id
      `;

      this.db.get(sql, [fileId], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          const ftsSQL = `
            INSERT OR REPLACE INTO files_fts (rowid, filename, relative_path, tags)
            VALUES (?, ?, ?, ?)
          `;
          this.db.run(ftsSQL, [fileId, row.filename, row.relative_path, row.tags || ''], (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        } else {
          resolve();
        }
      });
    });
  }

  // Mark files as inactive (for cleanup)
  markAllFilesInactive() {
    return this.run('UPDATE files SET is_active = 0 WHERE is_active = 1');
  }

  // Remove inactive files
  removeInactiveFiles() {
    return this.run('DELETE FROM files WHERE is_active = 0');
  }

  // Get total count of files matching criteria (for pagination)
  async getFilesCount(options = {}) {
    const {
      search = '',
      extension = '',
      tags = []
    } = options;

    let sql = `
      SELECT COUNT(DISTINCT f.id) as count
      FROM files f
      LEFT JOIN file_tags ft ON f.id = ft.file_id
      LEFT JOIN tags t ON ft.tag_id = t.id
      WHERE f.is_active = 1
    `;

    const params = [];

    // Extension filter
    if (extension && extension !== 'All') {
      sql += ' AND f.extension = ?';
      params.push(extension);
    }

    // Tags filter
    if (tags.length > 0) {
      const tagPlaceholders = tags.map(() => '?').join(',');
      sql += ` AND f.id IN (
        SELECT ft.file_id 
        FROM file_tags ft 
        JOIN tags t ON ft.tag_id = t.id 
        WHERE t.name IN (${tagPlaceholders})
        GROUP BY ft.file_id 
        HAVING COUNT(DISTINCT t.id) = ?
      )`;
      params.push(...tags, tags.length);
    }

    // Search filter (using FTS if available)
    if (search.trim()) {
      if (search.includes(' ')) {
        // Multiple terms - use FTS
        sql += ` AND f.id IN (
          SELECT rowid FROM files_fts 
          WHERE files_fts MATCH ?
        )`;
        params.push(search.trim());
      } else {
        // Single term - use LIKE for broader matching
        sql += ` AND (
          f.filename LIKE ? OR 
          f.relative_path LIKE ? OR
          f.id IN (SELECT ft.file_id FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE t.name LIKE ?)
        )`;
        const searchTerm = `%${search.trim()}%`;
        params.push(searchTerm, searchTerm, searchTerm);
      }
    }

    try {
      const result = await this.get(sql, params);
      return result ? result.count : 0;
    } catch (error) {
      console.error('Error getting files count:', error);
      throw error;
    }
  }
  async getFiles(options = {}) {
    const {
      search = '',
      extension = '',
      sortBy = 'filename',
      sortOrder = 'ASC',
      limit = 1000,
      offset = 0,
      tags = []
    } = options;

    let sql = `
      SELECT DISTINCT f.*, GROUP_CONCAT(t.name, ', ') as tag_list
      FROM files f
      LEFT JOIN file_tags ft ON f.id = ft.file_id
      LEFT JOIN tags t ON ft.tag_id = t.id
      WHERE f.is_active = 1
    `;

    const params = [];

    // Extension filter
    if (extension && extension !== 'All') {
      sql += ' AND f.extension = ?';
      params.push(extension);
    }

    // Tags filter
    if (tags.length > 0) {
      const tagPlaceholders = tags.map(() => '?').join(',');
      sql += ` AND f.id IN (
        SELECT ft.file_id 
        FROM file_tags ft 
        JOIN tags t ON ft.tag_id = t.id 
        WHERE t.name IN (${tagPlaceholders})
        GROUP BY ft.file_id 
        HAVING COUNT(DISTINCT t.id) = ?
      )`;
      params.push(...tags, tags.length);
    }

    // Search filter (using FTS if available)
    if (search.trim()) {
      if (search.includes(' ')) {
        // Multiple terms - use FTS
        sql += ` AND f.id IN (
          SELECT rowid FROM files_fts 
          WHERE files_fts MATCH ?
        )`;
        params.push(search.trim());
      } else {
        // Single term - use LIKE for broader matching
        sql += ` AND (
          f.filename LIKE ? OR 
          f.relative_path LIKE ? OR
          f.id IN (SELECT ft.file_id FROM file_tags ft JOIN tags t ON ft.tag_id = t.id WHERE t.name LIKE ?)
        )`;
        const searchTerm = `%${search.trim()}%`;
        params.push(searchTerm, searchTerm, searchTerm);
      }
    }

    sql += ' GROUP BY f.id';

    // Sorting
    const validSortColumns = {
      'filename': 'f.filename',
      'date': 'f.date_modified',
      'size': 'f.size',
      'extension': 'f.extension'
    };

    const sortColumn = validSortColumns[sortBy] || 'f.filename';
    const order = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    sql += ` ORDER BY ${sortColumn} ${order}`;

    // Pagination
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    try {
      const files = await this.all(sql, params);
      
      // Convert tag_list back to array and add formatted data
      return files.map(file => ({
        ...file,
        tags: file.tag_list ? file.tag_list.split(', ') : [],
        date: new Date(file.date_modified * 1000),
        dateFormatted: new Date(file.date_modified * 1000).toLocaleString()
      }));
    } catch (error) {
      console.error('Error getting files:', error);
      throw error;
    }
  }

  // Get file extensions
  getFileExtensions() {
    return this.all(`
      SELECT extension, COUNT(*) as count 
      FROM files 
      WHERE is_active = 1 
      GROUP BY extension 
      ORDER BY count DESC
    `);
  }

  // Get popular tags
  getPopularTags(limit = 50) {
    return this.all(`
      SELECT t.name, t.usage_count 
      FROM tags t 
      WHERE t.usage_count > 0 
      ORDER BY t.usage_count DESC, t.name ASC 
      LIMIT ?
    `, [limit]);
  }

  // Get file by ID with tags
  async getFileById(id) {
    try {
      const file = await this.get(`
        SELECT f.*, GROUP_CONCAT(t.name, ', ') as tag_list
        FROM files f
        LEFT JOIN file_tags ft ON f.id = ft.file_id
        LEFT JOIN tags t ON ft.tag_id = t.id
        WHERE f.id = ? AND f.is_active = 1
        GROUP BY f.id
      `, [id]);

      if (file) {
        file.tags = file.tag_list ? file.tag_list.split(', ') : [];
        file.date = new Date(file.date_modified * 1000);
      }

      return file;
    } catch (error) {
      console.error('Error getting file by ID:', error);
      throw error;
    }
  }

  // Delete file
  async deleteFile(id) {
    try {
      const result = await this.run('DELETE FROM files WHERE id = ?', [id]);
      // Remove from FTS
      await this.run('DELETE FROM files_fts WHERE rowid = ?', [id]);
      return result;
    } catch (error) {
      console.error('Error deleting file:', error);
      throw error;
    }
  }

  // Get database statistics
  async getStats() {
    try {
      const [fileCount, tagCount, totalSize, extensions] = await Promise.all([
        this.get('SELECT COUNT(*) as count FROM files WHERE is_active = 1'),
        this.get('SELECT COUNT(*) as count FROM tags WHERE usage_count > 0'),
        this.get('SELECT SUM(size) as total FROM files WHERE is_active = 1'),
        this.all('SELECT extension, COUNT(*) as count FROM files WHERE is_active = 1 GROUP BY extension ORDER BY count DESC')
      ]);

      return {
        totalFiles: fileCount.count,
        totalTags: tagCount.count,
        totalSize: totalSize.total || 0,
        extensions: extensions
      };
    } catch (error) {
      console.error('Error getting stats:', error);
      throw error;
    }
  }

  // Utility methods for Promise-based database operations
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ lastID: this.lastID, changes: this.changes });
        }
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  close() {
    if (this.db) {
      this.db.close((err) => {
        if (err) {
          console.error('Error closing database:', err);
        } else {
          console.log('✅ Database connection closed');
        }
      });
    }
  }
}

module.exports = Database;