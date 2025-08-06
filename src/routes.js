const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

class APIRoutes {
  constructor(database, fileScanner) {
    this.db = database;
    this.scanner = fileScanner;
    this.router = express.Router();
    this.setupRoutes();
  }

  setupRoutes() {
    // Files and search endpoints
    this.router.get('/files', this.getFiles.bind(this));
    this.router.get('/files/:id', this.getFileById.bind(this));
    this.router.delete('/files/:id', this.deleteFile.bind(this));
    
    // Audio streaming
    this.router.get('/audio/:id', this.streamAudio.bind(this));
    
    // Metadata endpoints
    this.router.get('/extensions', this.getExtensions.bind(this));
    this.router.get('/tags', this.getTags.bind(this));
    this.router.get('/stats', this.getStats.bind(this));
    
    // File management
    this.router.post('/show-in-folder', this.showInFolder.bind(this));
    
    // Scanner control
    this.router.post('/scan', this.triggerScan.bind(this));
    this.router.get('/scan/status', this.getScanStatus.bind(this));
    
    // Health check
    this.router.get('/health', this.healthCheck.bind(this));
    
    console.log('🛣️  API routes configured');
  }

  // GET /api/files - Get files with filtering, sorting, and pagination
  async getFiles(req, res) {
    try {
      const {
        search = '',
        extension = '',
        tags = '',
        sortBy = 'filename',
        sortOrder = 'ASC',
        limit = 1000,
        offset = 0
      } = req.query;

      // Parse tags from comma-separated string
      const tagArray = tags ? tags.split(',').map(tag => tag.trim().toLowerCase()).filter(tag => tag) : [];

      const options = {
        search: search.trim(),
        extension: extension || '',
        tags: tagArray,
        sortBy,
        sortOrder: sortOrder.toUpperCase(),
        limit: parseInt(limit) || 1000,
        offset: parseInt(offset) || 0
      };

      const files = await this.db.getFiles(options);
      
      // Transform files for frontend compatibility
      const transformedFiles = files.map(file => ({
        id: file.id,
        filename: file.filename,
        filePath: file.relative_path,
        extname: file.extension,
        tags: file.tags || [],
        size: file.size,
        sizeFormatted: file.size_formatted,
        date: file.date,
        dateFormatted: file.dateFormatted,
        dirname: path.dirname(file.filepath),
        relative_path: file.relative_path
      }));

      res.json({
        success: true,
        files: transformedFiles,
        total: transformedFiles.length,
        options
      });

    } catch (error) {
      console.error('Error getting files:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve files',
        details: error.message
      });
    }
  }

  // GET /api/files/:id - Get single file by ID
  async getFileById(req, res) {
    try {
      const { id } = req.params;
      const file = await this.db.getFileById(id);
      
      if (!file) {
        return res.status(404).json({
          success: false,
          error: 'File not found'
        });
      }

      // Transform for frontend compatibility
      const transformedFile = {
        id: file.id,
        filename: file.filename,
        filePath: file.relative_path,
        extname: file.extension,
        tags: file.tags || [],
        size: file.size,
        sizeFormatted: file.size_formatted,
        date: file.date,
        dateFormatted: new Date(file.date_modified * 1000).toLocaleString(),
        dirname: path.dirname(file.filepath)
      };

      res.json({
        success: true,
        file: transformedFile
      });

    } catch (error) {
      console.error('Error getting file by ID:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve file'
      });
    }
  }

  // DELETE /api/files/:id - Delete file
  async deleteFile(req, res) {
    try {
      const { id } = req.params;
      
      // First get file info to delete physical file
      const file = await this.db.getFileById(id);
      if (!file) {
        return res.status(404).json({
          success: false,
          error: 'File not found'
        });
      }

      // Delete physical file
      try {
        if (fs.existsSync(file.filepath)) {
          fs.unlinkSync(file.filepath);
          console.log(`🗑️  Physical file deleted: ${file.filepath}`);
        }
      } catch (fsError) {
        console.warn('Warning: Could not delete physical file:', fsError.message);
        // Continue with database deletion even if physical file deletion fails
      }

      // Delete from database
      await this.db.deleteFile(id);

      res.json({
        success: true,
        message: 'File deleted successfully',
        filename: file.filename
      });

    } catch (error) {
      console.error('Error deleting file:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete file'
      });
    }
  }

  // GET /api/audio/:id - Stream audio file
  async streamAudio(req, res) {
    try {
      const { id } = req.params;
      
      // Get file from database
      const file = await this.db.getFileById(id);
      if (!file) {
        return res.status(404).json({ error: 'File not found' });
      }

      const filePath = file.filepath;
      
      // Check if file exists on disk
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Audio file not found on disk' });
      }

      // Get file stats
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      // Set appropriate MIME type
      const mimeTypes = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.aif': 'audio/aiff',
        '.aiff': 'audio/aiff',
        '.aac': 'audio/aac',
        '.acc': 'audio/aac',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac',
        '.m4a': 'audio/mp4'
      };

      const mimeType = mimeTypes[file.extension] || 'audio/mpeg';

      // Set headers for audio streaming
      res.set({
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Content-Length': fileSize,
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range'
      });

      // Handle range requests for audio seeking
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;

        res.status(206);
        res.set({
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': chunksize
        });

        const stream = fs.createReadStream(filePath, { start, end });
        stream.pipe(res);
      } else {
        fs.createReadStream(filePath).pipe(res);
      }

    } catch (error) {
      console.error('Error streaming audio:', error);
      res.status(500).json({ error: 'Failed to stream audio file' });
    }
  }

  // GET /api/extensions - Get all file extensions with counts
  async getExtensions(req, res) {
    try {
      const extensions = await this.db.getFileExtensions();
      
      res.json({
        success: true,
        extensions: extensions.map(ext => ({
          extension: ext.extension,
          count: ext.count,
          label: ext.extension.toUpperCase()
        }))
      });

    } catch (error) {
      console.error('Error getting extensions:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve file extensions'
      });
    }
  }

  // GET /api/tags - Get popular tags
  async getTags(req, res) {
    try {
      const { limit = 50 } = req.query;
      const tags = await this.db.getPopularTags(parseInt(limit));
      
      res.json({
        success: true,
        tags: tags.map(tag => ({
          name: tag.name,
          count: tag.usage_count
        }))
      });

    } catch (error) {
      console.error('Error getting tags:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve tags'
      });
    }
  }

  // GET /api/stats - Get database statistics
  async getStats(req, res) {
    try {
      const stats = await this.db.getStats();
      
      res.json({
        success: true,
        stats: {
          totalFiles: stats.totalFiles,
          totalTags: stats.totalTags,
          totalSize: stats.totalSize,
          totalSizeFormatted: this.formatBytes(stats.totalSize),
          extensions: stats.extensions,
          scannerStatus: this.scanner ? this.scanner.getStatus() : null
        }
      });

    } catch (error) {
      console.error('Error getting stats:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve statistics'
      });
    }
  }

  // POST /api/show-in-folder - Show file in system explorer
  async showInFolder(req, res) {
    try {
      const { id } = req.body;
      
      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'File ID is required'
        });
      }

      // Get file from database
      const file = await this.db.getFileById(id);
      if (!file) {
        return res.status(404).json({
          success: false,
          error: 'File not found'
        });
      }

      const filePath = file.filepath;
      
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({
          success: false,
          error: 'File no longer exists on disk'
        });
      }

      // Platform-specific commands to open file explorer
      let command;
      switch (process.platform) {
        case 'win32':
          command = `explorer /select,"${filePath}"`;
          break;
        case 'darwin':
          command = `open -R "${filePath}"`;
          break;
        default: // Linux and others (including Raspbian)
          // For Raspbian/Linux, try different file managers
          const directory = path.dirname(filePath);
          command = `pcmanfm "${directory}" || nautilus "${directory}" || xdg-open "${directory}"`;
          break;
      }

      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error('Error opening file explorer:', error);
          res.status(500).json({
            success: false,
            error: 'Failed to open file explorer',
            details: error.message
          });
        } else {
          res.json({
            success: true,
            message: 'File explorer opened',
            path: filePath
          });
        }
      });

    } catch (error) {
      console.error('Error in show-in-folder:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to show file in folder'
      });
    }
  }

  // POST /api/scan - Trigger manual scan
  async triggerScan(req, res) {
    try {
      if (!this.scanner) {
        return res.status(503).json({
          success: false,
          error: 'File scanner not available'
        });
      }

      if (this.scanner.isScanning) {
        return res.status(409).json({
          success: false,
          error: 'Scan already in progress'
        });
      }

      // Trigger scan in background
      this.scanner.manualScan().catch(error => {
        console.error('Manual scan failed:', error);
      });

      res.json({
        success: true,
        message: 'Scan started',
        scanId: this.scanner.scanCount + 1
      });

    } catch (error) {
      console.error('Error triggering scan:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to start scan'
      });
    }
  }

  // GET /api/scan/status - Get scanner status
  async getScanStatus(req, res) {
    try {
      if (!this.scanner) {
        return res.status(503).json({
          success: false,
          error: 'File scanner not available'
        });
      }

      const status = this.scanner.getStatus();
      res.json({
        success: true,
        status
      });

    } catch (error) {
      console.error('Error getting scan status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get scan status'
      });
    }
  }

  // GET /api/health - Health check
  async healthCheck(req, res) {
    try {
      const stats = await this.db.getStats();
      
      res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        database: {
          connected: true,
          totalFiles: stats.totalFiles
        },
        scanner: this.scanner ? {
          active: true,
          status: this.scanner.getStatus()
        } : {
          active: false
        },
        system: {
          platform: process.platform,
          nodeVersion: process.version,
          uptime: process.uptime()
        }
      });

    } catch (error) {
      console.error('Health check failed:', error);
      res.status(500).json({
        status: 'ERROR',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  // Utility function to format bytes
  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  getRouter() {
    return this.router;
  }
}

module.exports = APIRoutes;