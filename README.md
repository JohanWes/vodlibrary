# VODlibrary

A self-hosted video library for browsing, streaming, and sharing video clips. Scans directories for video files, generates thumbnails and hover preview clips, and provides a web interface for viewing.

## Features

- Multi-directory video library scanning with file watcher for auto-detection
- Thumbnail and hover preview clip generation via FFmpeg (640 px H.264 by default, optional AV1 presets)
- Video streaming with HTTP range requests
- Death timestamp markers on the player timeline (from WarcraftRecorder metadata)
- Share links (optionally starting at a timestamp) with optional authentication
- Optional CDN redirects for video streams (only when authentication is off)
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
npm run build         # Builds the frontend (web/) into dist/
npm start
```

After pulling frontend changes, run `npm run build` again and restart the server (it caches the page templates). For frontend development run `npm run dev` (server) and `npm run dev:web` (Vite at http://localhost:5173, proxying the API to the server).

### Linux (systemd user service)

Save a unit like this as `~/.config/systemd/user/vodlibrary.service` (adjust the path to your checkout):

```ini
[Unit]
Description=VODlibrary video streaming service

[Service]
WorkingDirectory=/home/you/vodlibrary
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now vodlibrary
journalctl --user -u vodlibrary -f
```

Without systemd, `scripts/start_server.sh` starts the server from the repo root and logs to `server.log` (the previous run is kept as `server.log.1`).

### Windows Service

```bash
# Install (run as Administrator)
npm run install-service

# Uninstall
npm run uninstall-service
```

Manage via `services.msc` or `sc start/stop VODlibraryService`.

## Configuration (.env)

See `.env.example` for a commented template. Relative paths resolve from the directory the server is started in.

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `8005` |
| `HOST_IP` | Bind address | `localhost` |
| `BASE_PATH` | URL prefix (for reverse proxy) | |
| `VODS_NAME` | Site name, shown verbatim in page titles, the header and share previews (e.g. `EvandisVods`) | `VODlibrary` |
| `LOG_LEVEL` | `debug` enables verbose logging | `info` |
| `TRUST_PROXY` | Which proxies may set `X-Forwarded-For` (used for the login throttle): `true`, `false`, a hop count, or an Express trust list such as `loopback, 10.0.0.0/8`. The default fits Caddy (or another reverse proxy) on the same host; direct clients are identified by their socket address | `loopback` |
| `CSP_REPORT_ONLY` | `true` sends the Content-Security-Policy as `Content-Security-Policy-Report-Only` (violations are only logged in the browser console) | `false` |
| `VIDEO_LIBRARY` | Comma-separated list of video directories (required) | |
| `WATCHER_CONCURRENCY` | Files the watcher processes in parallel | `2` |
| `WATCHER_DEBOUNCE_MS` | Watcher event debounce (ms) | `500` |
| `THUMBNAIL_TIME` | Whole seconds into the video to capture the thumbnail (640 px wide JPEG) | `5` |
| `THUMBNAIL_TIMEOUT_SECONDS` | Timeout for each ffprobe and thumbnail ffmpeg run | `60` |
| `THUMBNAIL_CACHE_DIR` | Where to store generated thumbnails | `./public/thumbnails` |
| `ENABLE_PREVIEWS` | Set `false` to skip hover preview generation | `true` |
| `PREVIEW_DURATION` | Duration of hover preview clips (seconds) | `10` |
| `PREVIEWS_CACHE_DIR` | Where to store generated preview clips | `./public/previews` |
| `PREVIEW_QUALITY` | Preview preset: `card` (640 px H.264, at most 700 kbps, 30 fps), `low` (480 px H.264), `medium` / `high` (720 / 1080 px SVT-AV1), `amd_av1` (1080 px AMF AV1); AV1 presets fall back to H.264 | `card` |
| `PREVIEW_MAX_CONCURRENT` | Maximum concurrent preview encodes | `2` |
| `PREVIEW_TIMEOUT_SECONDS` | Timeout for one preview encode | `300` |
| `PREVIEW_MAX_ATTEMPTS` | Failed preview encodes are retried up to this many times per version of a file | `2` |
| `FFMPEG_NICENESS` | CPU niceness (0-19) for ffmpeg/ffprobe children | `10` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | ffmpeg / ffprobe binaries | `ffmpeg` / `ffprobe` from `PATH` |
| `DB_DIR` | Database directory | `./data/db` |
| `ENABLE_AUTH` | Enable login page (5 failed logins in 15 minutes lock that IPv4 address or IPv6 /64 out for 15 minutes) | `false` |
| `SESSION_KEY` | Password required to log in (required when authentication is enabled) | |
| `SESSION_SECRET` | High-entropy secret used to sign session cookies (required when authentication is enabled) | |
| `AUTH_COOKIE_SECURE` | Mark auth/share cookies Secure; enable for an HTTPS public site | `false` |
| `SHARE_TOKEN_SECRET` | High-entropy secret used to sign scoped share tokens (required for share links when authentication is enabled) | |
| `SHARE_BASE_URL` | Public http(s) origin for share links (e.g. `https://example.com`); creating a share link returns 500 without it | |
| `SSE_MAX_CLIENTS` | Maximum concurrent live-update connections | `100` |
| `CDN_ENABLED` | Redirect video streams to the CDN (ignored when authentication is on); the CDN origin is added to the CSP `media-src` | `false` |
| `CDN_PROVIDER` | `custom`, `cloudflare`, `bunny` or `keycdn` | `custom` |
| `CDN_BASE_URL` | CDN base URL; may include a path (e.g. `https://x.b-cdn.net/vods`) | |
| `CDN_TOKEN` | For `bunny`: the token-authentication key used to sign URLs | |
| `CDN_SIGNED_URLS` | `custom` provider: add an HMAC `expires`/`signature` query | `false` |
| `CDN_SIGNED_URLS_SECRET` | Secret for signed CDN URLs | |
| `ADVANCED_SEARCH_ENABLED` | Enable LLM-powered search (exposed to the UI via `/api/config`; results are cached per query for 10 minutes, so paging does not re-run the LLM) | `false` |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM search | |
| `OPENROUTER_MODEL` | Model to use for LLM search | `google/gemini-2.5-flash-preview-05-20:thinking` |

## Security headers

Every response carries `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` (plus the CDN origin in `media-src` when the CDN is enabled). Fonts and Plyr are bundled into the app, so no third-party origin is allowed. Set `CSP_REPORT_ONLY=true` to trial a change without enforcing it.

With authentication on, only the login page and the files it and a share-link viewer need (`login.html` and the build's `assets/` directory: code, styles, fonts and icons, no data) are served before login.

## Maintenance

Run the commands below from the repo root with the server stopped; the paths shown are the defaults, so use your `.env` values if you set them.

- **Regenerate oversized thumbnails and previews** (after upgrading from a version that stored full-size media): delete the contents of the thumbnail and preview cache directories, then start the server. The startup scan regenerates missing thumbnails and requeues missing preview clips at the current size. Removing a video's row now also deletes its thumbnail and clip, so orphans no longer accumulate.
  ```bash
  find "${THUMBNAIL_CACHE_DIR:-public/thumbnails}" "${PREVIEWS_CACHE_DIR:-public/previews}" -mindepth 1 -delete
  ```
- **Compact the database once**: sidecar metadata is now stored in a slim form, so after the first full scan following the upgrade, stop the server and run once:
  ```bash
  sqlite3 "${DB_DIR:-data/db}/videos.db" 'VACUUM;'
  ```
- **Locked out of the login page**: 5 failed logins within 15 minutes lock that IPv4 address or IPv6 /64 for 15 minutes (`429` with `Retry-After`). Wait it out or restart the server; the throttle is in memory.

## License

ISC
