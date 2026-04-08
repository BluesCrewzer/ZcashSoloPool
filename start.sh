#!/bin/bash

# Zcash Solo Pool Startup Script

echo "Starting Zcash Solo Mining Pool..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    echo "Please install Node.js 14.x or higher"
    exit 1
fi

# Check if config.json exists
if [ ! -f "config.json" ]; then
    echo "Error: config.json not found"
    echo "Please copy config.example.json to config.json and configure it"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Start the pool
node index.js
