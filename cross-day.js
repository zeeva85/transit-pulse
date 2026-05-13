// Cross-day position cleanup — port of busapp/history.py
// build_cross_day_position_model + the adj_lat/adj_lon logic.
//
// Builds a robust position model: for every (bus_id, route, half-hour bucket)
// it stores the median lat/lon across every stored day. When a tick's raw
// position is > 2 km from typical, the renderer can substitute the typical
// position instead — without ever overwriting the source data.
//
// Lookup chain:
//   1. (bus_id, route, bucket) — most specific
//   2. (route, bucket)         — fallback when this bus hasn't been seen
//                                at this (route, bucket) combination
// Case-3 (no typical at all) → leave the row as-is.

const { loadDate, listDates } = require("./store");

const BUCKETS_PER_DAY = 48; // 30-min buckets — matches Python's half-hour cadence
const POSITION_JUMP_KM = 2; // > this distance from typical → replace

const EARTH_R_KM = 6371.0088;
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.sqrt(a));
}

function bucketOf(tMs) {
  // KL is UTC+8 with no DST. Use arithmetic instead of Intl.DateTimeFormat
  // so this stays O(1) with no object allocation — called 300k+ times during
  // a cold model build, where the old Intl approach cost ~1m30s.
  const klMs = tMs + 8 * 3600 * 1000;
  return (Math.floor(klMs / 1000) % 86400 / 1800) | 0;
}

// Fractional half-hour bucket for interpolation. KL is UTC+8 (no DST).
// Returns a float in [0, 48). Example: 6:15:00 KL → 12.5; 6:30:00 KL → 13.0.
function fractionalBucket(tMs) {
  const klMs = tMs + 8 * 3600 * 1000;
  return (Math.floor(klMs / 1000) % 86400) / 1800;
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Scan every stored day. For each row, append (lat, lon) to
//   model.byBusRouteBucket[bus_id|route|bucket]  AND
//   model.byRouteBucket[route|bucket]
// Then collapse each bucket to its median.
async function buildCrossDayModel({ onProgress = null } = {}) {
  const dates = listDates();
  const byBusRouteBucketRaw = new Map();
  const byRouteBucketRaw = new Map();
  const byBusBucketRaw = new Map(); // tier 3: (bus_id, bucket) for unknown-route buses
  let totalRows = 0;

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    await loadDate(d.date, (row) => {
      if (row.lat == null || row.lon == null) return;
      const b = bucketOf(row.time);

      // Tier 3: all rows with valid positions (includes unknown-route)
      const k3 = `${row.bus_id}|${b}`;
      let v3 = byBusBucketRaw.get(k3);
      if (!v3) { v3 = { lats: [], lons: [] }; byBusBucketRaw.set(k3, v3); }
      v3.lats.push(row.lat);
      v3.lons.push(row.lon);

      // Tiers 1 & 2: known-route rows only
      if (!row.route || row.route === "Unknown") return;
      const route = row.route;
      const k1 = `${row.bus_id}|${route}|${b}`;
      const k2 = `${route}|${b}`;
      let v1 = byBusRouteBucketRaw.get(k1);
      if (!v1) { v1 = { lats: [], lons: [] }; byBusRouteBucketRaw.set(k1, v1); }
      v1.lats.push(row.lat);
      v1.lons.push(row.lon);
      let v2 = byRouteBucketRaw.get(k2);
      if (!v2) { v2 = { lats: [], lons: [] }; byRouteBucketRaw.set(k2, v2); }
      v2.lats.push(row.lat);
      v2.lons.push(row.lon);
      totalRows += 1;
    });
    if (onProgress) onProgress(i + 1, dates.length, d.date);
  }

  const byBusRouteBucket = new Map();
  for (const [k, v] of byBusRouteBucketRaw) {
    byBusRouteBucket.set(k, { lat: median(v.lats), lon: median(v.lons), n: v.lats.length });
  }
  const byRouteBucket = new Map();
  for (const [k, v] of byRouteBucketRaw) {
    byRouteBucket.set(k, { lat: median(v.lats), lon: median(v.lons), n: v.lats.length });
  }
  const byBusBucket = new Map();
  for (const [k, v] of byBusBucketRaw) {
    byBusBucket.set(k, { lat: median(v.lats), lon: median(v.lons), n: v.lats.length });
  }
  return {
    byBusRouteBucket,
    byRouteBucket,
    byBusBucket,
    total_rows: totalRows,
    days_scanned: dates.length,
    built_at_ms: Date.now(),
  };
}

// Apply the model to a single row → returns its adjusted (lat, lon). When
// raw position is within POSITION_JUMP_KM of the interpolated typical, the
// raw is kept; when it diverges, the interpolated typical is used.
// Returns null when no typical exists at all (case 3).
function adjustRow(model, row) {
  if (!model) return null;

  const tFrac = fractionalBucket(row.time);
  const lo = Math.floor(tFrac - 0.5);
  const hi = lo + 1;
  const frac = tFrac - (lo + 0.5);
  const route = row.route || "Unknown";

  const lookup = (b) => {
    if (b < 0 || b >= 48) return null;
    if (route !== "Unknown") {
      return (
        model.byBusRouteBucket.get(`${row.bus_id}|${route}|${b}`) ||
        model.byRouteBucket.get(`${route}|${b}`) ||
        null
      );
    }
    // Tier 3: unknown-route fallback keyed on (bus_id, bucket) only
    return model.byBusBucket?.get(`${row.bus_id}|${b}`) || null;
  };

  const tLo = lookup(lo);
  const tHi = lookup(hi);

  let typLat, typLon;
  if (tLo && tHi) {
    typLat = tLo.lat * (1 - frac) + tHi.lat * frac;
    typLon = tLo.lon * (1 - frac) + tHi.lon * frac;
  } else if (tLo) {
    typLat = tLo.lat; typLon = tLo.lon;
  } else if (tHi) {
    typLat = tHi.lat; typLon = tHi.lon;
  } else {
    return null;
  }

  if (row.lat == null || row.lon == null) {
    return { lat: typLat, lon: typLon, source: "model" };
  }
  const distKm = haversineKm(row.lat, row.lon, typLat, typLon);
  if (distKm > POSITION_JUMP_KM) {
    return { lat: typLat, lon: typLon, source: "model" };
  }
  return { lat: row.lat, lon: row.lon, source: "raw" };
}

// One-shot cache wrapper. Cross-day rebuild is expensive (~all stored data);
// callers go through this so the maintenance UI can force a refresh.
let _model = null;
async function getCrossDayModel({ rebuild = false, onProgress = null } = {}) {
  if (_model && !rebuild) return _model;
  _model = await buildCrossDayModel({ onProgress });
  return _model;
}

function modelStats() {
  if (!_model) return { built: false };
  return {
    built: true,
    rows: _model.total_rows,
    days: _model.days_scanned,
    bus_route_bucket_cells: _model.byBusRouteBucket.size,
    route_bucket_cells: _model.byRouteBucket.size,
    built_at_ms: _model.built_at_ms,
  };
}

module.exports = {
  buildCrossDayModel,
  getCrossDayModel,
  adjustRow,
  modelStats,
  bucketOf,
  POSITION_JUMP_KM,
};
