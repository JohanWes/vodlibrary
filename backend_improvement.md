# Backend Improvements Roadmap

## Objective
Improve perceived speed, smoothness, and reliability through backend and "invisible" changes that reduce latency, startup delay, buffering risk, and operational instability.

## Prioritization Framework
- **Quick wins**: Low-to-medium effort changes with immediate UX impact.
- **High impact**: Larger changes with major long-term gains for scale and responsiveness.
- **Order**: Fix correctness and event-loop blocking first, then optimize throughput.
- **Scale sensitivity**: This repo appears personal/small-team scale, so defer heavier architecture until quick wins are complete and measured.

## Quick Wins (Do First)

### 1) Serve Immediately; Scan in Background
- **Why**: Server startup is currently blocked by full library scan.
- **Expected UX impact**: App is usable immediately after process start.
- **Effort**: Small.
- **Primary files**: `server.js`, `lib/scanner.js`
- **Actions**:
  - Start `app.listen(...)` before initial `scanLibrary(...)`.
  - Trigger initial scan asynchronously and expose status via `/api/scan/status`.
  - Guard missing/empty `VIDEO_LIBRARY` in both startup and scanner paths.

### 2) Reduce List API Payload Size (High Perceived-Speed Win)
- **Why**: `/api/videos` currently fetches all columns, including heavy JSON fields not needed for the grid.
- **Expected UX impact**: Faster initial load, pagination, and search list rendering.
- **Effort**: Small.
- **Primary files**: `db/database.js`, `routes/api.js`
- **Actions**:
  - Replace `SELECT *` for list calls with a targeted column projection.
  - Keep heavy fields (`metadata`, preview manifests, large JSON) for detail endpoint only.

### 3) De-duplicate Preview/Static Route Definitions (Dead-Code Removal)
- **Why**: Duplicate route declarations are not just drift risk; some are effectively dead and create auth/behavior ambiguity.
- **Expected UX impact**: Fewer hidden routing bugs and safer future optimization.
- **Effort**: Small.
- **Primary files**: `server.js`, `routes/api.js`
- **Actions**:
  - Keep one canonical implementation per endpoint.
  - Remove duplicate preview/static mounts and ensure one middleware order.
  - Make auth exposure explicit for preview endpoints rather than implicit by route order.

### 4) Fix Segment Cache Correctness (Data Integrity)
- **Why**: Current cache behavior can mix incompatible segment models (fixed vs quality-sized segments), which is a correctness bug.
- **Expected UX impact**: Prevents corrupted segment reuse, playback jumps, and unreliable preloading.
- **Effort**: Small-to-medium.
- **Primary files**: `server.js`, `routes/api.js`, `lib/cache.js`
- **Actions**:
  - Use cache keys that include all identity dimensions (`videoId`, `segmentNumber`, `quality` and/or byte window).
  - Never serve cached data unless it exactly matches requested range semantics.
  - Unify segment model between stream endpoint and segment endpoint, or isolate their cache namespaces.

### 5) Remove Sync Filesystem Calls from Hot Request Paths
- **Why**: `*Sync` disk calls block the event loop; repeated `player.html` read/transform is the highest-value fix here.
- **Expected UX impact**: Better request latency under concurrent viewers.
- **Effort**: Small.
- **Primary files**: `server.js`, `routes/api.js`
- **Actions**:
  - Cache `player.html` template once at startup.
  - Keep per-request OG injection dynamic, but avoid per-request disk reads.
  - Replace request-path `statSync/existsSync` with async equivalents where practical.

### 6) Queue Watcher Work to Prevent Burst Overload
- **Why**: Large file drops can trigger heavy probe/thumbnail work concurrently.
- **Expected UX impact**: Prevents temporary sluggishness during ingest bursts.
- **Effort**: Medium.
- **Primary files**: `server.js`, `lib/scanner.js`
- **Actions**:
  - Introduce small-concurrency queue for watcher `add`/`unlink` events.
  - Debounce/coalesce burst events.

### 7) Reduce Noisy Hot-Path Logging
- **Why**: Excessive logs increase I/O overhead and reduce signal quality.
- **Expected UX impact**: Modest latency improvements, better observability.
- **Effort**: Small.
- **Primary files**: `server.js`, `lib/llm.js`, `lib/cache.js`
- **Actions**:
  - Keep high-volume routes on debug-level logs only.
  - Remove large payload dumps in LLM path.

### 8) Fix `getVideosPaginated` Promise Anti-Pattern
- **Why**: `new Promise(async (...) => ...)` in DB code is a known footgun and can create hard-to-debug rejection behavior.
- **Expected UX impact**: Primarily correctness/reliability; avoids intermittent failure modes.
- **Effort**: Small.
- **Primary files**: `db/database.js`
- **Actions**:
  - Refactor `getVideosPaginated` to avoid async Promise constructor usage.
  - Keep one consistent async style and explicit error paths.

### 9) Harden SSE (Lower Priority at Current Scale)
- **Why**: SSE stability gaps are real but lower urgency for low client counts.
- **Expected UX impact**: Better long-session reliability; limited short-term payoff.
- **Effort**: Small-to-medium.
- **Primary files**: `server.js`, `public/js/main.js`
- **Actions**:
  - Add heartbeat comments (`: ping`) and retry hints.
  - Add dead-client cleanup on write failures.
  - Use exponential backoff + jitter for client reconnect.

## High-Impact Changes (Next Phase / Scale-Driven)

### A) Introduce Search Indexing (FTS5)
- **Why**: `%LIKE%` title search degrades with larger libraries.
- **Expected UX impact**: Major search responsiveness improvement once data grows.
- **Effort**: Medium-to-large.
- **Primary files**: `db/database.js`, `routes/api.js`
- **Actions**:
  - Add FTS5 table and sync triggers.
  - Route search to FTS query with relevance sorting.
  - Treat as scale trigger, not immediate prerequisite.

### B) Advanced Search Re-architecture (LLM Path)
- **Why**: N+1 enrichment remains; candidate limiting already exists but can be improved.
- **Expected UX impact**: Faster advanced search, lower timeout risk.
- **Effort**: Medium-to-large.
- **Primary files**: `routes/api.js`, `db/database.js`, `lib/llm.js`
- **Actions**:
  - Keep and refine candidate limiting/pre-ranking before LLM.
  - Cache metadata candidate set with TTL.
  - Replace per-result DB fetches with one batched query.

### C) Background Job Scheduler for Scan/Preview/Thumbnail Work
- **Why**: Useful if watcher queueing is insufficient or workload/client count grows.
- **Expected UX impact**: Higher stability at larger scale.
- **Effort**: Medium-to-large.
- **Primary files**: `lib/scanner.js`, `lib/preview.js`, `server.js`
- **Actions**:
  - Central queue with task priorities and concurrency caps.
  - Prioritize user-facing requests over background generation.
  - Defer unless quick-win queue controls do not meet targets.

### D) Better Segment Caching Strategy
- **Why**: Current in-memory cache can have expensive cleanup and uncertain warm-up behavior.
- **Expected UX impact**: Smoother first seconds of playback under concurrent viewers.
- **Effort**: Medium.
- **Primary files**: `lib/cache.js`, `server.js`, `routes/api.js`
- **Actions**:
  - Add explicit LRU metadata (avoid full cache scans in hot path).
  - Prewarm first segment for recently viewed/popular videos.
  - Revisit popularity threshold logic so warming can occur before cache hits.

### E) Add Backend Performance Instrumentation
- **Why**: Need measurable p50/p95 evidence before/after improvements.
- **Expected UX impact**: Enables disciplined tuning and regression detection.
- **Effort**: Medium.
- **Primary files**: `server.js`, `routes/api.js`, `lib/*`
- **Actions**:
  - Add lightweight per-route timing in the first implementation pass.
  - Track scan duration, queue depth, cache hit rate, and SSE client health.
  - Define latency SLOs for list, detail, preview, and stream startup.

## Recommended Implementation Order
1. Startup non-blocking scan + env guards.
2. Reduce list payload and fix pagination query anti-pattern.
3. De-duplicate endpoints/routes and make auth behavior explicit.
4. Cache correctness fix for segment integrity.
5. Remove sync I/O in hot routes (`player.html` caching first).
6. Watcher queueing and burst control.
7. Logging cleanup and lightweight instrumentation.
8. SSE hardening.
9. Scale-driven items: FTS, advanced-search batching refinement, scheduler expansion.

## Success Criteria
- Time-to-first-response after process start: near-immediate.
- `/api/videos` p95 latency reduced under load.
- Fewer playback stalls during first 10-20 seconds.
- Stable SSE updates over long sessions.
- Faster search response time on large libraries.
