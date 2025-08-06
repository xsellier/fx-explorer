const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const EventEmitter = require('events');

class FileScanner extends EventEmitter {
  constructor(database, options = {}) {
    super();
    this.db = database;
    this.options = {
      libraryPath: options.libraryPath || './audio_library',
      scanInterval: options.scanInterval || 5 * 60 * 1000, // 5 minutes
      watchFiles: options.watchFiles !== false, // Enable by default
      acceptedExtensions: options.acceptedExtensions || ['.wav', '.mp3', '.aif', '.aiff', '.aac', '.acc', '.ogg', '.flac', '.m4a'],
      ...options
    };
    
    this.isScanning = false;
    this.scanCount = 0;
    this.watcher = null;
    this.scanTimer = null;
    
    console.log('🔍 FileScanner initialized');
    console.log(`   Library Path: ${path.resolve(this.options.libraryPath)}`);
    console.log(`   Scan Interval: ${this.options.scanInterval / 1000}s`);
    console.log(`   Watch Files: ${this.options.watchFiles}`);
    console.log(`   Accepted Extensions: ${this.options.acceptedExtensions.join(', ')}`);
  }

  start() {
    // Ensure library directory exists
    this.ensureLibraryExists();
    
    // Initial scan
    this.performFullScan();
    
    // Set up periodic scanning
    if (this.options.scanInterval > 0) {
      this.scanTimer = setInterval(() => {
        this.performFullScan();
      }, this.options.scanInterval);
    }
    
    // Set up file system watcher for real-time updates
    if (this.options.watchFiles) {
      this.setupFileWatcher();
    }
    
    console.log('🚀 FileScanner started');
  }

  stop() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    
    console.log('⏹️  FileScanner stopped');
  }

  ensureLibraryExists() {
    if (!fs.existsSync(this.options.libraryPath)) {
      fs.mkdirSync(this.options.libraryPath, { recursive: true });
      console.log(`📁 Created library directory: ${this.options.libraryPath}`);
    }
  }

  setupFileWatcher() {
    try {
      this.watcher = chokidar.watch(this.options.libraryPath, {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true,
        ignoreInitial: true,
        depth: 10
      });

      this.watcher
        .on('add', (filePath) => this.handleFileAdd(filePath))
        .on('change', (filePath) => this.handleFileChange(filePath))
        .on('unlink', (filePath) => this.handleFileDelete(filePath))
        .on('addDir', (dirPath) => console.log(`📁 Directory added: ${dirPath}`))
        .on('unlinkDir', (dirPath) => console.log(`📁 Directory removed: ${dirPath}`))
        .on('error', (error) => console.error('🚨 File watcher error:', error));

      console.log('👁️  File system watcher active');
    } catch (error) {
      console.error('🚨 Failed to setup file watcher:', error);
    }
  }

  async handleFileAdd(filePath) {
    if (this.isAudioFile(filePath)) {
      console.log(`➕ File added: ${filePath}`);
      await this.processFile(filePath);
      this.emit('fileAdded', filePath);
    }
  }

  async handleFileChange(filePath) {
    if (this.isAudioFile(filePath)) {
      console.log(`🔄 File changed: ${filePath}`);
      await this.processFile(filePath);
      this.emit('fileChanged', filePath);
    }
  }

  async handleFileDelete(filePath) {
    if (this.isAudioFile(filePath)) {
      console.log(`➖ File deleted: ${filePath}`);
      await this.removeFileFromDatabase(filePath);
      this.emit('fileDeleted', filePath);
    }
  }

  isAudioFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return this.options.acceptedExtensions.includes(ext);
  }

  async performFullScan() {
    if (this.isScanning) {
      console.log('⏳ Scan already in progress, skipping...');
      return;
    }

    this.isScanning = true;
    this.scanCount++;
    const startTime = Date.now();
    
    console.log(`🔍 Starting full library scan #${this.scanCount}...`);
    this.emit('scanStarted', this.scanCount);

    try {
      // Mark all files as inactive first
      await this.db.markAllFilesInactive();
      
      // Scan directory
      const files = await this.scanDirectory(this.options.libraryPath);
      
      // Process each file
      let processed = 0;
      let errors = 0;
      
      for (const filePath of files) {
        try {
          await this.processFile(filePath);
          processed++;
          
          // Emit progress every 50 files
          if (processed % 50 === 0) {
            this.emit('scanProgress', { processed, total: files.length });
          }
        } catch (error) {
          errors++;
          console.error(`🚨 Error processing file ${filePath}:`, error.message);
        }
      }
      
      // Remove files that are no longer present
      const result = await this.db.removeInactiveFiles();
      
      const duration = Date.now() - startTime;
      const stats = {
        scanId: this.scanCount,
        duration,
        totalFiles: files.length,
        processed,
        errors,
        removed: result.changes || 0
      };
      
      console.log(`✅ Scan #${this.scanCount} completed in ${duration}ms`);
      console.log(`   📊 Processed: ${processed}, Errors: ${errors}, Removed: ${stats.removed}`);
      
      this.emit('scanCompleted', stats);
      
    } catch (error) {
      console.error('🚨 Full scan failed:', error);
      this.emit('scanError', error);
    } finally {
      this.isScanning = false;
    }
  }

  async scanDirectory(dirPath) {
    const files = [];
    
    const scan = async (currentPath) => {
      try {
        const items = fs.readdirSync(currentPath);
        
        for (const item of items) {
          const itemPath = path.join(currentPath, item);
          const stat = fs.lstatSync(itemPath);
          
          if (stat.isDirectory()) {
            // Skip hidden directories
            if (!item.startsWith('.')) {
              await scan(itemPath);
            }
          } else if (stat.isFile() && this.isAudioFile(itemPath)) {
            files.push(itemPath);
          }
        }
      } catch (error) {
        console.error(`🚨 Error scanning directory ${currentPath}:`, error.message);
      }
    };
    
    await scan(dirPath);
    return files;
  }

  async processFile(filePath) {
    try {
      const stat = fs.lstatSync(filePath);
      
      if (!stat.isFile()) {
        return;
      }

      const fileData = this.extractFileData(filePath, stat);
      const tags = this.generateTags(filePath, fileData);
      
      // Insert or update file in database
      const result = await this.db.insertOrUpdateFile(fileData);
      const fileId = result.fileId;
      
      // Insert tags
      await this.db.insertFileTags(fileId, tags);
      
      return { fileId, fileData, tags };
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File was deleted during processing
        await this.removeFileFromDatabase(filePath);
        return null;
      }
      throw error;
    }
  }

  extractFileData(filePath, stat) {
    const filename = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const relativePath = path.relative(this.options.libraryPath, filePath);
    const size = stat.size;
    const sizeFormatted = this.formatBytes(size);
    const dateModified = Math.floor(stat.mtime.getTime() / 1000);
    const dateAccessed = Math.floor(stat.atime.getTime() / 1000);

    return {
      filename,
      filepath: filePath,
      relativePath,
      extension,
      size,
      sizeFormatted,
      dateModified,
      dateAccessed
    };
  }

  generateTags(filePath, fileData) {
    const tags = new Set();
    
    // Extract tags from directory structure
    const relativePath = path.relative(this.options.libraryPath, filePath);
    const directories = path.dirname(relativePath).split(path.sep).filter(dir => dir && dir !== '.');
    
    directories.forEach(dir => {
      // Clean directory names and add as tags
      const cleanedTags = this.cleanTextForTags(dir);
      cleanedTags.forEach(tag => tags.add(tag));
    });
    
    // Extract tags from filename
    const filenameWithoutExt = path.basename(fileData.filename, fileData.extension);
    const filenameTags = this.cleanTextForTags(filenameWithoutExt);
    filenameTags.forEach(tag => tags.add(tag));
    
    // Add extension-based tags
    const extTag = fileData.extension.substring(1); // Remove the dot
    tags.add(extTag);
    
    // Add format-based tags
    this.addFormatTags(fileData.extension, tags);
    
    // Add size-based tags
    this.addSizeTags(fileData.size, tags);
    
    return Array.from(tags).filter(tag => tag && tag.length > 1); // Remove empty and single-character tags
  }

  cleanTextForTags(text) {
    if (!text) return [];
    
    return text
      .toLowerCase()
      // Replace common separators with spaces
      .replace(/[\-_\.\+\(\)\[\]]/g, ' ')
      // Remove special characters except spaces and alphanumeric
      .replace(/[^a-z0-9\s]/g, ' ')
      // Remove standalone numbers (often version numbers or IDs)
      .replace(/\b\d+\b/g, ' ')
      // Remove common audio-related suffixes
      .replace(/\b(v\d+|ver\d+|version\d+|final|master|mix|edit|cut|loop|oneshot|sample)\b/g, ' ')
      // Normalize spaces
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(word => 
        word.length > 1 && // At least 2 characters
        word.length < 20 && // Not too long
        !this.isStopWord(word) // Not a stop word
      );
  }

  isStopWord(word) {
    const stopWords = new Set([
      'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
      'from', 'up', 'about', 'into', 'through', 'during', 'before', 'after', 'above',
      'below', 'between', 'among', 'since', 'without', 'under', 'over', 'sound', 'audio',
      'track', 'file', 'music', 'song', 'clip', 'wav', 'mp3', 'aiff', 'ogg', 'flac'
    ]);
    return stopWords.has(word.toLowerCase());
  }

  addFormatTags(extension, tags) {
    const formatMap = {
      '.wav': ['uncompressed', 'lossless', 'pcm'],
      '.aif': ['uncompressed', 'lossless', 'pcm'],
      '.aiff': ['uncompressed', 'lossless', 'pcm'],
      '.mp3': ['compressed', 'lossy', 'mpeg'],
      '.aac': ['compressed', 'lossy', 'advanced'],
      '.ogg': ['compressed', 'lossy', 'vorbis'],
      '.flac': ['compressed', 'lossless', 'free'],
      '.m4a': ['compressed', 'lossy', 'apple']
    };
    
    if (formatMap[extension]) {
      formatMap[extension].forEach(tag => tags.add(tag));
    }
  }

  addSizeTags(size, tags) {
    // Size-based categorization
    if (size < 100 * 1024) { // < 100KB
      tags.add('tiny');
    } else if (size < 1024 * 1024) { // < 1MB
      tags.add('small');
    } else if (size < 10 * 1024 * 1024) { // < 10MB
      tags.add('medium');
    } else if (size < 100 * 1024 * 1024) { // < 100MB
      tags.add('large');
    } else {
      tags.add('huge');
    }
    
    // Duration estimation based on typical audio bitrates
    const estimatedDurationSeconds = size / (128 * 1024 / 8); // Assume 128kbps average
    if (estimatedDurationSeconds < 5) {
      tags.add('short');
    } else if (estimatedDurationSeconds < 30) {
      tags.add('brief');
    } else if (estimatedDurationSeconds < 180) { // 3 minutes
      tags.add('normal');
    } else {
      tags.add('long');
    }
  }

  async removeFileFromDatabase(filePath) {
    try {
      const result = await this.db.run(
        'DELETE FROM files WHERE filepath = ?',
        [filePath]
      );
      
      if (result.changes > 0) {
        console.log(`🗑️  Removed file from database: ${filePath}`);
      }
      
      return result;
    } catch (error) {
      console.error(`🚨 Error removing file from database ${filePath}:`, error);
      throw error;
    }
  }

  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  // Manual scan trigger
  async manualScan() {
    if (this.isScanning) {
      throw new Error('Scan already in progress');
    }
    return this.performFullScan();
  }

  // Get scanner status
  getStatus() {
    return {
      isScanning: this.isScanning,
      scanCount: this.scanCount,
      libraryPath: this.options.libraryPath,
      watchingFiles: !!this.watcher,
      scanInterval: this.options.scanInterval,
      acceptedExtensions: this.options.acceptedExtensions
    };
  }
}

module.exports = FileScanner;
