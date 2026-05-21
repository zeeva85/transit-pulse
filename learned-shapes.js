// Learned-shapes pipeline — port of busapp/history.py:
// accumulate_unknown_positions + promote_learned_shapes (Pass 17).
//
// Goal: for buses whose `route` column is missing/"Unknown" AND whose GPS
// path doesn't already match any known shape, accumulate their positions
// across days; when a bus has consistently appeared in roughly the same
// places, publish its own LRN_<bus_id> polyline so future inference + the
// route-line overlay can render it.
//
// Storage:
//   gtfs_static/unknown_observations.jsonl   — append-only accumulator
//   gtfs_static/extended_shapes.txt          — published learned shapes
//                                              (same column schema as
//                                              shapes.txt; loaded together
//                                              by the GTFS-loading pass)

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { listDates, loadDate } = require("./store");

const GTFS_DIR = path.join(__dirname, "gtfs_static");
const UNKNOWN_FILE = path.join(GTFS_DIR, "unknown_observations.jsonl");
const EXTENDED_FILE = path.join(GTFS_DIR, "extended_shapes.txt");
const EXTENDED_ROUTES_FILE = path.join(GTFS_DIR, "extended_routes.txt");

// Same thresholds as Python — values live in config.js (edit both sides together).
const {
  LEARNED_PROMOTION_MIN_DAYS:    PROMOTION_MIN_DAYS,
  LEARNED_PROMOTION_MIN_POINTS:  PROMOTION_MIN_POINTS,
  LEARNED_PROMOTION_MAX_SPREAD_M: PROMOTION_MAX_SPREAD_M,
} = require("./config");
const BUCKET_MIN = 30; // half-hour bucket width in minutes (structural — not tuneable)
const KL_OFFSET_MS = 8 * 3600 * 1000; // UTC+8, no DST

// Half-hour bucket index (0–47) anchored to KL midnight.
// Uses fixed UTC+8 offset arithmetic — same as cross-day.js:bucketOf() —
// to avoid allocating Intl.DateTimeFormat objects in hot per-row loops.
function bucketOfKL(tMs) {
  const secondsInDay = ((tMs + KL_OFFSET_MS) / 1000 | 0) % 86400;
  return (secondsInDay / (BUCKET_MIN * 60)) | 0;
}

function isUnknownRoute(route) {
  return !route || route === "Unknown" || route === "null";
}

// Walk every stored day. For each row whose route is Unknown, append a
// minimal observation to UNKNOWN_FILE.
//
// Mirrors Python accumulate_unknown_positions: append-and-dedup by
// (bus_id, observation_date), and skip already-promoted buses (those with
// a LRN_<bus_id> entry in extended_shapes.txt). The previous version wiped
// the file every run, which both dropped the dedup property and forced a
// full re-scan even when nothing new had landed.
async function accumulateUnknownPositions({ onProgress = null } = {}) {
  if (!fs.existsSync(GTFS_DIR)) fs.mkdirSync(GTFS_DIR, { recursive: true });

  // Pre-load (bus_id, observation_date) keys already in the accumulator and
  // bus_ids that have already graduated into LRN_<bus_id> shapes.
  const seen = new Set();
  if (fs.existsSync(UNKNOWN_FILE)) {
    for (const line of fs.readFileSync(UNKNOWN_FILE, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        seen.add(`${row.bus_id}|${row.observation_date}`);
      } catch {
        /* tolerate partial last line */
      }
    }
  }
  const promoted = new Set();
  for (const sid of loadExistingLrnShapeIds()) {
    if (sid.startsWith("LRN_")) promoted.add(sid.slice(4));
  }

  const dates = listDates();
  const out = fs.createWriteStream(UNKNOWN_FILE, { flags: "a" });
  let count = 0;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    await loadDate(d.date, (row) => {
      if (row.lat == null || row.lon == null) return;
      if (!isUnknownRoute(row.route)) return;
      if (promoted.has(row.bus_id)) return;
      const key = `${row.bus_id}|${d.date}`;
      if (seen.has(key)) return;
      out.write(
        JSON.stringify({
          bus_id: row.bus_id,
          observation_date: d.date,
          // Match Python `unknown_observations.parquet` column name
          // (busapp/history.py:586). Legacy rows in this accumulator may
          // still carry `t`; the promoter below upgrades them on read.
          time: row.time,
          lat: row.lat,
          lon: row.lon,
        }) + "\n"
      );
      count += 1;
    });
    if (onProgress) onProgress(i + 1, dates.length, d.date);
  }
  await new Promise((r) => out.end(r));
  return count;
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function loadExistingLrnShapeIds() {
  if (!fs.existsSync(EXTENDED_FILE)) return new Set();
  const out = new Set();
  const lines = fs.readFileSync(EXTENDED_FILE, "utf8").split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const sid = line.split(",")[0];
    if (sid) out.add(sid);
  }
  return out;
}

// Group accumulator entries by bus_id, then walk each bus's positions to
// decide if it meets the promotion criteria. Returns { promoted, skipped }
// summaries; written shapes append to EXTENDED_FILE in shapes.txt schema.
async function promoteLearnedShapes() {
  if (!fs.existsSync(UNKNOWN_FILE)) {
    return { promoted: 0, skipped: 0, candidates: 0 };
  }
  const byBus = new Map();
  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(UNKNOWN_FILE, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (!line) return;
      try {
        const row = JSON.parse(line);
        // Legacy rows used `t`; current schema uses `time`. Normalize on
        // read so the bucket / median pipeline doesn't need a fallback.
        if (row.time == null && row.t != null) row.time = row.t;
        let entries = byBus.get(row.bus_id);
        if (!entries) {
          entries = [];
          byBus.set(row.bus_id, entries);
        }
        entries.push(row);
      } catch {
        /* tolerate partial last line */
      }
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });

  const existing = loadExistingLrnShapeIds();
  const newShapeLines = [];
  let promoted = 0;
  let skipped = 0;

  for (const [busId, entries] of byBus) {
    const sid = `LRN_${busId}`;
    if (existing.has(sid)) {
      skipped += 1;
      continue;
    }

    // ≥ 3 distinct observation dates.
    const distinctDates = new Set(entries.map((e) => e.observation_date));
    if (distinctDates.size < PROMOTION_MIN_DAYS) {
      skipped += 1;
      continue;
    }
    // ≥ 100 total positions.
    if (entries.length < PROMOTION_MIN_POINTS) {
      skipped += 1;
      continue;
    }

    // Bucket all observations into 30-min slots; compute per-bucket median
    // (lat, lon). Spread = average distance between bucket-median and the
    // observations that landed in that bucket. ≤ 200 m means the bus's
    // positions cluster (it's running a real route), not scatter.
    const byBucket = new Map();
    for (const e of entries) {
      const b = bucketOfKL(e.time);
      let arr = byBucket.get(b);
      if (!arr) {
        arr = [];
        byBucket.set(b, arr);
      }
      arr.push(e);
    }
    // Spread metric: per-bucket sample-stdev of (lat, lon) in degrees,
    // converted to meters via the same 1 ° ≈ 111 000 m constant Python uses
    // in promote_learned_shapes, then median across buckets. Sample stdev
    // (ddof = 1) matches pandas' default. Buckets with a single observation
    // contribute spread 0 (Python's NaN-fill via .fillna(0)).
    function sampleStdev(values) {
      const n = values.length;
      if (n < 2) return 0;
      const mu = values.reduce((s, v) => s + v, 0) / n;
      let s = 0;
      for (const v of values) s += (v - mu) * (v - mu);
      return Math.sqrt(s / (n - 1));
    }
    const bucketMedians = [];
    const bucketSpreadsM = [];
    for (const [b, arr] of byBucket) {
      const lats = arr.map((e) => e.lat);
      const lons = arr.map((e) => e.lon);
      bucketMedians.push({ bucket: b, lat: median(lats), lon: median(lons) });
      const latStd = sampleStdev(lats);
      const lonStd = sampleStdev(lons);
      bucketSpreadsM.push(Math.sqrt(latStd * latStd + lonStd * lonStd) * 111000);
    }
    const spreadMedian = median(bucketSpreadsM);
    if (spreadMedian == null || spreadMedian > PROMOTION_MAX_SPREAD_M) {
      skipped += 1;
      continue;
    }

    // Promote. The polyline is just the bucket-medians sorted by bucket
    // (i.e. by time of day), which traces the bus's typical daily route.
    bucketMedians.sort((a, b) => a.bucket - b.bucket);
    for (let i = 0; i < bucketMedians.length; i++) {
      const bm = bucketMedians[i];
      newShapeLines.push(`${sid},${bm.lat},${bm.lon},${i + 1}`);
    }
    promoted += 1;
  }

  if (newShapeLines.length > 0) {
    // Create the file with the standard header if it doesn't exist yet,
    // otherwise append.
    const exists = fs.existsSync(EXTENDED_FILE);
    const header = "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n";
    const body = newShapeLines.join("\n") + "\n";
    if (exists) {
      fs.appendFileSync(EXTENDED_FILE, body);
    } else {
      fs.writeFileSync(EXTENDED_FILE, header + body);
    }

    // Write a route label entry for each promoted bus so the live pipeline
    // can resolve the label instead of "Unknown" from the next tick onward.
    const promotedBusIds = newShapeLines
      .map((l) => l.split(",")[0])
      .filter((sid, i, arr) => arr.indexOf(sid) === i) // deduplicate shape IDs
      .map((sid) => sid.slice(4)); // strip "LRN_" prefix

    const existingRouteIds = new Set();
    if (fs.existsSync(EXTENDED_ROUTES_FILE)) {
      const lines = fs.readFileSync(EXTENDED_ROUTES_FILE, "utf8").split("\n");
      for (const line of lines.slice(1)) { // skip header
        const cols = line.split(",");
        if (cols[0]) existingRouteIds.add(cols[0]);
      }
    }
    const newRouteLines = promotedBusIds
      .filter((busId) => !existingRouteIds.has(`LRN_${busId}`))
      .map((busId) => `LRN_${busId},LRN,Learned route (${busId})`);
    if (newRouteLines.length > 0) {
      const routeHeader = "route_id,route_short_name,route_long_name\n";
      const routeBody = newRouteLines.join("\n") + "\n";
      if (fs.existsSync(EXTENDED_ROUTES_FILE)) {
        fs.appendFileSync(EXTENDED_ROUTES_FILE, routeBody);
      } else {
        fs.writeFileSync(EXTENDED_ROUTES_FILE, routeHeader + routeBody);
      }
    }
  }

  // Drop promoted buses' rows from the accumulator — they've graduated and
  // continuing to log them just wastes space. Mirrors Python's
  // `df_orig[~df_orig["bus_id"].isin(promoted_bus_ids)]` at the end of
  // promote_learned_shapes. We rewrite the JSONL atomically via temp + rename.
  const promotedSet = new Set();
  for (const [busId, entries] of byBus) {
    // Re-detect promoted from this run: any bus whose shape_id is in newShapeLines.
    if (newShapeLines.some((l) => l.startsWith(`LRN_${busId},`))) {
      promotedSet.add(busId);
      void entries; // silence unused
    }
  }
  if (promotedSet.size > 0 && fs.existsSync(UNKNOWN_FILE)) {
    const tmp = UNKNOWN_FILE + ".tmp";
    const lines = fs.readFileSync(UNKNOWN_FILE, "utf8").split("\n");
    const kept = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (!promotedSet.has(row.bus_id)) kept.push(line);
      } catch {
        /* tolerate partial last line — dropped */
      }
    }
    fs.writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "");
    fs.renameSync(tmp, UNKNOWN_FILE);
  }

  return { promoted, skipped, candidates: byBus.size };
}

function stats() {
  let unknownLines = 0;
  if (fs.existsSync(UNKNOWN_FILE)) {
    unknownLines = fs.readFileSync(UNKNOWN_FILE, "utf8").split("\n").length - 1;
  }
  let learnedShapes = 0;
  if (fs.existsSync(EXTENDED_FILE)) {
    learnedShapes = loadExistingLrnShapeIds().size;
  }
  return {
    unknown_observations: unknownLines,
    learned_shapes: learnedShapes,
    extended_shapes_file: EXTENDED_FILE,
  };
}

module.exports = {
  accumulateUnknownPositions,
  promoteLearnedShapes,
  stats,
  EXTENDED_FILE,
};
