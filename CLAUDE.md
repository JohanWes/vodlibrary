# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

VODlibrary is a Node.js video sharing/viewing application similar to Plex. It scans video libraries, generates thumbnails, and serves videos through a web interface with performance optimizations including server-side caching and CDN integration.

## Common Development Commands

```bash
# Start the application
npm start

# Run in development mode with auto-restart
npm run dev

# Install as Windows service
npm run install-service

# Uninstall Windows service
npm run uninstall-service

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

## Architecture

### Core Components

- **server.js**: Main Express server with authentication, CDN integration, and real-time file watching
- **db/database.js**: SQLite database interface for video metadata storage
- **lib/scanner.js**: Video library scanning with FFmpeg integration for metadata extraction
- **lib/cache.js**: Server-side video segment caching system
- **lib/cdn.js**: CDN abstraction layer supporting multiple providers
- **lib/thumbnail.js**: Video thumbnail generation using FFmpeg
- **lib/preview.js**: Hardware-accelerated video preview generation
- **routes/api.js**: REST API endpoints for video operations
- **public/**: Static web assets (HTML, CSS, JS)

### Key Features

- **Real-time file watching**: Uses chokidar to monitor video directories and automatically update the database
- **Server-sent events (SSE)**: Real-time updates to connected clients about library changes
- **Authentication system**: Optional session-based authentication with cookie support
- **Video streaming**: Range-request support with intelligent caching for performance
- **Thumbnail generation**: Automatic thumbnail creation using FFmpeg at configurable timestamps
- **Hardware-accelerated video previews**: Generates 10-second AV1 previews using GPU (with H.264 fallback) for hover functionality.
- **CDN integration**: Support for multiple CDN providers with signed URL capability

### Configuration

Environment configuration is managed through `.env` file (see `.env.example`). Key variables:
- `VIDEO_LIBRARY`: Comma-separated list of video directories to scan
- `SESSION_KEY`: Authentication key (leave empty to disable auth)
- `ENABLE_AUTH`: Master switch for authentication (true/false)
- CDN and caching settings for performance optimization

### Database Schema

SQLite database (`videos.db`) with single `videos` table containing:
- Video metadata (title, path, duration, dimensions)
- Thumbnail paths
- Death timestamps (from companion JSON files)
- Added dates for sorting

### FFmpeg Dependencies

Application requires FFmpeg and FFprobe for:
- Video duration extraction
- Thumbnail generation
- Video dimension detection
- Metadata parsing

The application expects these tools to be available in system PATH.

## Testing

The project uses Jest for testing with a comprehensive test setup:

### Test Structure
- **test/setup.js**: Global test configuration with mocks for FFmpeg and database
- **test/backend/**: Server-side API and integration tests
- **test/frontend/**: Client-side JavaScript tests using jsdom
- **test/performance/**: Performance and memory usage tests

### Test Environment
- Uses `.env.test` for test-specific environment variables
- Mocks FFmpeg operations to avoid requiring actual video processing
- Includes database mocking for isolated unit tests
- Frontend tests use jsdom environment for DOM manipulation testing

### Running Tests
- Individual test files can be run with: `npm test -- test/path/to/specific.test.js`
- Coverage reports show test coverage for lib/, routes/, and public/js/ directories
- Test watch mode automatically reruns tests on file changes
