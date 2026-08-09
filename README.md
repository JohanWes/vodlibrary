# VODlibrary

A self-hosted video library for browsing, streaming, and sharing video clips. Scans directories for video files, generates thumbnails and hover preview clips, and provides a web interface for viewing.

## Features

- Multi-directory video library scanning with file watcher for auto-detection
- Thumbnail and hover preview clip generation (AV1/H.264 via FFmpeg)
- Video streaming with segment-based caching
- Death timestamp markers on the player timeline (from WarcraftRecorder metadata)
- Share links with optional authentication
- CDN integration
- LLM-powered search (via OpenRouter)

## Setup

### Prerequisites

- Node.js 22 or newer
- FFmpeg and ffprobe in your PATH

### Installation

```bash
git clone https://github.com/JohanWes/vodlibrary.git
cd vodlibrary
npm install
cp .env.example .env  # Edit with your settings
npm start
```

### Linux (KDE Autostart)

The `scripts/start_server.sh` script can be added to KDE autostart to run on login.

### Windows Service

```bash
# Install (run as Administrator)
npm run install-service

# Uninstall
npm run uninstall-service
```

Manage via `services.msc` or `sc start/stop VODlibraryService`.

## Configuration (.env)

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `8005` |
| `HOST_IP` | Bind address | `localhost` |
| `BASE_PATH` | URL prefix (for reverse proxy) | `` |
| `VIDEO_LIBRARY` | Comma-separated list of video directories | |
| `THUMBNAIL_TIME` | Seconds into video to capture thumbnail | `5` |
| `THUMBNAIL_CACHE_DIR` | Where to store generated thumbnails | `./public/thumbnails` |
| `PREVIEW_DURATION` | Duration of hover preview clips (seconds) | `10` |
| `PREVIEWS_CACHE_DIR` | Where to store generated preview clips | `./public/previews` |
| `PREVIEW_QUALITY` | Preview quality preset: `low`, `medium`, `high` | `high` |
| `DB_DIR` | Database directory | `./data/db` |
| `VODS_NAME` | Display name for the site | `VODlibrary` |
| `ENABLE_AUTH` | Enable login page | `false` |
| `SESSION_KEY` | Password required to log in | |
| `SESSION_SECRET` | High-entropy secret used to sign session cookies (required when authentication is enabled) | |
| `AUTH_COOKIE_SECURE` | Mark auth/share cookies Secure; enable for an HTTPS public site | `false` |
| `SHARE_TOKEN_SECRET` | High-entropy secret used to sign scoped share tokens | |
| `SHARE_BASE_URL` | Public URL for share links (e.g. `https://example.com`) | |
| `SSE_MAX_CLIENTS` | Maximum concurrent live-update connections | `100` |
| `CACHE_MAX_SIZE` | Server-side video cache size in MB | `500` |
| `CACHE_TTL` | Cache TTL in seconds | `3600` |
| `CDN_ENABLED` | Enable CDN integration | `false` |
| `ADVANCED_SEARCH_ENABLED` | Enable LLM-powered search | `false` |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM search | |
| `OPENROUTER_MODEL` | Model to use for LLM search | `deepseek/deepseek-r1-0528` |

## License

ISC
