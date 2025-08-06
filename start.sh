#!/bin/bash

# SFX Library Viewer Startup Script
echo "SFX Library Viewer - Web Server Version"
echo "========================================"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    echo "   Download from: https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

echo "✅ npm version: $(npm --version)"

# Create directory structure if it doesn't exist
echo ""
echo "🔧 Setting up directory structure..."

if [ ! -d "public" ]; then
    mkdir -p public
    echo "   Created public/ directory"
fi

if [ ! -d "audio_library" ]; then
    mkdir -p audio_library
    mkdir -p audio_library/UI
    mkdir -p audio_library/Music
    mkdir -p audio_library/SFX
    echo "   Created audio_library/ directory with sample folders"
    echo "   📁 You can now add your audio files to the audio_library/ folder"
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo ""
    echo "📦 Installing dependencies..."
    npm install
    
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install dependencies"
        exit 1
    fi
    
    echo "✅ Dependencies installed successfully"
fi

# Check if required files exist
echo ""
echo "🔍 Checking required files..."

if [ ! -f "server.js" ]; then
    echo "❌ server.js not found. Please make sure all files are in place."
    exit 1
fi

if [ ! -f "public/index.html" ]; then
    echo "❌ public/index.html not found. Please make sure all files are in place."
    exit 1
fi

echo "✅ All required files found"

# Set default environment variables if not set
if [ -z "$PORT" ]; then
    export PORT=3000
fi

if [ -z "$LIBRARY_PATH" ]; then
    export LIBRARY_PATH="./audio_library"
fi

echo ""
echo "🚀 Starting SFX Library Viewer Server..."
echo "   Port: $PORT"
echo "   Library Path: $LIBRARY_PATH"
echo "   Web Interface: http://localhost:$PORT"
echo ""
echo "Press Ctrl+C to stop the server"
echo "================================"

# Start the server
npm start