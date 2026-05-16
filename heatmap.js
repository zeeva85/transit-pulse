// Heatmap accumulator + aggregation. Holds per-(bus_id, hour, mode) sample
// arrays, capped per cell to keep memory bounded. Builds the API payload by
// taking median-of-medians at request time (same two-stage aggregation the
// Python timeline.py does).
//
// State is wrapped in a factory `makeAccumulator()` so callers can spin up
// scratch instances (e.g. one per historical date) without touching the
// live tick-feed accumulator. The module-level `recordSample` / `buildHeatmap`
// / `pruneAccumulator` exports delegate to a single shared "live" instance.

const { binEdges, categorize, PHYSICAL_ANCHOR, SPIKE_THRESHOLD } = require("./bins");
const { HEATMAP_SAMPLES_PER_CELL: SAMPLES_PER_BUSHOUR_CELL, HEATMAP_HIST_CACHE_LIMIT: HIST_CACHE_LIMIT } = require("./config");

const MODES = ["raw", "corrected", "calc", "kalman", "trust"];

const KL_TZ = "Asia/Kuala_Lumpur";
const KL_HOUR_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: KL_TZ,
  hour: "numeric",
  hourCycle: "h23",
});
const KL_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: KL_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function klHour(tMs) {
  return parseInt(KL_HOUR_FMT.format(new Date(tMs)), 10) % 24;
}

function klDate(tMs) {
  return KL_DATE_FMT.format(new Date(tMs));
}

function pushCapped(arr, value, cap) {
  arr.push(value);
  while (arr.length > cap) arr.shift();
}

function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n % 2 === 1) return sorted[(n - 1) >> 1];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function medianOf(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  return median(sorted);
}

// ──────────────────────────────────────────────────────────────────────────
// Accumulator factory
// ──────────────────────────────────────────────────────────────────────────

function makeAccumulator() {
  // busSamples: bus_id -> hour -> { route, raw: [], calc: [], kalman: [], trust: [] }
  const busSamples = new Map();
  let totalSamples = 0;
  let oldestSampleMs = null;

  function recordSample(busId, route, tMs, speeds) {
    const hour = klHour(tMs);
    let perHour = busSamples.get(busId);
    if (!perHour) {
      perHour = new Map();
      busSamples.set(busId, perHour);
    }
    let perMode = perHour.get(hour);
    if (!perMode) {
      perMode = { route, raw: [], corrected: [], calc: [], kalman: [], trust: [] };
      perHour.set(hour, perMode);
    }
    perMode.route = route;
    for (const m of MODES) {
      const v = speeds[m];
      if (v == null || v < 0 || v > 200) continue;
      pushCapped(perMode[m], v, SAMPLES_PER_BUSHOUR_CELL);
      totalSamples += 1;
    }
    if (oldestSampleMs == null || tMs < oldestSampleMs) oldestSampleMs = tMs;
  }

  // Clear the entire accumulator — used at KL midnight rollover. Mirrors
  // Python busapp/state.py:62 (`st.session_state.day_history = []`); the
  // Python heatmap aggregates from day_history at render time, so wiping
  // day_history at rollover gives an empty "today" heatmap. We do the same.
  // No per-tick prune for absent buses — Python keeps every bus's rows in
  // day_history regardless of whether the bus is in the latest feed tick.
  function clearAccumulator() {
    busSamples.clear();
    totalSamples = 0;
    oldestSampleMs = null;
  }

  function buildHeatmap({ mode = "trust", anchor = null } = {}) {
    if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
    const effAnchor = anchor != null ? anchor : PHYSICAL_ANCHOR[mode];
    const edges = binEdges(mode, effAnchor);
    const spike = SPIKE_THRESHOLD[mode];

    // First stage: per-bus per-hour medians, grouped by route.
    const routeAgg = new Map();
    for (const [, hourMap] of busSamples) {
      for (const [hour, cell] of hourMap) {
        const m = medianOf(cell[mode]);
        if (m == null) continue;
        const route = cell.route || "Unknown";
        let perHour = routeAgg.get(route);
        if (!perHour) {
          perHour = new Map();
          routeAgg.set(route, perHour);
        }
        let bucket = perHour.get(hour);
        if (!bucket) {
          bucket = [];
          perHour.set(hour, bucket);
        }
        bucket.push(m);
      }
    }

    const routes = [...routeAgg.keys()].sort();
    const cells = [];
    for (let r = 0; r < routes.length; r++) {
      const route = routes[r];
      for (const [hour, busMedians] of routeAgg.get(route)) {
        const v = medianOf(busMedians);
        if (v == null) continue;
        cells.push({
          r,
          h: hour,
          v: Math.round(v * 100) / 100,
          bin: categorize(v, edges, spike),
          n: busMedians.length,
        });
      }
    }

    const nowMs = Date.now();
    return {
      ts: nowMs,
      mode,
      anchor_mode: "physical",
      anchor: effAnchor,
      edges: edges.map((e) => Math.round(e * 100) / 100),
      spike_threshold: spike,
      tz: KL_TZ,
      kl_date: oldestSampleMs != null ? klDate(oldestSampleMs) : klDate(nowMs),
      routes,
      hours: Array.from({ length: 24 }, (_, i) => i),
      cells,
      stats: accumulatorStats(),
    };
  }

  function accumulatorStats() {
    let cellCount = 0;
    for (const [, hourMap] of busSamples) cellCount += hourMap.size;
    return {
      buses_tracked: busSamples.size,
      samples_total: totalSamples,
      cells_populated: cellCount,
      oldest_sample_ms: oldestSampleMs,
      oldest_sample_kl: oldestSampleMs != null ? klDate(oldestSampleMs) : null,
    };
  }

  // Expose the internal map so a one-shot historical accumulator can be
  // wrapped by an LRU cache without paying the per-call cost twice.
  return { recordSample, buildHeatmap, clearAccumulator, accumulatorStats, _busSamples: busSamples };
}

// ──────────────────────────────────────────────────────────────────────────
// Live (module-level) accumulator + historical helper
// ──────────────────────────────────────────────────────────────────────────

const live = makeAccumulator();

// LRU cache of historical date → accumulator. Keeps memory bounded if a user
// hops between many dates. Built lazily — first /api/heatmap?date=X request
// for that date streams the JSONL through a fresh accumulator and stashes it.
const historicalCache = new Map();

async function buildHistoricalHeatmap(date, loadDateFn, opts = {}) {
  let acc = historicalCache.get(date);
  if (!acc) {
    acc = makeAccumulator();
    let rowCount = 0;
    await loadDateFn(date, (row) => {
      if (row.lat == null || row.lon == null) return;
      acc.recordSample(row.bus_id, row.route, row.time, {
        raw: row.speed,
        calc: row.calculated_speed,
        kalman: row.speed_kalman,
        trust: row.weighted_speed,
        corrected: row.speed_corrected,
      });
      rowCount += 1;
    });
    if (rowCount === 0) return null;
    historicalCache.set(date, acc);
    while (historicalCache.size > HIST_CACHE_LIMIT) {
      const oldest = historicalCache.keys().next().value;
      historicalCache.delete(oldest);
    }
  }
  const result = acc.buildHeatmap(opts);
  result.kl_date = date;
  return result;
}

function invalidateHistoricalCache(date) {
  if (date) historicalCache.delete(date);
  else historicalCache.clear();
}

module.exports = {
  // Live accumulator (delegates).
  recordSample: live.recordSample,
  buildHeatmap: live.buildHeatmap,
  clearLiveAccumulator: live.clearAccumulator,
  accumulatorStats: live.accumulatorStats,
  MODES,
  // Historical / factory access.
  makeAccumulator,
  buildHistoricalHeatmap,
  invalidateHistoricalCache,
};
