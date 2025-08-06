const fs = require('fs');
const path = require('path');

class ConfigLoader {
  constructor() {
    this.config = {};
    this.configDir = path.join(__dirname, '../config');
    this.environment = process.env.NODE_ENV || 'development';
    
    this.loadConfiguration();
  }

  loadConfiguration() {
    console.log('🔧 Loading configuration...');
    console.log(`   Environment: ${this.environment}`);
    console.log(`   Config Directory: ${this.configDir}`);

    try {
      // Ensure config directory exists
      if (!fs.existsSync(this.configDir)) {
        console.warn(`⚠️  Config directory not found: ${this.configDir}`);
        console.log('📁 Creating default config directory...');
        this.createDefaultConfigDirectory();
      }

      // Load configurations in order: default -> environment-specific -> local
      const configFiles = [
        'default.json',
        `${this.environment}.json`,
        'local.json' // For local overrides (should be in .gitignore)
      ];

      let loadedConfigs = 0;
      
      configFiles.forEach(filename => {
        const configPath = path.join(this.configDir, filename);
        
        if (fs.existsSync(configPath)) {
          try {
            const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            this.mergeConfig(configData);
            console.log(`✅ Loaded config: ${filename}`);
            loadedConfigs++;
          } catch (error) {
            console.error(`🚨 Error loading config file ${filename}:`, error.message);
          }
        } else if (filename !== 'local.json') { // local.json is optional
          console.warn(`⚠️  Config file not found: ${filename}`);
        }
      });

      if (loadedConfigs === 0) {
        console.warn('⚠️  No configuration files loaded, using defaults');
        this.config = this.getDefaultConfig();
      }

      // Apply environment variable overrides
      this.applyEnvironmentOverrides();

      // Resolve relative paths to absolute paths
      this.resolvePaths();

      // Validate configuration
      this.validateConfiguration();

      console.log('✅ Configuration loaded successfully');
      this.logConfiguration();

    } catch (error) {
      console.error('🚨 Failed to load configuration:', error);
      throw error;
    }
  }

  createDefaultConfigDirectory() {
    fs.mkdirSync(this.configDir, { recursive: true });
    
    // Create default configuration files
    const defaultConfig = this.getDefaultConfig();
    
    // Write default.json
    fs.writeFileSync(
      path.join(this.configDir, 'default.json'),
      JSON.stringify(defaultConfig, null, 2)
    );

    // Write development.json
    const devConfig = {
      server: {
        port: 3000,
        host: "localhost"
      },
      scanner: {
        scanInterval: 30000,
        watchFiles: true
      },
      logging: {
        level: "debug"
      }
    };
    
    fs.writeFileSync(
      path.join(this.configDir, 'development.json'),
      JSON.stringify(devConfig, null, 2)
    );

    // Write production.json
    const prodConfig = {
      server: {
        port: 8080,
        host: "0.0.0.0"
      },
      scanner: {
        scanInterval: 300000,
        watchFiles: true
      },
      logging: {
        level: "info"
      }
    };
    
    fs.writeFileSync(
      path.join(this.configDir, 'production.json'),
      JSON.stringify(prodConfig, null, 2)
    );

    // Create README.md for config directory
    const configReadme = `# Configuration Directory

This directory contains configuration files for the SFX Library Viewer server.

## Configuration Files

- \`default.json\` - Base configuration (always loaded)
- \`development.json\` - Development environment overrides
- \`production.json\` - Production environment overrides
- \`local.json\` - Local overrides (optional, ignored by git)

## Configuration Priority

Configurations are merged in the following order (later files override earlier ones):

1. default.json
2. {environment}.json (development.json, production.json, etc.)
3. local.json (for local development overrides)
4. Environment variables

## Environment Variables

The following environment variables can override configuration:

- \`NODE_ENV\` - Sets the environment (development, production, etc.)
- \`PORT\` - Server port
- \`HOST\` - Server host
- \`LIBRARY_PATH\` - Audio library directory path
- \`DATABASE_PATH\` - SQLite database file path
- \`SCAN_INTERVAL\` - File scan interval in milliseconds

## Paths

All paths in configuration files can be:
- Absolute paths: \`/home/user/audio\`
- Relative to project root: \`./audio_library\`
- Relative to home directory: \`~/Music/SFX\`

The configuration loader automatically resolves relative paths to absolute paths.

## Example local.json

\`\`\`json
{
  "paths": {
    "audioLibrary": "/mnt/usb/audio_collection",
    "database": "/var/lib/sfx-viewer/library.db"
  },
  "server": {
    "port": 3001
  }
}
\`\`\`
`;

    fs.writeFileSync(
      path.join(this.configDir, 'README.md'),
      configReadme
    );

    console.log('📁 Created default configuration directory and files');
  }

  getDefaultConfig() {
    return {
      server: {
        port: 3000,
        host: "0.0.0.0",
        cors: {
          enabled: true,
          origin: "*"
        }
      },
      paths: {
        audioLibrary: "./audio_library",
        database: "./data/sfx_library.db",
        public: "./public"
      },
      scanner: {
        scanInterval: 3600000,
        watchFiles: false,
        acceptedExtensions: [".wav", ".mp3", ".aif", ".aiff", ".aac", ".acc", ".ogg", ".flac", ".m4a"]
      },
      database: {
        pragmas: {
          journal_mode: "WAL",
          synchronous: "NORMAL",
          cache_size: 1000,
          temp_store: "MEMORY"
        }
      },
      audio: {
        streamingBufferSize: 64 * 1024,
        cacheControl: "public, max-age=3600"
      },
      logging: {
        level: "info",
        format: "combined"
      },
      security: {
        rateLimiting: {
          enabled: false,
          windowMs: 900000,
          max: 1000
        }
      },
      features: {
        fileWatcher: false,
        autoScan: true,
        webInterface: true
      }
    };
  }

  mergeConfig(newConfig) {
    this.config = this.deepMerge(this.config, newConfig);
  }

  deepMerge(target, source) {
    const result = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  }

  applyEnvironmentOverrides() {
    // Server configuration
    if (process.env.PORT) {
      this.config.server.port = parseInt(process.env.PORT);
    }
    
    if (process.env.HOST) {
      this.config.server.host = process.env.HOST;
    }

    // Path configurations
    if (process.env.LIBRARY_PATH) {
      this.config.paths.audioLibrary = process.env.LIBRARY_PATH;
    }
    
    if (process.env.DATABASE_PATH) {
      this.config.paths.database = process.env.DATABASE_PATH;
    }

    if (process.env.PUBLIC_PATH) {
      this.config.paths.public = process.env.PUBLIC_PATH;
    }

    // Scanner configuration
    if (process.env.SCAN_INTERVAL) {
      this.config.scanner.scanInterval = parseInt(process.env.SCAN_INTERVAL);
    }
    
    if (process.env.WATCH_FILES !== undefined) {
      this.config.scanner.watchFiles = process.env.WATCH_FILES.toLowerCase() === 'true';
    }

    // Logging
    if (process.env.LOG_LEVEL) {
      this.config.logging.level = process.env.LOG_LEVEL;
    }
  }

  resolvePaths() {
    const resolvePath = (inputPath) => {
      if (path.isAbsolute(inputPath)) {
        return inputPath;
      }
      
      // Handle home directory paths
      if (inputPath.startsWith('~/')) {
        return path.join(require('os').homedir(), inputPath.slice(2));
      }
      
      // Resolve relative to project root
      return path.resolve(process.cwd(), inputPath);
    };

    // Resolve all paths
    this.config.paths.audioLibrary = resolvePath(this.config.paths.audioLibrary);
    this.config.paths.database = resolvePath(this.config.paths.database);
    this.config.paths.public = resolvePath(this.config.paths.public);
  }

  validateConfiguration() {
    const errors = [];

    // Validate server configuration
    if (!this.config.server.port || this.config.server.port < 1 || this.config.server.port > 65535) {
      errors.push('Invalid server port. Must be between 1 and 65535.');
    }

    if (!this.config.server.host) {
      errors.push('Server host cannot be empty.');
    }

    // Validate scan interval
    if (this.config.scanner.scanInterval < 5000) {
      console.warn('⚠️  Scan interval is very low (< 5s). This may impact performance.');
    }

    // Validate paths exist or can be created
    try {
      const libraryDir = path.dirname(this.config.paths.audioLibrary);
      if (!fs.existsSync(libraryDir)) {
        fs.mkdirSync(libraryDir, { recursive: true });
      }
    } catch (error) {
      errors.push(`Cannot create audio library directory: ${error.message}`);
    }

    try {
      const dbDir = path.dirname(this.config.paths.database);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
    } catch (error) {
      errors.push(`Cannot create database directory: ${error.message}`);
    }

    if (errors.length > 0) {
      console.error('🚨 Configuration validation errors:');
      errors.forEach(error => console.error(`   - ${error}`));
      throw new Error('Configuration validation failed');
    }
  }

  logConfiguration() {
    console.log('📋 Current Configuration:');
    console.log(`   🌐 Server: ${this.config.server.host}:${this.config.server.port}`);
    console.log(`   📁 Audio Library: ${this.config.paths.audioLibrary}`);
    console.log(`   🗃️  Database: ${this.config.paths.database}`);
    console.log(`   🔍 Scan Interval: ${this.config.scanner.scanInterval / 1000}s`);
    console.log(`   👁️  File Watching: ${this.config.scanner.watchFiles ? 'enabled' : 'disabled'}`);
    console.log(`   📊 Log Level: ${this.config.logging.level}`);
    
    if (this.environment === 'development') {
      console.log('   🔧 Audio Extensions:', this.config.scanner.acceptedExtensions.join(', '));
    }
  }

  // Getter methods for easy access
  get(key) {
    const keys = key.split('.');
    let value = this.config;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return undefined;
      }
    }
    
    return value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  getServer() {
    return this.config.server;
  }

  getPaths() {
    return this.config.paths;
  }

  getScanner() {
    return this.config.scanner;
  }

  getDatabase() {
    return this.config.database;
  }

  getAudio() {
    return this.config.audio;
  }

  getLogging() {
    return this.config.logging;
  }

  getSecurity() {
    return this.config.security;
  }

  getFeatures() {
    return this.config.features;
  }

  getAll() {
    return { ...this.config };
  }

  // Hot reload configuration (useful for development)
  reload() {
    console.log('🔄 Reloading configuration...');
    this.config = {};
    this.loadConfiguration();
  }

  // Save current configuration to local.json
  saveLocal(overrides = {}) {
    const localConfigPath = path.join(this.configDir, 'local.json');
    
    try {
      let existingLocal = {};
      if (fs.existsSync(localConfigPath)) {
        existingLocal = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
      }

      const updatedLocal = this.deepMerge(existingLocal, overrides);
      
      fs.writeFileSync(
        localConfigPath,
        JSON.stringify(updatedLocal, null, 2)
      );
      
      console.log('✅ Local configuration saved to:', localConfigPath);
      
    } catch (error) {
      console.error('🚨 Failed to save local configuration:', error);
      throw error;
    }
  }
}

// Export singleton instance
module.exports = new ConfigLoader();