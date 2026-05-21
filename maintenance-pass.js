// Per-row consumers used by /api/maintenance/run so the cross-day position
// model and the unknown-position accumulator share ONE loadDate() pass over
// every stored day. Previously each ran its own full scan (roughly 2x the
// runtime). The shared "ctx" objects hold mutable state; the orchestrator
// passes each row to both `consume` callbacks.

const fs = require("fs");
const path = require("path");

const GTFS_DIR = path.join(__dirname, "gtfs_static");
const UNKNOWN_FILE = path.join(GTFS_DIR, "unknown_observations.jsonl");
const EXTENDED_FILE = path.join(GTFS_DIR, "extended_shapes.txt");

// ── Cross-day model context ───────────────────────────────────────────

const KL_HOUR_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kuala_Lumpur",
  hour: "numeric",
  hourCycle: "h23",
});
const KL_MINUTE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kuala_Lumpur",
  minute: "2-digit",
});

function bucketOf(tMs) {
  const d = new Date(tMs);
  const h = parseInt(KL_HOUR_FMT.format(d), 10);
  const m = parseInt(KL_MINUTE_FMT.format(d), 10);
  return ((h * 60 + m) / 30) | 0;
}

function median(arr) {
  if (arr.length === 0) return null;
  arr = arr.slice().sort((a, b) => a - b);
  const n = arr.length;
  return n % 2 === 1 ? arr[(n - 1) >> 1] : (arr[n / 2 - 1] + arr[n / 2]) / 2;
}

function buildCrossDayModelFromRow() {
  const byBusRouteBucket = new Map();
  const byRouteBucket = new Map();
  const byBusBucket = new Map(); // tier 3: (bus_id, bucket) — includes unknown-route buses
  let totalRows = 0;

  function consume(row) {
    if (row.lat == null || row.lon == null) return;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) return;
    const b = bucketOf(row.time);

    // Tier 3: all rows with valid positions (includes unknown-route). Must be
    // accumulated before the unknown-route early-return below so unknown-route
    // buses still get a typical position for adj_lat/adj_lon cleanup.
    const k3 = `${row.bus_id}|${b}`;
    let v3 = byBusBucket.get(k3);
    if (!v3) { v3 = { lats: [], lons: [] }; byBusBucket.set(k3, v3); }
    v3.lats.push(row.lat);
    v3.lons.push(row.lon);

    // Match Python build_cross_day_position_model — Unknown / null routes
    // are excluded from Tiers 1 & 2 (they'd pool into a shared fallback
    // bucket and poison the (route, bucket) lookup tier).
    if (!row.route || row.route === "Unknown") return;
    const route = row.route;
    const k1 = `${row.bus_id}|${route}|${b}`;
    const k2 = `${route}|${b}`;
    let v1 = byBusRouteBucket.get(k1);
    if (!v1) {
      v1 = { lats: [], lons: [] };
      byBusRouteBucket.set(k1, v1);
    }
    v1.lats.push(row.lat);
    v1.lons.push(row.lon);
    let v2 = byRouteBucket.get(k2);
    if (!v2) {
      v2 = { lats: [], lons: [] };
      byRouteBucket.set(k2, v2);
    }
    v2.lats.push(row.lat);
    v2.lons.push(row.lon);
    totalRows += 1;
  }

  return { consume, byBusRouteBucket, byRouteBucket, byBusBucket, totalRowsRef: () => totalRows };
}

function finalizeCrossDayModel(ctx, daysScanned = 0) {
  const final1 = new Map();
  for (const [k, v] of ctx.byBusRouteBucket) {
    final1.set(k, { lat: median(v.lats), lon: median(v.lons), n: v.lats.length });
  }
  const final2 = new Map();
  for (const [k, v] of ctx.byRouteBucket) {
    final2.set(k, { lat: median(v.lats), lon: median(v.lons), n: v.lats.length });
  }
  const final3 = new Map();
  for (const [k, v] of ctx.byBusBucket) {
    final3.set(k, { lat: median(v.lats), lon: median(v.lons), n: v.lats.length });
  }
  return {
    byBusRouteBucket: final1,
    byRouteBucket: final2,
    byBusBucket: final3,
    total_rows: ctx.totalRowsRef(),
    days_scanned: daysScanned,
    built_at_ms: Date.now(),
  };
}

// ── Unknown-observation accumulator context ─────────────────────────────

function isUnknownRoute(route) {
  return !route || route === "Unknown" || route === "null";
}

// Pre-load every (bus_id, observation_date) already present in the
// accumulator so the maintenance pass can skip duplicates instead of
// wiping the file and re-scanning all history. Matches Python's
// accumulate_unknown_positions "seen" set semantics.
function loadSeenKeys() {
  if (!fs.existsSync(UNKNOWN_FILE)) return new Set();
  const out = new Set();
  // Whole-file read is fine — the accumulator stays small (< a few MB).
  const lines = fs.readFileSync(UNKNOWN_FILE, "utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      out.add(`${row.bus_id}|${row.observation_date}`);
    } catch {
      /* tolerate partial last line */
    }
  }
  return out;
}

// Pre-load already-promoted bus_ids so we don't keep accumulating positions
// for buses that have graduated into LRN_<bus_id> shapes.
function loadPromotedBusIds() {
  if (!fs.existsSync(EXTENDED_FILE)) return new Set();
  const out = new Set();
  const lines = fs.readFileSync(EXTENDED_FILE, "utf8").split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const sid = line.split(",")[0];
    if (sid && sid.startsWith("LRN_")) out.add(sid.slice(4));
  }
  return out;
}

function unknownAccumulatorFromRow() {
  if (!fs.existsSync(GTFS_DIR)) fs.mkdirSync(GTFS_DIR, { recursive: true });
  // Append-and-dedup semantics (matches Python). Existing entries are kept;
  // each maintenance run only adds newly-observed (bus_id, date) combinations
  // and skips buses already promoted to LRN_<bus_id> shapes.
  const seen = loadSeenKeys();
  const promoted = loadPromotedBusIds();
  const stream = fs.createWriteStream(UNKNOWN_FILE, { flags: "a" });
  let count = 0;

  function consume(row, date) {
    if (row.lat == null || row.lon == null) return;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) return;
    if (!isUnknownRoute(row.route)) return;
    if (promoted.has(row.bus_id)) return;
    if (seen.has(`${row.bus_id}|${date}`)) return;
    stream.write(
      JSON.stringify({
        bus_id: row.bus_id,
        observation_date: date,
        // Match Python `unknown_observations.parquet` column name
        // (busapp/history.py:586). Legacy rows used `t`; learned-shapes.js
        // reads either via fallback.
        time: row.time,
        lat: row.lat,
        lon: row.lon,
      }) + "\n"
    );
    count += 1;
  }

  return { consume, stream, countRef: () => count };
}

async function closeUnknownAccumulator(ctx) {
  const c = ctx.countRef();
  await new Promise((r) => ctx.stream.end(r));
  return c;
}

module.exports = {
  buildCrossDayModelFromRow,
  finalizeCrossDayModel,
  unknownAccumulatorFromRow,
  closeUnknownAccumulator,
};
