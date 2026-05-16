// Cross-day pooled-median anchors — mirrors Python compute_pooled_medians.
//
// For each speed mode, walk every stored JSONL day, take the per-bus median
// of that mode's samples, then the median of all those per-bus medians
// across (bus, day). Result is one anchor number per mode that's robust to
// any single day's outliers.
//
// Cached for 60 minutes since recomputation is O(rows) and rows grow daily.

const { listDates, loadDate } = require("./store");
const { POOLED_CACHE_TTL_MS: CACHE_MS } = require("./config");

// All 5 modes — `corrected` was missing in the pre-fix version, which made
// pooled anchor for "Corrected GPS" silently fall back to physical (40 km/h).
// Python compute_pooled_medians includes speed_corrected.
const MODES = ["raw", "corrected", "calc", "kalman", "trust"];
// Mode short-name → row field name. Field names match the Python parquet
// schema (busapp/pipeline.py) — see store.js:appendTick for the mapping
// rationale and the legacy-row normalization layer.
const KEY_BY_MODE = {
  raw: "speed",
  corrected: "speed_corrected",
  calc: "calculated_speed",
  kalman: "speed_kalman",
  trust: "weighted_speed",
};
// `stamp` is the listDates() (size, mtime) fingerprint so the cache
// invalidates when any stored day is added/removed/rewritten. Without this
// the 60-minute TTL was the only thing forcing a recompute, which meant new
// days wouldn't appear in pooled anchors until the next hour.
let cache = { ts: 0, stamp: "", value: null };

function fingerprint(dates) {
  return dates.map((d) => `${d.date}:${d.size_bytes}:${d.mtime_ms}`).join("|");
}

function medianOfArray(values) {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const n = values.length;
  return n % 2 === 1 ? values[(n - 1) >> 1] : (values[n / 2 - 1] + values[n / 2]) / 2;
}

async function computePooledMedians() {
  const datesMeta = listDates();
  const stamp = fingerprint(datesMeta);
  if (
    cache.value &&
    cache.stamp === stamp &&
    Date.now() - cache.ts < CACHE_MS
  ) {
    return cache.value;
  }

  const dates = datesMeta.map((d) => d.date);
  // Per-mode list of per-(bus, day) medians, pooled across every day.
  const poolByMode = {};
  for (const m of MODES) poolByMode[m] = [];

  for (const date of dates) {
    // Group this day's samples by bus_id for first-stage per-bus median.
    const byBus = new Map();
    await loadDate(date, (row) => {
      let bus = byBus.get(row.bus_id);
      if (!bus) {
        bus = { raw: [], corrected: [], calc: [], kalman: [], trust: [] };
        byBus.set(row.bus_id, bus);
      }
      for (const m of MODES) {
        const v = row[KEY_BY_MODE[m]];
        if (v != null && v >= 0 && v <= 200) bus[m].push(v);
      }
    });
    for (const bus of byBus.values()) {
      for (const m of MODES) {
        if (bus[m].length === 0) continue;
        const med = medianOfArray(bus[m]);
        if (med != null) poolByMode[m].push(med);
      }
    }
  }

  const result = {};
  for (const m of MODES) {
    result[m] = poolByMode[m].length > 0 ? medianOfArray(poolByMode[m]) : null;
  }

  cache = {
    ts: Date.now(),
    stamp,
    value: { anchors: result, days_used: dates.length },
  };
  return cache.value;
}

function invalidateCache() {
  cache = { ts: 0, stamp: "", value: null };
}

module.exports = { computePooledMedians, invalidateCache, MODES };
