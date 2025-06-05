# Tech Context: VODlibrary

## Core Stack
- **Backend:** Node.js + Express.js
- **Database:** SQLite with better-sqlite3
- **Frontend:** HTML5, CSS3, JavaScript ES6+
- **Package Manager:** npm

## Key Dependencies
- **Authentication:** cookie-parser for session management
- **File Monitoring:** chokidar for real-time library updates
- **Video Processing:** ffmpeg for thumbnail generation
- **UI Enhancement:** GSAP for smooth scrolling
- **Caching:** Custom server-side video segment caching

## Environment
- **Configuration:** .env files for settings
- **Version Control:** Git with .gitignore
- **Deployment:** Standalone Node.js server

## Security & Performance
- **Auth:** Session key with HTTP-only cookies
- **Caching:** Multi-layer (server-side segments, HTTP headers, client preloading)
- **Real-time:** Server-Sent Events for live updates
- **Database:** Indexed for search/sort performance

## Data Dependencies
- Video files in configured library paths
- Optional companion .json files for death timestamps
- Generated thumbnails and preview frames
