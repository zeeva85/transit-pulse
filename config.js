// config.js — single source of truth for all tuneable constants.
//
// Used by:
//   Server-side modules:  const config = require("./config");
//   Browser modules:      loaded via <script src="/config.js"> → window.APP_CONFIG
//
// How this file is structured:
//   Each section corresponds to one sub-system. Every constant has a one-line
//   comment saying which file(s) read it and what behaviour changes if you
//   modify it. Constants marked [LOCKED] must not be changed without explicit
//   user sign-off — they are either algorithm-critical (changing them would
//   silently break Python parity) or visually user-iterated.
//   Constants marked [ALGORITHM] are EKF / filter internals; edit only if you
//   understand the math and intend to retune both sides (JS + Python).

const config = {

  // ── Map coverage ────────────────────────────────────────────────────────────
  // Used by: router.js (Overpass tile fetch bounding boxes).
  // KL_BBOX: Klang Valley — Phase 1 router graph, always fetched on Railway.
  //   Covers KL + PJ + Subang + Shah Alam + Klang + Putrajaya + Rawang + Kajang.
  //   Format: minLat,minLon,maxLat,maxLon (Overpass convention).
  //   Widening this adds more nodes and increases RAM use at graph-build time.
  //   Cache is invalidated automatically when this value changes.
  // MY_BBOX: full Peninsular Malaysia — Phase 2 graph, only when
  //   FULL_MALAYSIA_GRAPH=true. Requires ~3 GB RAM to build.
  KL_BBOX: "2.75,101.25,3.45,101.95",
  MY_BBOX: "1.0,99.5,6.8,104.5",

  // ── Geocoding (MapTiler) ─────────────────────────────────────────────────────
  // Used by: public/main.js (trip planner geocode()).
  // GEOCODE_BBOX: restricts place-name search to this lon,lat bounding box so
  //   "Bangsar" resolves to KL, not a similarly named place elsewhere.
  //   Format: minLon,minLat,maxLon,maxLat (MapTiler/GeoJSON convention —
  //   different from Overpass which uses minLat,minLon,maxLat,maxLon).
  //   Widening the box helps for Selangor suburbs (Subang, Klang, Putrajaya).
  GEOCODE_BBOX: "101.30,2.80,102.10,3.55",

  // ── Map centre (KL) ─────────────────────────────────────────────────────────
  // Used by: public/main.js (initial MapLibre camera position and home button).
  // Changing lat/lon shifts where the map opens on page load.
  // Changing zoom changes the default zoom level (lower = more zoomed out).
  KL_CENTER: { lat: 3.0925, lon: 101.6733, zoom: 9.5 },

  // ── Map zoom bounds ──────────────────────────────────────────────────────────
  // Used by: public/main.js (MapLibre map initialization).
  // MAP_MIN_ZOOM: users cannot zoom out past this level (lower = more zoomed out).
  //   8 shows full KL + surroundings; set lower (e.g. 5) to allow country-level view.
  // MAP_MAX_ZOOM: users cannot zoom in past this level (higher = closer street view).
  //   18 is standard street level; 20 is the practical MapLibre maximum.
  MAP_MIN_ZOOM: 8,
  MAP_MAX_ZOOM: 18,

  // ── Map dim overlay ─────────────────────────────────────────────────────────
  // Used by: public/main.js (setMapDim). Applied when a route is active or a
  // bus is selected, so background traffic and trails don't compete visually.
  // DIM_FILL_OPACITY: MapLibre black fill layer over CARTO basemap tiles (0–1).
  //   0 = no dimming, 1 = fully opaque black.
  // DIM_DECK_OPACITY: CSS opacity on the deck.gl canvas (bus dots + trails).
  //   0 = invisible, 1 = fully opaque (no dimming).
  DIM_FILL_OPACITY: 0.25,
  DIM_DECK_OPACITY: 0.5,

  // ── Route line (trip planner result) ────────────────────────────────────────
  // Used by: public/main.js (drawRoute MapLibre layers).
  // Two layers: a white border underneath, then the coloured line on top.
  // Increasing ROUTE_LINE_WIDTH or ROUTE_BORDER_WIDTH widens the path.
  // ROUTE_LINE_OPACITY / ROUTE_BORDER_OPACITY both 0–1.
  ROUTE_LINE_COLOR:     "#1d9bf0",
  ROUTE_LINE_WIDTH:     4,
  ROUTE_LINE_OPACITY:   0.8,
  ROUTE_BORDER_COLOR:   "#ffffff",
  ROUTE_BORDER_WIDTH:   7,
  ROUTE_BORDER_OPACITY: 0.35,

  // ── Admin session ────────────────────────────────────────────────────────────
  // Used by: server.js (httpOnly cookie Max-Age), public/main.js (client timer).
  // Both sides must stay in sync — the cookie TTL governs the server; the JS
  // timer mirrors it so the UI removes admin controls at the right moment.
  // Value in milliseconds.
  ADMIN_SESSION_TTL_MS: 15 * 60 * 1000,   // 15 min

  // ── Router (OSM A* trip planner) ────────────────────────────────────────────
  // Used by: router.js.
  // ROUTER_TILE_ROWS / ROUTER_TILE_COLS: how the MY_BBOX is split into a grid
  //   of Overpass API requests. 3×3 = 9 tiles keeps each response below Node's
  //   ~512 MB string limit. Increasing reduces per-tile size but adds more
  //   round-trips and potential rate-limit hits.
  // ROUTER_INTER_TILE_DELAY: ms to wait between consecutive tile fetches.
  //   Prevents rate-limiting from kumi.systems / Overpass mirrors.
  // ROUTER_504_WAIT: ms to wait before retrying after a 504 Gateway Timeout.
  // ROUTER_MAX_SETTLED: A* node cap — stops runaway pathfinding on degenerate
  //   graphs. 600k nodes is sufficient for KL + full peninsula.
  ROUTER_TILE_ROWS:        3,
  ROUTER_TILE_COLS:        3,
  ROUTER_INTER_TILE_DELAY: 15_000,
  ROUTER_504_WAIT:         60_000,
  ROUTER_MAX_SETTLED:      600_000,

  // ── Live feed polling ────────────────────────────────────────────────────────
  // Used by: server.js (fetchFeed, fetchFeedBytes).
  // FEED_CACHE_BASE_MS: minimum ms between upstream GTFS-RT fetches. Upstream
  //   updates ~every 30 s; 25 s keeps us just under so we don't miss a tick.
  //   Clients may pass ?interval=N to /api/buses; effective cache window is
  //   max(FEED_CACHE_BASE_MS, (N-5)×1000).
  // FEED_RETRY_BACKOFFS_MS: wait durations between successive fetch attempts.
  //   Three values = three attempts total. data.gov.my has spotty TLS
  //   reliability; one cheap retry tier closes most gaps.
  // STALE_AGE_THRESHOLD_S: a bus whose GTFS-RT vehicle timestamp is older than
  //   this many seconds is flagged is_stale=true in the API response.
  FEED_CACHE_BASE_MS:       25_000,
  FEED_RETRY_BACKOFFS_MS:   [1000, 2000, 4000],
  STALE_AGE_THRESHOLD_S:    90,

  // ── Position history (live trail) ───────────────────────────────────────────
  // Used by: server.js (positionHistory deque, trail rendering).
  // MAX_POSITION_HISTORY: how many recent positions are kept per bus for trail
  //   rendering. Mirrors Python's MAX_POSITION_HISTORY=20 in busapp/config.py.
  //   Changing this changes how long the live trail appears on the map; it does
  //   NOT affect sparklines (sparklineHistory is uncapped, reset at midnight).
  // STATUS_DISTANCE_THRESHOLD_M: a bus is "Moving" if its displacement since
  //   the last tick exceeds this many metres OR its raw GPS speed > 1 km/h.
  //   Mirrors Python busapp/speeds/trust.py:detect_movement (distance_threshold_m=20).
  MAX_POSITION_HISTORY:          20,
  STATUS_DISTANCE_THRESHOLD_M:   20,

  // ── EKF (Extended Kalman Filter) ─────────────────────────────────────────────
  // Used by: speeds.js (applyEkfFilter). [ALGORITHM] — mirrors busapp/speeds/ekf.py.
  // EKF_MAX_SPEED_KMH: hard velocity clamp. Filtered velocity magnitude is
  //   capped at this before writing back to state. Divergence guard fires at
  //   EKF_DIVERGENCE_SPEED_KMH, which is higher — let the filter run before
  //   giving up.
  // EKF_MAX_GPS_JUMP_M: if the measured position is > this many metres from the
  //   predicted position, skip the update (trust the prediction instead). Guards
  //   against GPS teleports.
  // EKF_MAX_DT: dt is clamped to this before being used in F/Q. Prevents
  //   numerically exploding predictions after long bus absences.
  // EKF_LARGE_DT: if dt > this, reset velocity + covariance but keep position.
  //   Handles wakeup after long gaps without full re-initialization.
  // EKF_DIVERGENCE_SPEED_KMH / EKF_DIVERGENCE_COV_TRACE: if the post-update
  //   filtered speed OR the trace of P exceeds these, delete the state and
  //   return the raw measurement (safe fallback).
  // EKF_INIT_COVARIANCE: initial P diagonal value (identity × this).
  // EKF_MEAS_NOISE_VAR: diagonal of R (measurement noise matrix, metres²).
  //   Higher = trust GPS less, smoother path; lower = trust GPS more, noisier.
  // EKF_PROCESS_NOISE_HIGH / LOW: q scales the Q (process noise) matrix.
  //   HIGH is used when GPS speed disagrees with EKF estimate by more than
  //   EKF_SPEED_CHANGE_THRESHOLD_KMH, meaning the bus is accelerating/decelerating.
  // EKF_SPEED_CHANGE_THRESHOLD_KMH: threshold that selects between HIGH/LOW q.
  // EKF_MAHALANOBIS_THRESHOLD: if the innovation Mahalanobis distance > this,
  //   the Kalman gain K is scaled down by EKF_MAHALANOBIS_GAIN_SCALE — soft
  //   outlier rejection that doesn't fully ignore suspicious updates.
  // EKF_MAHALANOBIS_GAIN_SCALE: gain multiplier during Mahalanobis dampening.
  // EKF_INIT_VELOCITY_TICKS: bootstrap velocity from displacement for this many
  //   ticks after initialization before trusting the filter's own estimate.
  EKF_MAX_SPEED_KMH:              150,
  EKF_MAX_GPS_JUMP_M:             500,
  EKF_MAX_DT:                     120,
  EKF_LARGE_DT:                   90,
  EKF_DIVERGENCE_SPEED_KMH:       200,
  EKF_DIVERGENCE_COV_TRACE:       1000,
  EKF_INIT_COVARIANCE:            10,
  EKF_MEAS_NOISE_VAR:             25,
  EKF_PROCESS_NOISE_HIGH:         2,
  EKF_PROCESS_NOISE_LOW:          0.5,
  EKF_SPEED_CHANGE_THRESHOLD_KMH: 20,
  EKF_MAHALANOBIS_THRESHOLD:      3,
  EKF_MAHALANOBIS_GAIN_SCALE:     0.3,
  EKF_INIT_VELOCITY_TICKS:        2,

  // ── Trust-weighted speed ─────────────────────────────────────────────────────
  // Used by: speeds.js (computeTrustWeighted). Mirrors busapp/speeds/trust.py.
  // ROLLING_WINDOW: number of ticks in the rolling buffer for both speed and
  //   trust scores. Also used in busapp/config.py. A longer window smooths
  //   speed more but reacts slower to sudden changes.
  // TRUST_GPS_SPIKE_KMH: raw GPS readings above this are considered unreliable
  //   and receive a TRUST_GPS_SPIKE_PENALTY multiplier on their trust score.
  // TRUST_GPS_SPIKE_PENALTY: trust multiplier when GPS speed exceeds the spike
  //   threshold (0.1 = 10% weight — nearly ignored in the rolling average).
  // TRUST_NO_CALC_FALLBACK: trust score assigned when calculated_speed is
  //   unavailable (first tick for a bus, or bus was absent for one tick).
  ROLLING_WINDOW:             5,
  TRUST_GPS_SPIKE_KMH:        120,
  TRUST_GPS_SPIKE_PENALTY:    0.1,
  TRUST_NO_CALC_FALLBACK:     0.7,

  // ── Trail snapping to GTFS shapes ───────────────────────────────────────────
  // Used by: snap.js (snapTrail, snapPair, snapPoint). Mirrors busapp/ui/trails.py.
  // SNAP_PERP_THRESHOLD_M: max perpendicular distance from a polyline at which
  //   we'll snap a GPS point. Used for cross-route fallback and single-point
  //   augmentation. Points further than this get a straight chord or "gap".
  // SNAP_OWN_ROUTE_THRESHOLD_M: more generous threshold used when snapping to
  //   the bus's own route's shapes. GPS noise in KL urban canyons can push
  //   readings 200–400 m from the GTFS centreline.
  // SNAP_MAX_FALLBACK_CHORD_M: if two consecutive GPS points can't be snapped
  //   and the straight chord between them exceeds this, emit a "gap" instead of
  //   a misleading line across the map (e.g. bucket-boundary teleports).
  // SNAP_STICKINESS_THRESHOLD_M: Pass-18 rule — prefer the bus's previously
  //   chosen shape variant when its perp is within this much of the closest
  //   candidate. Suppresses spurious outbound↔inbound flipping when two route
  //   variants run along the same road.
  SNAP_PERP_THRESHOLD_M:       200,
  SNAP_OWN_ROUTE_THRESHOLD_M:  400,
  SNAP_MAX_FALLBACK_CHORD_M:   3000,
  SNAP_STICKINESS_THRESHOLD_M: 30,

  // ── Cross-day position model ─────────────────────────────────────────────────
  // Used by: cross-day.js (buildCrossDayModel, adjustRow).
  // Mirrors Python busapp/history.py:snap_augment_parquet.
  // CROSS_DAY_BUCKETS_PER_DAY: number of half-hour time slots in a day (48 = 24 h ÷ 30 min).
  //   Changing this changes the temporal resolution of the "typical position"
  //   lookup. Must match Python's equivalent half-hour logic.
  // CROSS_DAY_POSITION_JUMP_KM: if a bus's recorded position is > this many km
  //   from its cross-day median, it's considered corrupted and replaced with
  //   the median (adj_lat / adj_lon). Mirrors Python deviation_threshold_m / 1000.
  CROSS_DAY_BUCKETS_PER_DAY:    48,
  CROSS_DAY_POSITION_JUMP_KM:   2,

  // ── Heatmap accumulator ──────────────────────────────────────────────────────
  // Used by: heatmap.js.
  // HEATMAP_SAMPLES_PER_CELL: per-(bus_id, hour, mode) sample array is capped
  //   at this length to keep memory bounded. Older samples are evicted FIFO.
  //   At 1 sample/tick and ~30 s/tick, 60 ≈ 30 min of history per cell.
  // HEATMAP_HIST_CACHE_LIMIT: how many past dates are kept in the in-memory LRU
  //   cache. Raising this speeds up re-renders of recently viewed dates at the
  //   cost of more RAM (~50 MB per cached day).
  HEATMAP_SAMPLES_PER_CELL:  60,
  HEATMAP_HIST_CACHE_LIMIT:  5,

  // ── Learned-shapes promotion ─────────────────────────────────────────────────
  // Used by: learned-shapes.js. Mirrors busapp/history.py.
  // A bus on an "Unknown" route graduates to its own LRN_<bus_id> shape when:
  //   ≥ LEARNED_PROMOTION_MIN_DAYS distinct observation dates,
  //   ≥ LEARNED_PROMOTION_MIN_POINTS total positions accumulated, AND
  //   per-bucket median position spread ≤ LEARNED_PROMOTION_MAX_SPREAD_M.
  // All three thresholds must match between JS and Python — if you change one
  // here, update busapp/config.py to match.
  LEARNED_PROMOTION_MIN_DAYS:    3,
  LEARNED_PROMOTION_MIN_POINTS:  100,
  LEARNED_PROMOTION_MAX_SPREAD_M: 200,

  // ── Pooled medians cache ─────────────────────────────────────────────────────
  // Used by: pooled.js (computePooledMedians).
  // Result is cached for this long (ms). Recomputation walks all stored days
  // (~O(rows)); 1 hour is a reasonable balance between freshness and cost.
  // Cache also invalidates when any stored day file changes (fingerprint check).
  POOLED_CACHE_TTL_MS: 60 * 60 * 1000,   // 1 hour

  // ── JSONL store ──────────────────────────────────────────────────────────────
  // Used by: store.js.
  // STORE_BUFFER_FLUSH_MS: how often the write stream is poked to flush its
  //   internal buffer. Lower = more disk I/O but fewer lost rows on crash.
  // STORE_STREAM_IDLE_CLOSE_MS: a JSONL write stream that hasn't been written
  //   to for this long is closed and removed. Prevents fd accumulation when
  //   dates roll over.
  STORE_BUFFER_FLUSH_MS:        2_000,
  STORE_STREAM_IDLE_CLOSE_MS:   60_000,

  // ── Density map (historical view) ───────────────────────────────────────────
  // Used by: public/historical-view.js (binToGrid, computeCountThresholds,
  //   buildDensityCells, spatialSample).
  // DENSITY_GRID_SIZE_M: side length of each density polygon cell in metres.
  //   Smaller = finer granularity (more cells, slower render).
  //   Larger = coarser granularity (fewer cells, faster render).
  //   Must not be changed without re-verifying the Python PolygonLayer match.
  // DENSITY_SAMPLE_GRID_M: grid resolution used by spatialSample for the Speed
  //   (Traffic) HexagonLayer. This is ONLY applied in the speed branch —
  //   never applied to density PolygonLayer (would bias coloring).
  // DENSITY_SAMPLE_MAX_POINTS: maximum data points passed to the HexagonLayer.
  //   HexagonLayer aggregates internally and tolerates any count, but keeping
  //   it bounded improves deck.gl frame time.
  DENSITY_GRID_SIZE_M:          200,
  DENSITY_SAMPLE_GRID_M:        100,
  DENSITY_SAMPLE_MAX_POINTS:    3000,
};

// Expose as CommonJS module (server) and browser global (frontend).
if (typeof module !== "undefined") module.exports = config;
else window.APP_CONFIG = config;
