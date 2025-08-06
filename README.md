# SFX Library Viewer - SQLite-Powered Server

A professional web-based audio file library viewer and manager with SQLite database, automatic file scanning, and intelligent tagging. Optimized for Raspberry Pi deployment with comprehensive configuration system.

## ✨ Features

- **🔍 Smart File Scanning**: Automatically discovers and catalogs audio files with real-time file system watching and **incremental updates** (only processes changed files on restart)
- **🏷️ Smart Auto-Tagging**: Generates tags from folder structure, filenames, and audio metadata
- **🗃️ SQLite Database**: Fast, reliable storage with full-text search and advanced filtering
- **🎵 Audio Streaming**: Built-in audio player with HTTP range request support
- **📥 File Downloads**: Direct download functionality for easy file sharing and backup
- **📱 Responsive Web UI**: Modern, mobile-friendly interface with real-time updates and file downloads
- **🔧 Configuration System**: Comprehensive JSON-based configuration with environment-specific settings
- **🥧 Raspberry Pi Optimized**: Special optimizations for low-resource environments
- **🔄 Real-time Updates**: Live file system monitoring with instant UI updates
- **📊 Analytics**: Database statistics and performance monitoring
- **🛡️ Security**: Path traversal protection and configurable access control

## 🏗️ Architecture

```
sfx-library-viewer-server/
├── src/                    # Backend source code
│   ├── server.js          # Main server application
│   ├── config.js          # Configuration loader
│   ├── database.js        # SQLite database operations
│   ├── fileScanner.js     # File system scanner with auto-tagging
│   └── routes.js          # API routes and endpoints
├── config/                # Configuration files
│   ├── default.json       # Base configuration
│   ├── development.json   # Development overrides
│   ├── production.json    # Production settings
│   ├── raspbian.json      # Raspberry Pi optimizations
│   └── README.md          # Configuration documentation
├── public/                # Frontend files
│   └── index.html         # Web interface
├── data/                  # Database storage (auto-created)
├── audio_library/         # Your audio files (auto-created)
└── logs/                  # Log files (auto-created)
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Server

```bash
# Development mode
npm run dev

# Production mode
npm run prod

# Raspberry Pi mode
npm run raspbian
```

### 3. Access the Interface

Open your browser and navigate to:
- **Local**: `http://localhost:3000`
- **Network**: `http://YOUR_IP:3000`

### 4. Add Your Audio Files

Place your audio files in the `audio_library/` directory (created automatically):

```
audio_library/
├── UI/
│   ├── Buttons/
│   └── Notifications/
├── Music/
│   ├── Ambient/
│   └── Tracks/
└── SFX/
    ├── Explosions/
    └── Footsteps/
```

The server will automatically scan and catalog all audio files!

## 🔧 Configuration System

The server uses a sophisticated configuration system with environment-specific settings:

### Configuration Files

- **`config/default.json`** - Base configuration with all default values
- **`config/development.json`** - Development environment settings
- **`config/production.json`** - Production optimizations
- **`config/raspbian.json`** - Raspberry Pi specific settings
- **`config/local.json`** - Your local overrides (git-ignored)

### Environment Variables

Override any setting using environment variables:

```bash
# Basic settings
export NODE_ENV=production
export PORT=8080
export LIBRARY_PATH=/mnt/usb/audio
export DATABASE_PATH=/var/lib/sfx-viewer/library.db

# Scanner settings
export SCAN_INTERVAL=300000
export WATCH_FILES=true

# Start server
npm start
```

### Configuration Priority

1. **default.json** (base settings)
2. **{environment}.json** (environment-specific)
3. **local.json** (your local overrides)
4. **Environment variables** (highest priority)

## 📁 Audio Library Management

### Supported Formats

- **Uncompressed**: WAV, AIFF
- **Compressed Lossless**: FLAC
- **Compressed Lossy**: MP3, AAC, OGG, M4A, WMA

### Automatic Tagging

The system automatically generates tags from:

- **Directory Structure**: `UI/Buttons/click.wav` → tags: `ui`, `buttons`, `click`
- **Filename Patterns**: `explosion_big_01.wav` → tags: `explosion`, `big`
- **File Metadata**: Size categories, format types, estimated duration
- **Custom Rules**: Configurable tagging logic

### File Organization Best Practices

```
audio_library/
├── UI/                    # User interface sounds
│   ├── Buttons/           # Button clicks, hovers
│   ├── Notifications/     # Alerts, confirmations
│   └── Menu/              # Menu sounds
├── SFX/                   # Sound effects
│   ├── Environment/       # Ambient, nature
│   ├── Actions/           # Footsteps, doors
│   └── Combat/            # Weapons, explosions
├── Music/                 # Musical content
│   ├── Background/        # Background music
│   ├── Stingers/          # Short musical pieces
│   └── Loops/             # Looping tracks
└── Voices/                # Vocal content
    ├── Narration/         # Voice-over
    └── Characters/        # Character voices
```

## 🛠️ API Endpoints

### Files
- `GET /api/files` - List files with filtering and sorting
- `GET /api/files/:id` - Get specific file details
- `DELETE /api/files/:id` - Delete a file
- `GET /api/audio/:id` - Stream audio file
- `GET /api/audio/:id?download=true` - Download audio file

### Metadata
- `GET /api/extensions` - Get file extensions with counts
- `GET /api/tags` - Get popular tags
- `GET /api/stats` - Get database statistics

### Management
- `POST /api/scan` - Trigger manual library scan
- `GET /api/scan/status` - Get scanner status
- `GET /api/health` - Health check endpoint

## 🥧 Raspberry Pi Deployment

### System Requirements

- **Raspberry Pi 3B+** or newer recommended
- **MicroSD Card**: 16GB+ (Class 10)
- **RAM**: 1GB+ available
- **Node.js**: 14.0.0 or newer

### Installation on Raspberry Pi

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Clone and setup project
git clone <your-repo>
cd sfx-library-viewer-server
npm install

# Start with Raspberry Pi optimizations
npm run raspbian
```

### Raspberry Pi Optimizations

The `raspbian.json` configuration includes:

- **Low Memory Mode**: Reduced memory usage
- **Optimized Scanning**: Lower concurrency, smaller batches
- **SD Card Friendly**: Reduced database writes
- **Performance Tuning**: CPU and I/O optimizations

### Running as a Service

Create a systemd service for automatic startup:

```bash
# Create service file
sudo nano /etc/systemd/system/sfx-viewer.service
```

```ini
[Unit]
Description=SFX Library Viewer Server
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/sfx-library-viewer-server
Environment=NODE_ENV=raspbian
Environment=PORT=3000
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start service
sudo systemctl enable sfx-viewer
sudo systemctl start sfx-viewer
sudo systemctl status sfx-viewer
```

## 🔍 Database Schema

The SQLite database uses an optimized schema with:

- **Files Table**: Core file metadata and paths
- **Tags Table**: Tag names with usage statistics
- **File-Tags Junction**: Many-to-many relationship
- **Full-Text Search**: FTS5 virtual table for fast searching
- **Indexes**: Optimized for common query patterns

## 🎛️ Advanced Configuration

### Performance Tuning

```json
{
  "scanner": {
    "scanInterval": 300000,
    "batchSize": 100,
    "parallel": true
  },
  "database": {
    "pragmas": {
      "cache_size": 2000,
      "mmap_size": 268435456
    }
  }
}
```

### Custom Tagging Rules

```json
{
  "tagging": {
    "customRules": {
      "sizeCategories": {
        "tiny": 102400,
        "small": 1048576,
        "medium": 10485760
      }
    }
  }
}
```

### Security Settings

```json
{
  "security": {
    "rateLimiting": {
      "enabled": true,
      "max": 1000
    },
    "pathTraversal": {
      "strictMode": true
    }
  }
}
```

## 📊 Monitoring & Maintenance

### Health Checks

```bash
# Check server status
curl http://localhost:3000/api/health

# Get statistics
curl http://localhost:3000/api/stats

# Check scanner status
curl http://localhost:3000/api/scan/status
```

### Database Maintenance

```bash
# Manual scan trigger
curl -X POST http://localhost:3000/api/scan

# View logs
tail -f logs/application.log
```

### Backup & Recovery

Database backups are automatically created when enabled in configuration:

```json
{
  "database": {
    "backup": {
      "enabled": true,
      "interval": 86400000,
      "keepCount": 7,
      "path": "./backups"
    }
  }
}
```

## 🛟 Troubleshooting

### Common Issues

**Port Already in Use**
```bash
export PORT=3001
npm start
```

**Permission Errors**
```bash
sudo chown -R $USER:$USER audio_library/
chmod -R 755 audio_library/
```

**Database Lock Errors**
- Stop the server
- Delete any `.db-wal` and `.db-shm` files
- Restart the server

**Memory Issues on Raspberry Pi**
- Set `lowMemoryMode: true` in configuration
- Reduce `batchSize` in scanner settings
- Increase swap file size

### Logging

Enable detailed logging:

```bash
export LOG_LEVEL=debug
npm start
```

### Performance Monitoring

The server provides performance metrics:
- File scan duration
- Database query times
- Memory usage statistics
- Request response times

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details.

---

**Built with ❤️ for audio professionals and Raspberry Pi enthusiasts!**