# VODlibrary

A simple video sharing/viewing software similar to Plex. This application scans a video library, creates thumbnails, and allows you to view and share videos with performance optimizations like server-side caching and CDN integration.

## Features

- Video library scanning
- Multiple video directory support
- Thumbnail generation
- Video streaming with adaptive quality
- Server-side caching for frequently accessed videos
- CDN integration for faster global delivery
- Sharing capabilities
- Responsive web interface

## Performance Optimizations

### Server-Side Caching

VODlibrary now includes server-side caching to improve performance and reduce disk I/O:

- Frequently accessed video segments are cached in memory
- Intelligent caching based on video popularity
- Configurable cache size and TTL
- Automatic cache cleanup using LRU (Least Recently Used) strategy

### CDN Integration

For improved global delivery, VODlibrary supports integration with Content Delivery Networks:

- Support for multiple CDN providers (Cloudflare, BunnyCDN, KeyCDN, or custom)
- Configurable CDN settings
- Optional signed URLs for secure access
- Automatic redirection to CDN for video content

## Running as a Windows Service (Optional)

This application can be installed as a Windows service to run automatically in the background when your computer starts.

**Prerequisites:**
- Node.js installed and added to your system PATH.

**Installation:**
1. Open a Command Prompt or PowerShell **as Administrator**.
2. Navigate to the project directory (`cd path\to\VODlibrary`).
3. Run the command: `npm run install-service`

This will register the service named "VODlibraryService" and attempt to start it.

**Uninstallation:**
1. Open a Command Prompt or PowerShell **as Administrator**.
2. Navigate to the project directory.
3. Run the command: `npm run uninstall-service`

**Managing the Service:**
- Use the Windows Services application (`services.msc`) to start, stop, or configure the "VODlibraryService".
- Alternatively, use command line (as Administrator):
    - `sc start VODlibraryService`
    - `sc stop VODlibraryService`
    - `sc query VODlibraryService`

**Logging:**
- Service logs (output from `console.log`/`console.error`) can be found in the Windows Event Viewer under "Windows Logs" > "Application" (Source: "VODlibraryService").

## License

ISC
