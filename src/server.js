const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const Database = require('./database');
const FileScanner = require('./fileScanner');
const APIRoutes = require('./routes');

class SFXLibraryServer {
  constructor(configOverrides = {}) {
    // Load configuration from config system
    this.config = config;
    
    // Apply any constructor overrides
    if (Object.keys(configOverrides).length > 0) {
      console.log('🔧 Applying configuration overrides...');
      this.applyConfigOverrides(configOverrides);
    }

    this.app = express();
    this.database = null;
    this.fileScanner = null;
    this.apiRoutes = null;
    this.server = null;

    this.setupExpress();
    this.setupGracefulShutdown();
  }

  applyConfigOverrides(overrides) {
    // This method allows runtime configuration changes
    // In a production system, you might want to be more restrictive about what can be overridden
    const merge = (target, source) => {
      for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          target[key] = target[key] || {};
          merge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
    };
    
    merge(this.config.getAll(), overrides);
  }

  async waitForDatabase() {
    const maxWait = 10000; // 10 seconds max
    const checkInterval = 100; // Check every 100ms
    let waited = 0;

    while (waited < maxWait) {
      try {
        // Try a simple query to verify database is ready
        await this.database.get('SELECT 1');
        console.log('✅ Database connection verified');
        return;
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        waited += checkInterval;
        
        if (waited % 1000 === 0) { // Log every second
          console.log(`⏳ Waiting for database... (${waited/1000}s)`);
        }
      }
    }
    
    throw new Error('Database initialization timeout');
  }

  setupExpress() {
    const serverConfig = this.config.getServer();
    const securityConfig = this.config.getSecurity();
    const pathsConfig = this.config.getPaths();

    // Trust proxy for proper IP detection (useful for reverse proxies)
    this.app.set('trust proxy', true);

    // CORS configuration from config
    if (serverConfig.cors.enabled) {
      this.app.use(cors({
        origin: serverConfig.cors.origin,
        credentials: serverConfig.cors.credentials,
        methods: serverConfig.cors.methods,
        allowedHeaders: serverConfig.cors.allowedHeaders
      }));
    }

    // Body parsing middleware
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Request logging middleware
    if (serverConfig.requestLogging) {
      this.app.use((req, res, next) => {
        const timestamp = new Date().toISOString();
        const ip = req.ip || req.connection.remoteAddress;
        console.log(`📡 ${timestamp} - ${ip} - ${req.method} ${req.path}`);
        next();
      });
    }

    // Serve static files from public directory
    const publicPath = pathsConfig.public;
    if (fs.existsSync(publicPath)) {
      const performanceConfig = this.config.get('performance');
      const cacheOptions = {
        maxAge: performanceConfig?.caching?.enabled ? 
          performanceConfig.caching.maxAge * 1000 : '1h',
        etag: true
      };
      
      this.app.use(express.static(publicPath, cacheOptions));
      console.log(`📁 Static files served from: ${publicPath}`);
    } else {
      console.warn(`⚠️  Public directory not found: ${publicPath}`);
    }

    // Health check endpoint (before API routes)
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        server: 'SFX Library Viewer',
        version: process.env.npm_package_version || '1.0.0',
        environment: process.env.NODE_ENV || 'development'
      });
    });

    console.log('🚀 Express application configured');
    console.log(`   📁 Static files: ${publicPath}`);
    console.log(`   🌐 CORS: ${serverConfig.cors.enabled ? 'enabled' : 'disabled'} (${serverConfig.cors.origin})`);
    console.log(`   📡 Host: ${serverConfig.host}:${serverConfig.port}`);
  }

  async initialize() {
    try {
      console.log('🔧 Initializing SFX Library Server...');
      
      const pathsConfig = this.config.getPaths();
      const scannerConfig = this.config.getScanner();
      
      console.log(`   📁 Audio Library: ${pathsConfig.audioLibrary}`);
      console.log(`   🗃️  Database: ${pathsConfig.database}`);
      console.log(`   ⏱️  Scan Interval: ${scannerConfig.scanInterval / 1000}s`);

      // Ensure required directories exist
      this.ensureDirectories();

      // Initialize database
      console.log('🗃️  Initializing database...');
      this.database = new Database(pathsConfig.database);

      // Wait for database to be properly initialized
      await this.waitForDatabase();

      // Initialize file scanner
      console.log('🔍 Initializing file scanner...');
      this.fileScanner = new FileScanner(this.database, {
        libraryPath: pathsConfig.audioLibrary,
        scanInterval: scannerConfig.scanInterval,
        watchFiles: scannerConfig.watchFiles,
        acceptedExtensions: scannerConfig.acceptedExtensions,
        maxDepth: scannerConfig.maxDepth,
        batchSize: scannerConfig.batchSize,
        parallel: scannerConfig.parallel
      });

      // Setup scanner event listeners
      this.setupScannerEvents();

      // Initialize API routes
      console.log('🛣️  Initializing API routes...');
      this.apiRoutes = new APIRoutes(this.database, this.fileScanner);
      this.app.use('/api', this.apiRoutes.getRouter());

      // Setup catch-all route for SPA
      const publicIndexPath = path.join(pathsConfig.public, 'index.html');
      this.app.get('*', (req, res) => {
        if (fs.existsSync(publicIndexPath)) {
          res.sendFile(publicIndexPath);
        } else {
          res.status(404).json({ 
            error: 'Frontend not found. Please ensure public/index.html exists.',
            path: publicIndexPath
          });
        }
      });

      // Error handling middleware
      this.setupErrorHandling();

      console.log('✅ Server initialization complete');

    } catch (error) {
      console.error('🚨 Failed to initialize server:', error);
      throw error;
    }
  }

  ensureDirectories() {
    const pathsConfig = this.config.getPaths();
    
    // Ensure library directory exists
    if (!fs.existsSync(pathsConfig.audioLibrary)) {
      fs.mkdirSync(pathsConfig.audioLibrary, { recursive: true });
      
      // Create sample directory structure
      const sampleDirs = ['UI', 'Music', 'SFX', 'Ambient', 'Voices'];
      sampleDirs.forEach(dir => {
        const dirPath = path.join(pathsConfig.audioLibrary, dir);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
      });
      
      console.log(`📁 Created library directory with sample folders: ${pathsConfig.audioLibrary}`);
    }

    // Ensure public directory exists
    if (!fs.existsSync(pathsConfig.public)) {
      fs.mkdirSync(pathsConfig.public, { recursive: true });
      console.log(`📁 Created public directory: ${pathsConfig.public}`);
    }

    // Ensure database directory exists
    const dbDir = path.dirname(pathsConfig.database);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`📁 Created database directory: ${dbDir}`);
    }

    // Ensure logs directory exists (if logging to file is enabled)
    const loggingConfig = this.config.getLogging();
    if (loggingConfig.enableFile && pathsConfig.logs) {
      if (!fs.existsSync(pathsConfig.logs)) {
        fs.mkdirSync(pathsConfig.logs, { recursive: true });
        console.log(`📁 Created logs directory: ${pathsConfig.logs}`);
      }
    }

    // Ensure backup directory exists (if backups are enabled)
    const dbConfig = this.config.getDatabase();
    if (dbConfig.backup?.enabled && dbConfig.backup.path) {
      if (!fs.existsSync(dbConfig.backup.path)) {
        fs.mkdirSync(dbConfig.backup.path, { recursive: true });
        console.log(`📁 Created backup directory: ${dbConfig.backup.path}`);
      }
    }
  }

  setupScannerEvents() {
    if (!this.fileScanner) return;

    this.fileScanner.on('scanStarted', (scanId) => {
      console.log(`🔍 File scan #${scanId} started`);
    });

    this.fileScanner.on('scanProgress', ({ processed, total }) => {
      console.log(`📊 Scan progress: ${processed}/${total} files processed`);
    });

    this.fileScanner.on('scanCompleted', (stats) => {
      console.log(`✅ File scan #${stats.scanId} completed:`);
      console.log(`   📊 Duration: ${stats.duration}ms`);
      console.log(`   📁 Files processed: ${stats.processed}`);
      console.log(`   ❌ Errors: ${stats.errors}`);
      console.log(`   🗑️  Files removed: ${stats.removed}`);
    });

    this.fileScanner.on('scanError', (error) => {
      console.error('🚨 File scan error:', error);
    });

    this.fileScanner.on('fileAdded', (filePath) => {
      console.log(`➕ File added: ${path.basename(filePath)}`);
    });

    this.fileScanner.on('fileChanged', (filePath) => {
      console.log(`🔄 File changed: ${path.basename(filePath)}`);
    });

    this.fileScanner.on('fileDeleted', (filePath) => {
      console.log(`➖ File deleted: ${path.basename(filePath)}`);
    });
  }

  setupErrorHandling() {
    // 404 handler for API routes
    this.app.use('/api/*', (req, res) => {
      res.status(404).json({
        success: false,
        error: 'API endpoint not found',
        path: req.path
      });
    });

    // Global error handler
    this.app.use((error, req, res, next) => {
      console.error('🚨 Unhandled error:', error);
      
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('🚨 Uncaught Exception:', error);
      // Don't exit immediately, try graceful shutdown
      this.shutdown(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
    });
  }

  setupGracefulShutdown() {
    const gracefulShutdown = (signal) => {
      console.log(`\n🔄 Received ${signal}, starting graceful shutdown...`);
      this.shutdown(0);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'));
  }

  async start() {
    try {
      await this.initialize();

      // Start file scanner
      if (this.fileScanner) {
        this.fileScanner.start();
      }

      const serverConfig = this.config.getServer();
      const pathsConfig = this.config.getPaths();

      // Start HTTP server
      this.server = this.app.listen(serverConfig.port, serverConfig.host, () => {
        console.log('\n🎵 SFX Library Viewer Server Started! 🎵');
        console.log('========================================');
        console.log(`🌐 Server URL: http://localhost:${serverConfig.port}`);
        console.log(`🌍 Network URL: http://${this.getLocalIP()}:${serverConfig.port}`);
        console.log(`📁 Library: ${pathsConfig.audioLibrary}`);
        console.log(`🗃️  Database: ${pathsConfig.database}`);
        console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log('========================================');
        console.log('📡 Server is open to requests from configured origins');
        console.log('⏹️  Press Ctrl+C to stop the server');
        console.log('');
      });

      // Server error handling
      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`🚨 Port ${serverConfig.port} is already in use`);
          console.error('💡 Try setting a different port in config or: PORT=3001 npm start');
        } else {
          console.error('🚨 Server error:', error);
        }
        process.exit(1);
      });

    } catch (error) {
      console.error('🚨 Failed to start server:', error);
      process.exit(1);
    }
  }

  async shutdown(exitCode = 0) {
    console.log('🔄 Starting shutdown sequence...');

    try {
      // Stop file scanner
      if (this.fileScanner) {
        console.log('⏹️  Stopping file scanner...');
        this.fileScanner.stop();
      }

      // Close database connection
      if (this.database) {
        console.log('🗃️  Closing database connection...');
        this.database.close();
      }

      // Close HTTP server
      if (this.server) {
        console.log('🌐 Closing HTTP server...');
        await new Promise((resolve) => {
          this.server.close(resolve);
        });
      }

      console.log('✅ Graceful shutdown complete');
      process.exit(exitCode);

    } catch (error) {
      console.error('🚨 Error during shutdown:', error);
      process.exit(1);
    }
  }

  getLocalIP() {
    const networkInterfaces = require('os').networkInterfaces();
    for (const name of Object.keys(networkInterfaces)) {
      for (const networkInterface of networkInterfaces[name]) {
        if (networkInterface.family === 'IPv4' && !networkInterface.internal) {
          return networkInterface.address;
        }
      }
    }
    return 'localhost';
  }
}

// If this file is run directly, start the server
if (require.main === module) {
  const server = new SFXLibraryServer();
  server.start();
}

module.exports = SFXLibraryServer;