// RapidKL bus tracker — Node.js MVP backend.
// Express server that fetches Malaysia's GTFS-RT vehicle-position feed,
// parses the protobuf, and exposes bus positions + static route metadata
// as JSON for the static frontend in public/.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const fetch = require("node-fetch");
const { transit_realtime } = require("gtfs-realtime-bindings");
const { parse } = require("csv-parse/sync");
const {
  applyEkfFilter,
  computeTrustWeighted,
  clearTrustBuffers,
  speedStateStats,
} = require("./speeds");
const {
  recordSample,
  buildHeatmap,
  clearLiveAccumulator,
  accumulatorStats,
  buildHistoricalHeatmap,
  MODES: HEATMAP_MODES,
} = require("./heatmap");
const { computeRouteClusters, computeHourOrder } = require("./cluster");
const {
  appendTick,
  loadDate,
  listDates,
  storeStats,
  klDate,
  DATA_DIR,
} = require("./store");
const { computePooledMedians } = require("./pooled");
const { createSnapper } = require("./snap");
const { correctOutliers, CORRECTION_METHODS } = require("./outliers");
const {
  getCrossDayModel,
  adjustRow,
  modelStats: crossDayStats,
} = require("./cross-day");
const {
  accumulateUnknownPositions,
  promoteLearnedShapes,
  stats: learnedShapesStats,
} = require("./learned-shapes");

const PORT = process.env.PORT || 3000;

// Git SHA used as cache-bust query string for CSS/JS assets.
// Falls back to a startup timestamp if git is unavailable.
let BUILD_VERSION = Date.now().toString(36);
try {
  BUILD_VERSION = execSync("git rev-parse --short HEAD", {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "ignore"],
  }).toString().trim();
} catch (_) {}
const FEED_URL =
  "https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana" +
  "?category=rapid-bus-kl";
// Upstream feed updates ~every 30 s. The default cache window is 25 s
// (slightly under) so we don't miss a tick. Clients can pass
// `?interval=<seconds>` to /api/buses to shift the floor; the effective
// cache window is `max(25, requestedInterval - 5)` so a 60 s slider gives
// a 55 s cache. Matches Python's `cache_ttl = max(interval, 30)` model.
const FEED_CACHE_BASE_MS = 25 * 1000;
const GTFS_DIR = path.join(__dirname, "gtfs_static");

// Position history sliding window — mirrors Python's MAX_POSITION_HISTORY=20.
// Each entry is { lat, lon, time (ms epoch), speed, calculated_speed,
// speed_kalman, weighted_speed }. Field names match the Python parquet schema
// (busapp/pipeline.py) — only `time` differs in value (ms-epoch vs datetime).
// Trail rendering reads this on the frontend.
const MAX_HISTORY = 20;
// Python doesn't time-prune position_history — entries fall off the
// `maxlen=20` deque naturally. We match that: no idle-prune timer here.
// EKF state, trust buffers, and the live heatmap accumulator are also NOT
// pruned per-tick (Python keeps them across bus absences within a day);
// instead they're cleared at KL midnight rollover via `maybeRunDayRollover`,
// matching Python `busapp/state.py:day_rollover`.

const app = express();

// Serve index.html with ?v=<git-sha> appended to all local CSS/JS URLs.
// index.html itself is never cached so the new version string reaches the
// browser on every deploy, forcing a cache miss on the renamed asset URL.
const INDEX_PATH = path.join(__dirname, "public", "index.html");
app.get(["/", "/index.html"], (_req, res) => {
  const html = fs.readFileSync(INDEX_PATH, "utf8").replace(
    /(<(?:link|script)[^>]+(?:href|src)=")(\.\/)?(\w[\w\-.]*\.(?:css|js))(")/g,
    (_, prefix, _dot, file, suffix) =>
      `${prefix}./${file}?v=${BUILD_VERSION}${suffix}`
  );
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// CSS/JS assets: cache forever — safe because index.html now references them
// with ?v=<git-sha>, so a new deploy produces a new URL = automatic cache bust.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".css") || filePath.endsWith(".js")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  },
}));

// ──────────────────────────────────────────────────────────────────────────
// Static GTFS lookups — loaded once at startup, kept in memory.
// Mirror the Python load_route_lookup + load_shape_polylines helpers.
// ──────────────────────────────────────────────────────────────────────────

// `optional` skips the warning when the file legitimately doesn't exist
// yet (e.g. `extended_shapes.txt`, which is generated on demand by the
// learned-shapes pipeline — see learned-shapes.js).
function loadCsv(name, { optional = false } = {}) {
  const file = path.join(GTFS_DIR, name);
  if (!fs.existsSync(file)) {
    if (!optional) {
      console.warn(
        `[gtfs] ${name} not found — skipping. Copy it from the` +
          ` Python project's gtfs_static/ directory.`
      );
    }
    return [];
  }
  return parse(fs.readFileSync(file, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

// Wrap the static-GTFS load in a function so we can re-run it after the
// learned-shapes promoter writes new rows to `extended_shapes.txt`. Without
// this, freshly promoted LRN_<bus_id> shapes wouldn't render or snap until
// the next process restart — mirrors Python `load_shape_polylines.clear()`
// behaviour at the end of `promote_learned_shapes`.
function loadGtfsStatic() {
  const routesRows = loadCsv("routes.txt");
  const tripsRows = loadCsv("trips.txt");
  const shapesRows = loadCsv("shapes.txt");
  // Learned shapes — same schema as shapes.txt; concatenated below so
  // downstream loaders treat them uniformly.
  const extendedShapesRows = loadCsv("extended_shapes.txt", { optional: true });
  const allShapesRows = shapesRows.concat(extendedShapesRows);

  const routeById = Object.fromEntries(
    routesRows.map((r) => [r.route_id, `${r.route_short_name} – ${r.route_long_name}`])
  );
  const routeByTrip = Object.fromEntries(
    tripsRows.map((t) => [t.trip_id, routeById[t.route_id] || "Unknown"])
  );

  // Learned-route labels: bus_id → label, for buses promoted from unknown.
  const extendedRoutesRows = loadCsv("extended_routes.txt", { optional: true });
  const learnedRouteByBus = {};
  for (const r of extendedRoutesRows) {
    if (r.route_id && r.route_id.startsWith("LRN_")) {
      const busId = r.route_id.slice(4);
      learnedRouteByBus[busId] = `${r.route_short_name} – ${r.route_long_name}`;
    }
  }

  const shapesById = {};
  for (const row of allShapesRows) {
    const sid = row.shape_id;
    if (!shapesById[sid]) shapesById[sid] = [];
    shapesById[sid].push([
      parseFloat(row.shape_pt_lon),
      parseFloat(row.shape_pt_lat),
      parseInt(row.shape_pt_sequence, 10),
    ]);
  }
  for (const sid of Object.keys(shapesById)) {
    shapesById[sid].sort((a, b) => a[2] - b[2]);
    shapesById[sid] = shapesById[sid].map(([lon, lat]) => [lon, lat]);
  }

  const shapesByRoute = {};
  for (const t of tripsRows) {
    const label = routeById[t.route_id] || "Unknown";
    if (!t.shape_id) continue;
    if (!shapesByRoute[label]) shapesByRoute[label] = new Set();
    shapesByRoute[label].add(t.shape_id);
  }
  for (const k of Object.keys(shapesByRoute)) shapesByRoute[k] = [...shapesByRoute[k]];

  const routeByShape = {};
  for (const [label, sids] of Object.entries(shapesByRoute)) {
    for (const sid of sids) {
      if (!(sid in routeByShape)) routeByShape[sid] = label;
    }
  }

  console.log(
    `[gtfs] loaded ${Object.keys(routeById).length} routes, ` +
      `${Object.keys(routeByTrip).length} trips, ` +
      `${Object.keys(shapesById).length} shapes`
  );

  return { routeById, routeByTrip, learnedRouteByBus, shapesById, shapesByRoute, routeByShape };
}

// Mutable bundle so `reloadGtfsStatic()` can swap atomically. Endpoints read
// through `gtfs.*`; `snapper` is rebuilt on reload because createSnapper
// closes over the maps it was constructed with.
let gtfs = loadGtfsStatic();
let snapper = createSnapper(gtfs.shapesById, gtfs.shapesByRoute);

function reloadGtfsStatic() {
  gtfs = loadGtfsStatic();
  snapper = createSnapper(gtfs.shapesById, gtfs.shapesByRoute);
}

// ──────────────────────────────────────────────────────────────────────────
// Position history + speed calculation. State lives entirely in this process
// (mirrors Python's st.session_state.position_history). A worker restart on
// Hostinger will lose the history; the frontend trails simply rebuild as new
// ticks arrive.
// ──────────────────────────────────────────────────────────────────────────

const positionHistory = new Map(); // bus_id -> [{ lat, lon, time, speed, calculated_speed, speed_kalman, weighted_speed }]

// Full-day speed timeline keyed by bus_id — no cap, accumulates all sessions
// across the service day. Reset at midnight rollover. Fed to the sparkline in
// the bus table so the trend covers the whole day, not just the last 20 ticks.
const sparklineHistory = new Map(); // bus_id -> [{ time, speed, calculated_speed, speed_kalman, weighted_speed }]

// Wholesale-replaced each tick — analogous to Python `st.session_state
// .prev_positions`. EKF and calc-speed read from THIS, not positionHistory,
// so a bus absent from the current feed loses its `prev` (Python parity:
// `prev_positions = positions` at the end of pipeline.py replaces the dict).
// positionHistory continues to accumulate per-bus deques for trail rendering
// (mirrors Python's `position_history` deque, which persists across absences).
let prevPositions = new Map();

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Active outlier-correction method — controlled by the sidebar selector.
// Mutable so the /api/settings PUT handler can flip it at runtime.
let activeCorrectionMethod = "iqr";

// Python detect_movement: Moving iff displacement > 20 m OR raw speed > 1 km/h.
const STATUS_DISTANCE_THRESHOLD_M = 20;

// Python round(x, 1) / round(x, 2) replacements. Math.round is half-away-from-
// zero; Python's round() is banker's (half-to-even). For real GPS-derived
// values, the chance of landing on an exact half at this precision is
// statistically zero — practical results match.
function round1(x) {
  return Math.round(x * 10) / 10;
}
function round2(x) {
  return Math.round(x * 100) / 100;
}

function recordPositionAndComputeSpeed(busId, lat, lon, tMs, speedRaw, nowMs, prev) {
  // Match Python EXACTLY (busapp/speeds/ekf.py:correct_outliers_ekf and
  // busapp/speeds/trust.py:detect_movement):
  //   - `prev` is the previous tick's prev_positions entry, NOT the last
  //     positionHistory deque entry. A bus absent for the previous tick has
  //     no prev → EKF gets dt = 1.0, calc-speed stays None, status = Moving.
  //   - `dt` for both EKF and calc-speed is `wallclock_now - prev.timestamp`
  //     (NOT `this_tick_vehicle_ts - prev_tick_vehicle_ts`). `prev.time` here
  //     stores the prev tick's vehicle.timestamp (or pipeline-now fallback),
  //     same as Python's `prev_positions[vid]["timestamp"]`.
  let speedCalc = null;
  let dtSec = null;
  let displacementM = null;
  let moved = true; // Python `detect_movement` default before the `if old:`

  if (prev) {
    dtSec = (nowMs - prev.time) / 1000;
    const km = haversineKm(prev.lat, prev.lon, lat, lon);
    displacementM = km * 1000;
    // Match Python busapp/speeds/trust.py:33-35 — calculated_speed is
    // haversine/elapsed_hours with no dt or speed bounds. Falls through to 0
    // when elapsed_hours <= 0 (division by zero would be undefined otherwise).
    speedCalc = dtSec > 0 ? (km / (dtSec / 3600)) : 0;
    // Override the default `moved = True`. Python:
    //   moved = (distance_km * 1000) > distance_threshold_m or data["speed"] > 1
    moved = displacementM > STATUS_DISTANCE_THRESHOLD_M || speedRaw > 1;
  }
  const status = moved ? "Moving" : "Stationary";

  // EKF — uses dtSec when we have one, else seeds with dt=1 on first sighting.
  // Matches Python correct_outliers_ekf which sets `dt = 1.0` when bus_id
  // is not in prev_positions.
  const ekfResult = applyEkfFilter(
    busId,
    lat,
    lon,
    speedRaw,
    dtSec != null ? dtSec : 1
  );

  // Trust-weighted speed (rolling window of GPS vs calculated).
  const trustResult = computeTrustWeighted(busId, speedRaw, speedCalc);

  // Append every tick to positionHistory (Python `position_history` parity).
  // This deque persists across absences for trail rendering; it is NOT what
  // EKF/calc reads — those use the wholesale-replaced `prevPositions`.
  const hist = positionHistory.get(busId) || [];
  hist.push({
    lat,
    lon,
    time: tMs,
    speed: speedRaw,
    calculated_speed: speedCalc,
    speed_kalman: ekfResult.filteredSpeedKmh,
    weighted_speed: trustResult.weighted,
  });
  while (hist.length > MAX_HISTORY) hist.shift();
  positionHistory.set(busId, hist);

  // Full-day sparkline buffer — no cap, reset at midnight rollover.
  const sl = sparklineHistory.get(busId) || [];
  sl.push({ time: tMs, speed: speedRaw, calculated_speed: speedCalc, speed_kalman: ekfResult.filteredSpeedKmh, weighted_speed: trustResult.weighted });
  sparklineHistory.set(busId, sl);

  // EXACT Python parity on rounding (busapp/speeds/trust.py:79-83 in the
  // rows.append() that builds the DataFrame):
  //   "calculated_speed": round(calculated_speed, 1) if not None else None
  //   "weighted_speed":   round(weighted_speed, 1)
  //   "trust_score":      round(trust_buf[-1], 2) if trust_buf else 0.7
  // EKF speed_kalman is NOT rounded by Python (passed through verbatim from
  // result["speed"]); we match.
  return {
    calculated_speed: speedCalc != null ? round1(speedCalc) : null,
    speed_kalman: ekfResult.filteredSpeedKmh,
    weighted_speed: round1(trustResult.weighted),
    trust_score: round2(trustResult.trust),
    status,
    trail: hist,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Live feed cache. Mirrors the Python @st.cache_data wrapper on
// fetch_feed_bytes — re-fetch only every FEED_CACHE_MS ms.
// ──────────────────────────────────────────────────────────────────────────

let feedCache = { ts: 0, buses: [] };

// Match Python busapp/fetch.py: 3 attempts with 1/2/4 s backoff between them.
// Single-shot fetches fail occasionally because data.gov.my has spotty TLS
// reliability; one cheap retry tier closes the gap.
const FEED_RETRY_BACKOFFS_MS = [1000, 2000, 4000];

async function fetchFeedBytes() {
  let lastErr = null;
  for (let attempt = 0; attempt < FEED_RETRY_BACKOFFS_MS.length; attempt++) {
    try {
      const res = await fetch(FEED_URL, { timeout: 10000 });
      if (!res.ok) throw new Error(`upstream returned ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt < FEED_RETRY_BACKOFFS_MS.length - 1) {
        console.warn(
          `[feed] attempt ${attempt + 1}/${FEED_RETRY_BACKOFFS_MS.length} failed: ${err.message}; ` +
            `retrying in ${FEED_RETRY_BACKOFFS_MS[attempt]}ms`
        );
        await new Promise((r) => setTimeout(r, FEED_RETRY_BACKOFFS_MS[attempt]));
      }
    }
  }
  throw lastErr || new Error("upstream fetch failed");
}

// Tracks the KL date of the most recent feed tick so a midnight crossover
// can trigger the day-rollover augmentation. Matches Python's
// busapp/state.py:day_rollover, which augments yesterday's parquet at the
// first fetch after midnight.
let lastKlDateSeen = klDate(Date.now());
// Single-flight guard so we don't kick off two rollover augmentations from
// concurrent ticks.
let rolloverInFlight = false;

// Rollover state — exposed via /api/rollover-status so the frontend can
// show a "back in Xs" overlay while the pipeline runs.
const rolloverState = {
  inProgress: false,
  startedAt: null,
  estimatedMs: 60_000, // updated after each run with actual elapsed × 1.15 buffer
};

async function maybeRunDayRollover(nowMs) {
  const today = klDate(nowMs);
  if (today === lastKlDateSeen) return;
  const yesterday = lastKlDateSeen;
  lastKlDateSeen = today;

  // Clear per-day state to match Python busapp/state.py:day_rollover —
  //   st.session_state.day_history       = []   → clearLiveAccumulator()
  //   st.session_state.speed_buffers     = {}
  //   st.session_state.calc_speed_buffers = {}  → clearTrustBuffers()
  //   st.session_state.trust_buffers     = {}
  // Python intentionally does NOT clear kalman_states or position_history;
  // we follow suit — only the trust buffers and the live heatmap reset.
  clearTrustBuffers();
  clearLiveAccumulator();
  sparklineHistory.clear();
  console.log(
    `[rollover] KL date changed ${yesterday} → ${today}; cleared trust/heatmap/sparkline state, augmenting yesterday…`
  );

  if (rolloverInFlight) return;
  rolloverInFlight = true;
  rolloverState.inProgress = true;
  rolloverState.startedAt = Date.now();

  try {
    const t0 = Date.now();
    const model = await getCrossDayModel({ rebuild: true });
    const t1 = Date.now();

    const result = await augmentJsonlFile(
      yesterday,
      model,
      snapper,
      gtfs.shapesByRoute,
      {}
    );
    const t2 = Date.now();
    console.log(
      `[rollover] ${yesterday}: model built in ${t1 - t0}ms, augmented ${result.augmented_rows}/${result.rows} rows in ${t2 - t1}ms`
    );

    // Convert augmented JSONL to parquet for compact on-disk storage.
    try {
      const conv = await convertDayToParquet(yesterday);
      const t3 = Date.now();
      if (conv) {
        const kb = Math.round(conv.size_bytes / 1024);
        console.log(
          `[rollover] ${yesterday}: converted to parquet (${conv.rows} rows, ${kb} KB) in ${t3 - t2}ms — total ${t3 - t0}ms`
        );
      }
    } catch (convErr) {
      console.error(`[rollover] parquet conversion for ${yesterday} failed:`, convErr);
    }

    const elapsed = Date.now() - t0;
    rolloverState.estimatedMs = Math.ceil(elapsed * 1.15);
  } catch (err) {
    console.error(`[rollover] augmenting ${yesterday} failed:`, err);
  } finally {
    rolloverInFlight = false;
    rolloverState.inProgress = false;
  }
}

async function fetchFeed(cacheMs = FEED_CACHE_BASE_MS) {
  const now = Date.now();
  if (now - feedCache.ts < cacheMs) return feedCache.buses;

  // Day-rollover hook: when this fetch crosses KL midnight, kick off
  // background augmentation of yesterday's JSONL. We don't await it so the
  // current tick isn't blocked; failures just log.
  maybeRunDayRollover(now);

  const buffer = await fetchFeedBytes();
  const message = transit_realtime.FeedMessage.decode(buffer);

  // PASS 1 — parse + per-bus speed estimates (EKF, calc, trust).
  // `speed_corrected` is filled in PASS 2 because Python computes it cross-bus
  // on the tick's full speed array (not per-bus rolling window).
  //
  // We build `newPositions` during the loop and atomically replace
  // `prevPositions` at the end of fetchFeed. This is Python's
  // `prev_positions = positions` semantics — a bus absent from this feed
  // tick loses its prev entry, so on its next return EKF gets dt = 1.0
  // (fresh) and calc-speed stays null.
  const partialBuses = [];
  const newPositions = new Map();
  for (const entity of message.entity) {
    const v = entity.vehicle;
    if (!v || !v.position) continue;
    const busId = v.vehicle ? v.vehicle.id || entity.id : entity.id;
    const tripId = v.trip ? v.trip.tripId : null;
    const routeRaw = tripId ? gtfs.routeByTrip[tripId] || "Unknown" : "Unknown";
    const route = routeRaw === "Unknown"
      ? gtfs.learnedRouteByBus[busId] || "Unknown"
      : routeRaw;
    const lat = v.position.latitude;
    const lon = v.position.longitude;
    // EXACT Python parity (busapp/pipeline.py:42-46):
    //   sp = round(v.position.speed * 3.6, 1) if v.position.HasField("speed") else 0
    // - Round to 1 decimal place so EKF / outlier correction / trust /
    //   persistence all see the same rounded km/h Python sees.
    // - Default to 0 (NOT null) when the GTFS speed field is absent. That 0
    //   participates in cross-bus IQR/percentile/stdev like every other bus,
    //   which is what Python's `[b["speed"] for b in bus_data]` produces.
    // Math.round here is half-away-from-zero; Python `round()` is banker's
    // rounding. For real GPS values × 3.6 the chance of hitting an exact
    // half is statistically zero, so the practical results match.
    const speedRaw =
      v.position.speed != null
        ? Math.round(v.position.speed * 3.6 * 10) / 10
        : 0;
    const tMs = v.timestamp ? Number(v.timestamp) * 1000 : now;
    const ageSeconds = v.timestamp
      ? Math.max(0, (now - Number(v.timestamp) * 1000) / 1000)
      : 0;
    const isStale = ageSeconds > 90;

    // Pull the wholesale-replaced prev for THIS bus (may be undefined when
    // the bus is new or was absent from the previous tick). Pass through
    // both `now` and `prev` so dt = now - prev.time matches Python's
    // (datetime.now() - prev_positions[vid]["timestamp"]).total_seconds().
    const prev = prevPositions.get(busId);
    const {
      calculated_speed,
      speed_kalman,
      weighted_speed,
      trust_score,
      status,
      trail,
    } = recordPositionAndComputeSpeed(busId, lat, lon, tMs, speedRaw, now, prev);

    // Record this tick's position for the NEXT tick's prev lookup.
    newPositions.set(busId, { lat, lon, time: tMs });

    partialBuses.push({
      bus_id: busId,
      lat,
      lon,
      speed: speedRaw,
      calculated_speed,
      speed_kalman,
      weighted_speed,
      trust_score,
      status,
      bearing: v.position.bearing ?? null,
      route,
      trip_id: tripId,
      timestamp: Math.floor(tMs / 1000),
      is_stale: isStale,
      age_seconds: ageSeconds,
      _tMs: tMs,
      _trail: trail,
    });
  }

  // Wholesale replace — Python's `st.session_state.prev_positions = positions`.
  // A bus that wasn't in this tick is now absent from prevPositions, so its
  // next return is treated as a fresh sighting (EKF dt = 1.0, no calc-speed).
  prevPositions = newPositions;

  // PASS 2 — cross-bus per-tick outlier correction over the full speed array.
  // EXACT Python parity (busapp/pipeline.py:76-82):
  //   raw_speeds = [b["speed"] for b in bus_data]            # always numeric (0-default)
  //   if len(raw_speeds) >= 4:
  //       corrected_speeds = correct_outliers_vectorized(
  //           np.array(raw_speeds, dtype=float), correction_method
  //       ).tolist()
  //   else:
  //       corrected_speeds = raw_speeds
  //
  // Every bus contributes its (rounded, 0-defaulted) speed to the cross-bus
  // distribution. Below the 4-bus threshold, Python keeps the raw list —
  // we mirror with a slice() for a value-equal copy. The clipped value is
  // distributed unconditionally — no null-out of speed_corrected.
  const rawSpeedsArr = partialBuses.map((b) => b.speed);
  const correctedArr =
    rawSpeedsArr.length >= 4
      ? correctOutliers(rawSpeedsArr, activeCorrectionMethod)
      : rawSpeedsArr.slice();

  const buses = [];
  for (let i = 0; i < partialBuses.length; i++) {
    const pb = partialBuses[i];
    const speed_corrected = correctedArr[i];
    // Backfill speed_corrected onto the latest trail point (PASS 1 built the
    // trail before PASS 2 cross-bus correction was available).
    if (pb._trail && pb._trail.length > 0) {
      pb._trail[pb._trail.length - 1].speed_corrected = speed_corrected;
    }
    // `tickSpeeds` uses internal mode short-names (raw/corrected/calc/kalman/
    // trust). `appendTick` maps those to the Python-matching schema columns
    // (speed / speed_corrected / calculated_speed / speed_kalman /
    // weighted_speed) before writing. Mode short-names are NOT renamed —
    // they're internal selectors for dropdowns, URL params, and accumulators.
    const tickSpeeds = {
      raw: pb.speed,
      calc: pb.calculated_speed,
      kalman: pb.speed_kalman,
      trust: pb.weighted_speed,
      corrected: speed_corrected,
    };
    // Feed the heatmap accumulator. Per-(bus_id, hour, mode) first-stage
    // median; /api/heatmap does the route-level second-stage median.
    recordSample(pb.bus_id, pb.route, pb._tMs, tickSpeeds);
    // Persist so the accumulator survives restarts and pooled / historical
    // features have data to read.
    appendTick(
      pb.bus_id,
      pb.route,
      pb._tMs,
      pb.lat,
      pb.lon,
      tickSpeeds,
      pb.trust_score
    );

    buses.push({
      bus_id: pb.bus_id,
      lat: pb.lat,
      lon: pb.lon,
      speed: pb.speed,
      calculated_speed: pb.calculated_speed,
      speed_kalman: pb.speed_kalman,
      weighted_speed: pb.weighted_speed,
      speed_corrected,
      trust_score: pb.trust_score,
      status: pb.status,
      bearing: pb.bearing,
      route: pb.route,
      trip_id: pb.trip_id,
      timestamp: pb.timestamp,
      is_stale: pb.is_stale,
      age_seconds: pb.age_seconds,
      trail: pb._trail,
      sparkline_trail: sparklineHistory.get(pb.bus_id) || [],
      snapped_trail: snapper.snapTrail(pb._trail, pb.route),
    });
  }

  // No per-tick pruning. Python's pipeline replaces `prev_positions`
  // wholesale (handled above by `prevPositions = newPositions`), but
  // intentionally KEEPS kalman_states, speed_buffers, calc_speed_buffers,
  // trust_buffers, and day_history across bus absences within a single KL
  // day. They're cleared on midnight rollover only.
  feedCache = { ts: now, buses };
  return buses;
}

// ──────────────────────────────────────────────────────────────────────────
// JSON API
// ──────────────────────────────────────────────────────────────────────────

// Historical replay of /api/buses for a past date. Streams the date's
// JSONL/parquet into per-bus aggregates: each bus gets its full day's
// trail plus the last-known position fields the live feed exposes.
// Same response shape as live so the frontend code doesn't need to fork.
const MAX_HIST_TRAIL = 200; // cap per-bus trail length so payload stays sane

async function buildHistoricalBuses(date) {
  // Try to reuse a previously-built cross-day model; only kicks off a build
  // when /api/maintenance/run has populated it (or this is the first call
  // after a startup-triggered build). Skipping the rebuild here keeps the
  // date-picker click responsive.
  const model = await getCrossDayModel().catch(() => null);

  const byBus = new Map();
  await loadDate(date, (row) => {
    let b = byBus.get(row.bus_id);
    if (!b) {
      b = {
        bus_id: row.bus_id,
        route: row.route || "Unknown",
        trail: [],
      };
      byBus.set(row.bus_id, b);
    }
    // Prefer the precomputed adj_lat / adj_lon if the file was augmented
    // on disk (parquet from Python, or JSONL after /api/maintenance/run).
    // Fall back to live-adjusting via the cross-day model when adj_* are
    // absent. Pass-16 semantics: > 2 km from typical → substitute typical.
    let lat = row.lat;
    let lon = row.lon;
    if (row.adj_lat != null && row.adj_lon != null) {
      lat = row.adj_lat;
      lon = row.adj_lon;
    } else if (model) {
      const adj = adjustRow(model, row);
      if (adj) {
        lat = adj.lat;
        lon = adj.lon;
      }
    }
    b.trail.push({
      lat,
      lon,
      time: row.time,
      speed: row.speed,
      speed_corrected: row.speed_corrected ?? null,
      calculated_speed: row.calculated_speed,
      speed_kalman: row.speed_kalman,
      weighted_speed: row.weighted_speed,
      // Carry the precomputed snap fields through so the renderer can skip
      // re-projection when they're already on disk.
      snap_shape_id: row.snap_shape_id ?? null,
      snap_cumdist: row.snap_cumdist ?? null,
    });
    // Always overwrite the last-known fields so the dot lands at the
    // bus's final position of the day (adjusted if the model fired).
    b.lat = lat;
    b.lon = lon;
    b.speed = row.speed;
    b.calculated_speed = row.calculated_speed;
    b.speed_kalman = row.speed_kalman;
    b.weighted_speed = row.weighted_speed;
    b.trust_score = null;
    b.bearing = null;
    b.trip_id = null;
    b.timestamp = Math.floor(row.time / 1000);
  });
  // Even-spaced subsample of each trail so a 1000-point full-day trail
  // collapses to 200 representative dots. Preserves first + last so the
  // line layer's endpoints remain stable.
  for (const b of byBus.values()) {
    if (b.trail.length > MAX_HIST_TRAIL) {
      const step = b.trail.length / MAX_HIST_TRAIL;
      const sampled = [];
      for (let i = 0; i < MAX_HIST_TRAIL; i++) {
        sampled.push(b.trail[Math.floor(i * step)]);
      }
      sampled[sampled.length - 1] = b.trail[b.trail.length - 1];
      b.trail = sampled;
    }
    // Snap historical trails to GTFS polylines so the map shows curved
    // road-following paths instead of straight chords between sampled GPS
    // positions. Falls back to chords (or gaps if > 3 km) when no shape
    // matches within the perpendicular threshold.
    b.snapped_trail = snapper.snapTrail(b.trail, b.route);
  }
  return [...byBus.values()];
}

app.get("/api/buses", async (req, res) => {
  const date = req.query.date;
  const today = klDate(Date.now());
  const wantsHistorical = date && date !== today && date !== "today";

  if (wantsHistorical) {
    try {
      const buses = await buildHistoricalBuses(date);
      return res.json({
        ts: Date.now(),
        count: buses.length,
        buses,
        is_historical: true,
        date,
      });
    } catch (err) {
      console.error("[api/buses historical]", err);
      return res.status(500).json({ error: String(err) });
    }
  }

  try {
    // Slider-driven cache window. Mirrors Python's `cache_ttl =
    // max(interval, API_UPDATE_INTERVAL=30)` so a user with a long polling
    // interval doesn't hammer the upstream feed. We use a 5-second under-
    // cushion so the cache expires slightly before the next client poll.
    const reqInterval = parseInt(req.query.interval, 10);
    const cacheMs = Number.isFinite(reqInterval) && reqInterval > 0
      ? Math.max(FEED_CACHE_BASE_MS, (reqInterval - 5) * 1000)
      : FEED_CACHE_BASE_MS;
    const buses = await fetchFeed(cacheMs);
    res.json({
      ts: feedCache.ts,
      count: buses.length,
      buses,
      is_historical: false,
      date: today,
    });
  } catch (err) {
    console.error("[api/buses]", err);
    res.status(502).json({ error: String(err) });
  }
});

app.get("/api/routes", (_req, res) => {
  res.json({ routes: Object.values(gtfs.routeById).sort() });
});

// Returns the lat/lon bounding box for a specific bus from the historical day
// that has the most data points for that bus (morning-to-end coverage).
// Scans all past dates and picks the one with the highest row count.
app.get("/api/bus-bbox", async (req, res) => {
  const busId = String(req.query.bus_id || "").trim();
  if (!busId) return res.status(400).json({ error: "bus_id required" });

  const today = klDate(Date.now());
  const pastDates = listDates().filter((d) => d.date < today);
  if (pastDates.length === 0) return res.json({ bbox: null });

  let bestDate = null, bestCount = 0, bestBbox = null;

  for (const d of pastDates) {
    let count = 0;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    await loadDate(d.date, (row) => {
      if (row.bus_id !== busId) return;
      const lat = row.adj_lat ?? row.lat;
      const lon = row.adj_lon ?? row.lon;
      if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
      count++;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    });
    if (count > bestCount) {
      bestCount = count;
      bestDate = d.date;
      bestBbox = { minLat, maxLat, minLon, maxLon };
    }
  }

  if (!bestBbox) return res.json({ bbox: null });
  res.json({ bbox: bestBbox, date: bestDate, count: bestCount });
});

app.get("/api/shapes", (req, res) => {
  // Optional ?routes=label1,label2 filter; otherwise returns ALL polylines.
  // For "Active only" mode the frontend can intersect with currently-visible
  // buses' routes and pass them here.
  const routesParam = req.query.routes;
  let shapeIds = null;
  if (routesParam) {
    shapeIds = new Set();
    for (const label of String(routesParam).split(",")) {
      for (const sid of gtfs.shapesByRoute[label] || []) shapeIds.add(sid);
    }
  }
  const shapes = {};
  const routeOf = {};
  for (const sid of Object.keys(gtfs.shapesById)) {
    if (shapeIds && !shapeIds.has(sid)) continue;
    shapes[sid] = gtfs.shapesById[sid];
    if (gtfs.routeByShape[sid]) routeOf[sid] = gtfs.routeByShape[sid];
  }
  // `route_of` lets the frontend color each polyline by its route's cluster.
  res.json({ shapes, route_of: routeOf });
});

// Frontend-facing config bundle. Currently just the MapTiler API key, so the
// public placeholder in main.js can be replaced server-side without baking a
// secret into the static bundle. Set MAPTILER_KEY to enable the satellite
// basemap at production volume.
app.get("/api/config", (_req, res) => {
  res.json({
    maptiler_key: process.env.MAPTILER_KEY || null,
  });
});

app.get("/api/health", (_req, res) => {
  let totalHistoryPoints = 0;
  for (const hist of positionHistory.values()) totalHistoryPoints += hist.length;
  res.json({
    ok: true,
    routes: Object.keys(gtfs.routeById).length,
    shapes: Object.keys(gtfs.shapesById).length,
    cached_buses: feedCache.buses.length,
    cache_age_ms: Date.now() - feedCache.ts,
    tracked_buses: positionHistory.size,
    total_history_points: totalHistoryPoints,
    ...speedStateStats(),
    heatmap: accumulatorStats(),
    store: storeStats(),
  });
});

app.get("/api/heatmap", async (req, res) => {
  const requested = req.query.mode || "trust";
  const anchorMode = req.query.anchor === "pooled" ? "pooled" : "physical";
  const requestedDate = req.query.date;
  const today = klDate(Date.now());
  // "today" or absent → live accumulator (real-time). Anything else → stream
  // the JSONL once into a scratch accumulator and answer from that.
  const isHistorical =
    requestedDate && requestedDate !== today && requestedDate !== "today";

  // Helper that picks the right buildHeatmap callable based on `date`.
  async function buildOne(mode, anchorOverride) {
    if (isHistorical) {
      const hist = await buildHistoricalHeatmap(
        requestedDate,
        loadDate,
        { mode, anchor: anchorOverride }
      );
      if (hist == null) {
        // No data for that date — return an empty-but-well-formed payload.
        return {
          ts: Date.now(),
          mode,
          anchor_mode: anchorMode,
          anchor: anchorOverride,
          edges: [],
          spike_threshold: null,
          tz: "Asia/Kuala_Lumpur",
          kl_date: requestedDate,
          routes: [],
          hours: Array.from({ length: 24 }, (_, i) => i),
          cells: [],
          stats: { buses_tracked: 0, samples_total: 0, cells_populated: 0 },
        };
      }
      return hist;
    }
    return buildHeatmap({ mode, anchor: anchorOverride });
  }

  try {
    let pooled = null;
    if (anchorMode === "pooled") pooled = (await computePooledMedians()).anchors;

    if (requested === "all") {
      const all = {};
      for (const m of HEATMAP_MODES) {
        const anchorOverride =
          anchorMode === "pooled" && pooled[m] != null ? pooled[m] : null;
        all[m] = await buildOne(m, anchorOverride);
      }
      return res.json({
        ts: Date.now(),
        anchor_mode: anchorMode,
        modes: HEATMAP_MODES,
        per_mode: all,
        kl_date: isHistorical ? requestedDate : today,
        is_historical: isHistorical,
      });
    }

    if (!HEATMAP_MODES.includes(requested)) {
      return res.status(400).json({
        error: `unknown mode '${requested}', expected 'all' or one of ${HEATMAP_MODES.join(", ")}`,
      });
    }
    const anchorOverride =
      anchorMode === "pooled" && pooled && pooled[requested] != null
        ? pooled[requested]
        : null;
    const body = await buildOne(requested, anchorOverride);
    body.anchor_mode = anchorMode;
    body.is_historical = isHistorical;
    res.json(body);
  } catch (err) {
    console.error("[api/heatmap]", err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/pooled-anchors", async (_req, res) => {
  try {
    res.json(await computePooledMedians());
  } catch (err) {
    console.error("[api/pooled-anchors]", err);
    res.status(500).json({ error: String(err) });
  }
});

// Mirror of Python's "Pre-augment all history" button. SINGLE-PASS over all
// stored dates feeding both the cross-day position model AND the unknown-
// observation accumulator simultaneously, then runs the learned-shape
// promotion. Previously the model + accumulator did independent full scans
// of every parquet/jsonl — roughly halves the runtime.
const {
  buildCrossDayModelFromRow,
  finalizeCrossDayModel,
  unknownAccumulatorFromRow,
  closeUnknownAccumulator,
} = require("./maintenance-pass");
const { augmentJsonlFile } = require("./augment-jsonl");
const { convertDayToParquet } = require("./convert-day");

let maintenanceInFlight = false;
app.post("/api/maintenance/run", express.json(), async (_req, res) => {
  if (maintenanceInFlight) {
    return res.status(409).json({ error: "maintenance already running" });
  }
  maintenanceInFlight = true;
  const dates = listDates();
  console.log(
    `[maintenance] starting single-pass scan of ${dates.length} date(s)…`
  );
  try {
    const t0 = Date.now();
    const crossDayCtx = buildCrossDayModelFromRow();
    const unknownCtx = unknownAccumulatorFromRow();
    let totalRows = 0;
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i];
      const tDate = Date.now();
      let dateRows = 0;
      await loadDate(d.date, (row) => {
        crossDayCtx.consume(row);
        unknownCtx.consume(row, d.date);
        dateRows += 1;
      });
      totalRows += dateRows;
      console.log(
        `[maintenance] ${i + 1}/${dates.length} ${d.date}: ${dateRows.toLocaleString()} rows in ${Date.now() - tDate}ms`
      );
    }
    const model = finalizeCrossDayModel(crossDayCtx, dates.length);
    const unknownCount = await closeUnknownAccumulator(unknownCtx);
    const t1 = Date.now();
    console.log(`[maintenance] scan done in ${t1 - t0}ms; promoting…`);
    const promotionResult = await promoteLearnedShapes();
    // Reload the static-GTFS bundle so freshly written extended_shapes.txt
    // rows take effect in this process without a restart. Mirrors Python's
    // load_shape_polylines.clear() / load_shape_geometries.clear() at the
    // end of promote_learned_shapes.
    if (promotionResult.promoted > 0) {
      reloadGtfsStatic();
      console.log(
        `[maintenance] reloaded static GTFS (now ${Object.keys(gtfs.shapesById).length} shapes)`
      );
    }
    const t2 = Date.now();
    console.log(
      `[maintenance] promotion done in ${t2 - t1}ms; cumulative ${t2 - t0}ms`
    );

    // JSONL augmentation: write adj_lat/adj_lon/snap_shape_id/snap_cumdist
    // back to each stored day's file. Mirrors Python snap_augment_parquet.
    // Skips today's file (live pipeline is mid-write) and files already
    // augmented. Done AFTER promotion + GTFS reload so newly-published
    // LRN_* shapes are eligible snap targets for unknown-route rows.
    const today = klDate(Date.now());
    let augmentedFiles = 0;
    let augmentedRows = 0;
    for (const d of dates) {
      if (d.date === today) continue;
      try {
        const result = await augmentJsonlFile(
          d.date,
          model,
          snapper,
          gtfs.shapesByRoute,
          {} // no inferred-by-bus map yet — future work; see note below
        );
        if (!result.skipped) {
          augmentedFiles += 1;
          augmentedRows += result.augmented_rows;
          console.log(
            `[maintenance] augmented ${d.date}: ${result.augmented_rows}/${result.rows} rows`
          );
        }
      } catch (err) {
        console.error(`[maintenance] augment ${d.date} failed:`, err);
      }
    }
    const t3 = Date.now();
    console.log(
      `[maintenance] augmentation done in ${t3 - t2}ms; total ${t3 - t0}ms`
    );

    // Convert any augmented JSOLs (past days) to parquet. A JSONL is only
    // eligible if it exists AND is not today's file (still being written).
    // Already-converted days have no JSONL so convertDayToParquet returns null.
    let convertedFiles = 0;
    let convertedRows = 0;
    for (const d of dates) {
      if (d.date === today) continue;
      try {
        const conv = await convertDayToParquet(d.date);
        if (conv != null) {
          convertedFiles += 1;
          convertedRows += conv.rows;
          const kb = Math.round(conv.size_bytes / 1024);
          console.log(
            `[maintenance] converted ${d.date}: ${conv.rows} rows → ${kb} KB parquet`
          );
        }
      } catch (err) {
        console.error(`[maintenance] convert ${d.date} failed:`, err);
      }
    }
    const t4 = Date.now();
    console.log(
      `[maintenance] conversion done in ${t4 - t3}ms; total ${t4 - t0}ms`
    );

    res.json({
      ok: true,
      cross_day_model: {
        rows: model.total_rows,
        days: model.days_scanned,
        bus_route_bucket_cells: model.byBusRouteBucket.size,
        route_bucket_cells: model.byRouteBucket.size,
      },
      unknown_accumulator: {
        observations_written: unknownCount,
      },
      learned_shapes: {
        ...promotionResult,
      },
      jsonl_augmentation: {
        files_augmented: augmentedFiles,
        rows_with_snap: augmentedRows,
      },
      parquet_conversion: {
        files_converted: convertedFiles,
        rows_converted: convertedRows,
      },
      single_pass_rows: totalRows,
      total_elapsed_ms: t4 - t0,
    });
  } catch (err) {
    console.error("[api/maintenance/run]", err);
    res.status(500).json({ error: String(err) });
  } finally {
    maintenanceInFlight = false;
  }
});

app.get("/api/maintenance/status", (_req, res) => {
  res.json({
    cross_day: crossDayStats(),
    learned: learnedShapesStats(),
  });
});

app.get("/api/dates", (_req, res) => {
  res.json({ dates: listDates() });
});

// Stream a raw data file for a given date. Prefers .parquet; falls back to
// .jsonl for today's live file. Used by the sync-data script to pull
// accumulated data from any running instance (production → local, or
// old host → new host at migration time).
app.get("/api/data/:date", (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }
  const parquetPath = path.join(DATA_DIR, `${date}.parquet`);
  const jsonlPath   = path.join(DATA_DIR, `${date}.jsonl`);
  if (fs.existsSync(parquetPath)) {
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${date}.parquet"`);
    return fs.createReadStream(parquetPath).pipe(res);
  }
  if (fs.existsSync(jsonlPath)) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="${date}.jsonl"`);
    return fs.createReadStream(jsonlPath).pipe(res);
  }
  res.status(404).json({ error: `no data for ${date}` });
});

app.get("/api/rollover-status", (_req, res) => {
  res.json({
    in_progress: rolloverState.inProgress,
    started_at: rolloverState.startedAt,
    estimated_ms: rolloverState.estimatedMs,
  });
});

// Server-side switch for the outlier-correction algorithm. POSTed by the
// sidebar's "Outlier Correction Method" selector.
app.post("/api/correction-method", express.json(), (req, res) => {
  const method = req.body && req.body.method;
  if (!CORRECTION_METHODS.includes(method)) {
    return res.status(400).json({
      error: `unknown method '${method}', expected one of ${CORRECTION_METHODS.join(", ")}`,
    });
  }
  activeCorrectionMethod = method;
  res.json({ ok: true, method });
});

app.get("/api/clusters", async (req, res) => {
  const metric = req.query.metric === "correlation" ? "correlation" : "euclidean";
  const k = Math.max(2, Math.min(10, parseInt(req.query.k, 10) || 6));
  const anchorMode = req.query.anchor === "pooled" ? "pooled" : "physical";
  // When `?date=YYYY-MM-DD` is set (and not today's), cluster features come
  // from that day's stored data via buildHistoricalHeatmap. Mirrors Python
  // compute_route_clusters(source, settings) where source can be a
  // historical DataFrame, not just today's accumulator.
  const date = req.query.date || null;
  // When `?hours=1`, also return the clustered hour-of-day order so the
  // heatmap's y-axis can mirror Python timeline.py:_cluster_hours.
  const wantHours = req.query.hours === "1";
  try {
    const routeRes = await computeRouteClusters({ metric, k, anchorMode, date });
    if (wantHours) {
      routeRes.hour_order = await computeHourOrder({ metric, anchorMode, date });
    }
    res.json(routeRes);
  } catch (err) {
    console.error("[api/clusters]", err);
    res.status(500).json({ error: String(err) });
  }
});

// Replay today's JSONL (if any) into the in-memory accumulator before we
// start serving traffic. This makes the heatmap "warm" after a restart
// instead of starting from zero. Idempotent — recordSample's per-cell cap
// trims as it goes.
async function replayTodaysData() {
  const today = klDate(Date.now());
  let rowCount = 0;
  await loadDate(today, (row) => {
    if (row.lat == null || row.lon == null) return;
    recordSample(row.bus_id, row.route, row.time, {
      raw: row.speed,
      calc: row.calculated_speed,
      kalman: row.speed_kalman,
      trust: row.weighted_speed,
      corrected: row.speed_corrected,
    });
    // Restore positionHistory (map trail — last 20 points) and full-day
    // sparklineHistory from today's JSONL so both are warm on restart.
    const hist = positionHistory.get(row.bus_id) || [];
    hist.push({
      lat: row.lat,
      lon: row.lon,
      time: row.time,
      speed: row.speed,
      calculated_speed: row.calculated_speed,
      speed_kalman: row.speed_kalman,
      weighted_speed: row.weighted_speed,
    });
    while (hist.length > MAX_HISTORY) hist.shift();
    positionHistory.set(row.bus_id, hist);

    const sl = sparklineHistory.get(row.bus_id) || [];
    sl.push({ time: row.time, speed: row.speed, calculated_speed: row.calculated_speed, speed_kalman: row.speed_kalman, weighted_speed: row.weighted_speed });
    sparklineHistory.set(row.bus_id, sl);
    rowCount += 1;
  });
  if (rowCount > 0) {
    console.log(`[store] replayed ${rowCount.toLocaleString()} rows from ${today}.jsonl`);
  }
}

replayTodaysData().finally(() => {
  app.listen(PORT, () => {
    console.log(`[busjs] listening on http://localhost:${PORT}`);
  });
  // Warm up the cross-day model in the background so the first historical
  // date request doesn't block on a cold start.
  getCrossDayModel().catch(() => {});
  // Auto-maintenance: if there are any past-day JSOLs that weren't
  // augmented+converted at rollover (first deploy, crashed server, etc.),
  // run the full maintenance pass quietly in the background.
  startupMaintenance().catch((err) =>
    console.error("[startup] maintenance failed:", err)
  );
});

// Heartbeat timer — fires every minute so maybeRunDayRollover triggers at KL
// midnight even when no browser is actively polling /api/buses. The rollover
// itself is single-flight (rolloverInFlight guard) so concurrent ticks are safe.
setInterval(() => maybeRunDayRollover(Date.now()), 60_000).unref();

async function startupMaintenance() {
  const today = klDate(Date.now());
  const pending = listDates().filter(
    (d) => d.source === "jsonl" && d.date !== today
  );
  if (pending.length === 0) return;
  console.log(
    `[startup] ${pending.length} unprocessed JSONL(s) — running maintenance…`
  );

  // Build cross-day model + unknown accumulator in a single scan pass,
  // same as the API endpoint. All required modules are already imported
  // at the top of this file.
  const dates = listDates();
  const crossDayCtx = buildCrossDayModelFromRow();
  const unknownCtx = unknownAccumulatorFromRow();
  for (const d of dates) {
    await loadDate(d.date, (row) => {
      crossDayCtx.consume(row);
      unknownCtx.consume(row, d.date);
    });
  }
  const model = finalizeCrossDayModel(crossDayCtx, dates.length);
  await closeUnknownAccumulator(unknownCtx);
  const promotionResult = await promoteLearnedShapes();
  if (promotionResult.promoted > 0) reloadGtfsStatic();

  for (const d of pending) {
    try {
      const aug = await augmentJsonlFile(
        d.date,
        model,
        snapper,
        gtfs.shapesByRoute,
        {}
      );
      const conv = await convertDayToParquet(d.date);
      if (conv) {
        const action = aug.skipped ? "converted" : "augmented + converted";
        console.log(
          `[startup] ${d.date}: ${action} (${conv.rows} rows, ${Math.round(conv.size_bytes / 1024)} KB)`
        );
      }
    } catch (err) {
      console.error(`[startup] ${d.date} failed:`, err);
    }
  }
  console.log("[startup] maintenance complete");
}
