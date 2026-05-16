// JSON Lines persistence for accumulator data.
//
// Each tick's bus rows are appended to `data/<KL_DATE>.jsonl` — one JSON
// object per line. Format intentionally matches one row of the Python parquet
// day_history so a future tool can convert between them.
//
// Storage budget: ~300 buses × 30 s cadence × 16 active hours/day ×
// ~250 bytes/line ≈ 14 MB/day. Well under any Hostinger Premium disk quota.
//
// JSONL chosen over parquet because:
//   - parse-on-write is trivial (`fs.appendFile`)
//   - no JS parquet library needed
//   - human-inspectable (`tail -f data/2026-05-12.jsonl`)
//   - tolerates partial last-line damage cleanly

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { STORE_BUFFER_FLUSH_MS, STORE_STREAM_IDLE_CLOSE_MS } = require("./config");

const DATA_DIR = path.join(__dirname, "data");
// Read-only source of historical parquet files written by the Python app.
// Configurable so the JS app can run alongside or independently.
const HISTORY_DIR = process.env.HISTORY_DIR
  ? path.resolve(process.env.HISTORY_DIR)
  : path.join(__dirname, "..", "history");

// hyparquet is ESM-only — load it lazily through dynamic import so the rest
// of this CommonJS module stays simple.
let _hyparquet = null;
async function getHyparquet() {
  if (!_hyparquet) _hyparquet = await import("hyparquet");
  return _hyparquet;
}
const KL_TZ = "Asia/Kuala_Lumpur";
const KL_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: KL_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function klDate(tMs) {
  return KL_DATE_FMT.format(new Date(tMs)); // "2026-05-12"
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
ensureDataDir();

function fileFor(klDateStr) {
  return path.join(DATA_DIR, `${klDateStr}.jsonl`);
}

// Buffered writer to avoid open(2)+close(2) per tick. Each unique date has
// its own append-only stream that we keep open until day rollover or process
// exit. Buffer is flushed when it reaches BUFFER_LINES or when the date
// rolls.
const writers = new Map(); // klDateStr -> { stream, lastUsedMs } // explicit flush every 2 s

function getStream(klDateStr) {
  let w = writers.get(klDateStr);
  if (!w) {
    const stream = fs.createWriteStream(fileFor(klDateStr), { flags: "a" });
    w = { stream, lastUsedMs: Date.now() };
    writers.set(klDateStr, w);
  } else {
    w.lastUsedMs = Date.now();
  }
  return w.stream;
}

function closeIdleStreams(idleMs = STORE_STREAM_IDLE_CLOSE_MS) {
  const now = Date.now();
  for (const [date, w] of writers) {
    if (now - w.lastUsedMs > idleMs) {
      w.stream.end();
      writers.delete(date);
    }
  }
}
setInterval(closeIdleStreams, 30_000).unref();

// One row per (bus, tick). Field names match the Python parquet schema
// (busapp/pipeline.py:131-145) byte-for-byte so the JSONL and parquet are
// interchangeable persistence formats. Only the `time` field differs in VALUE
// representation — Python writes a pandas datetime; JS writes an epoch-ms
// integer — but the column name matches. Pass values come from the live
// pipeline; `speeds.*` keys are internal mode short-names (raw / corrected /
// calc / kalman / trust) that map to schema column names via:
//
//   speeds.raw       → "speed"            (Python: `speed`, raw GTFS value)
//   speeds.corrected → "speed_corrected"  (Python: `speed_corrected`)
//   speeds.calc      → "calculated_speed" (Python: `calculated_speed`)
//   speeds.kalman    → "speed_kalman"     (Python: `speed_kalman`)
//   speeds.trust     → "weighted_speed"   (Python: `weighted_speed`)
//
// Older JSONL files (pre-rename) used `speed_raw / speed_calc / speed_trust /
// t` — `normalizeRow` below upgrades them transparently on read.
function appendTick(busId, route, tMs, lat, lon, speeds, trustScore = null) {
  const date = klDate(tMs);
  const row = {
    bus_id: busId,
    route: route || "Unknown",
    time: tMs,
    lat,
    lon,
    speed: speeds.raw,
    speed_corrected: speeds.corrected,
    calculated_speed: speeds.calc,
    speed_kalman: speeds.kalman,
    weighted_speed: speeds.trust,
    trust_score: trustScore,
  };
  getStream(date).write(JSON.stringify(row) + "\n");
}

function flushAll() {
  for (const w of writers.values()) {
    try {
      w.stream.write(""); // no-op but pokes the buffered write
    } catch {
      /* ignore */
    }
  }
}
setInterval(flushAll, STORE_BUFFER_FLUSH_MS).unref();

// Normalize a JSONL row in-place so legacy files (written before the
// Python-schema rename) load alongside new ones. Only the four renamed
// fields need translating; everything else (bus_id / route / lat / lon /
// speed_kalman / speed_corrected / trust_score / adj_* / snap_*) was
// already named to match Python.
//
// Legacy → current:
//   t              → time
//   speed_raw      → speed
//   speed_calc     → calculated_speed
//   speed_trust    → weighted_speed
//
// Idempotent: a row already in the new schema passes through untouched.
function normalizeRow(row) {
  if (row.time == null && row.t != null) row.time = row.t;
  if (row.speed == null && row.speed_raw != null) row.speed = row.speed_raw;
  if (row.calculated_speed == null && row.speed_calc != null) {
    row.calculated_speed = row.speed_calc;
  }
  if (row.weighted_speed == null && row.speed_trust != null) {
    row.weighted_speed = row.speed_trust;
  }
  return row;
}

// Stream a JSONL file row by row through a callback. Tolerates partial last
// lines (interrupted writes). Every row passes through `normalizeRow` so
// downstream code only ever sees the current schema.
async function loadJsonlFile(file, onRow) {
  if (!fs.existsSync(file)) return 0;
  return await new Promise((resolve, reject) => {
    let count = 0;
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line) return;
      try {
        onRow(normalizeRow(JSON.parse(line)));
        count += 1;
      } catch {
        /* partial line */
      }
    });
    rl.on("close", () => resolve(count));
    rl.on("error", (err) => reject(err));
  });
}

// Load a Python parquet file (history/<date>.parquet schema). Since the
// schema rename, JS field names match Python 1:1 — only `time` requires unit
// conversion (Python datetime → JS epoch ms). `adj_lat / adj_lon` substitute
// for `lat / lon` per Pass-16 cleanup when present. hyparquet returns rows as
// plain objects with native Date for `time` and nullable numbers for missing
// values, which maps cleanly.
async function loadParquetFile(file, onRow) {
  if (!fs.existsSync(file)) return 0;
  const { parquetReadObjects } = await getHyparquet();
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  // Ask only for the columns we need — hyparquet honors this and skips the
  // rest, which cuts memory + decode time roughly in half on a typical day.
  // `speed_corrected` and `trust_score` ARE present in Python parquets
  // (busapp/pipeline.py writes them every flush); fetch them so historical
  // replays in the heatmap "Corrected" mode show Python's actual values
  // rather than silently falling back to raw.
  const wantedColumns = [
    "bus_id",
    "route",
    "time",
    "lat",
    "lon",
    "adj_lat",
    "adj_lon",
    "snap_shape_id",
    "snap_cumdist",
    "speed",
    "speed_corrected",
    "calculated_speed",
    "speed_kalman",
    "weighted_speed",
    "trust_score",
  ];

  let count = 0;
  // parquetReadObjects buffers the whole file — fine for our ~50k-row days.
  const rows = await parquetReadObjects({
    file: ab,
    columns: wantedColumns,
  });
  for (const r of rows) {
    if (r.bus_id == null) continue;
    // Prefer adj_lat/adj_lon when present (Pass-16 cleanup).
    const lat = r.adj_lat != null ? r.adj_lat : r.lat;
    const lon = r.adj_lon != null ? r.adj_lon : r.lon;
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const tMs = r.time instanceof Date ? r.time.getTime() : Number(r.time);
    onRow({
      bus_id: r.bus_id,
      route: r.route || "Unknown",
      time: tMs,
      lat,
      lon,
      speed: r.speed,
      // Python parquets DO carry speed_corrected (cross-bus per-tick outlier
      // correction, computed in the live pipeline). Use it directly. Fall
      // back to raw only when the column is genuinely absent (very old
      // parquets predating the corrected column).
      speed_corrected: r.speed_corrected != null ? r.speed_corrected : r.speed,
      calculated_speed: r.calculated_speed,
      speed_kalman: r.speed_kalman,
      weighted_speed: r.weighted_speed,
      trust_score: r.trust_score != null ? r.trust_score : null,
      snap_shape_id: r.snap_shape_id ?? null,
      snap_cumdist: r.snap_cumdist != null ? Number(r.snap_cumdist) : null,
    });
    count += 1;
  }
  return count;
}

// Load a date from whichever source has it. Priority:
//   1. busjs/data/<date>.parquet  — converted from JSONL (most compact)
//   2. busjs/data/<date>.jsonl    — live or in-progress
//   3. ../history/<date>.parquet  — Python-generated historical data
async function loadDate(klDateStr, onRow) {
  const localParquet = path.join(DATA_DIR, `${klDateStr}.parquet`);
  if (fs.existsSync(localParquet)) return await loadParquetFile(localParquet, onRow);
  const jsonl = fileFor(klDateStr);
  if (fs.existsSync(jsonl)) return await loadJsonlFile(jsonl, onRow);
  const parquet = path.join(HISTORY_DIR, `${klDateStr}.parquet`);
  if (fs.existsSync(parquet)) return await loadParquetFile(parquet, onRow);
  return 0;
}

// List dates with stored data, newest first. Priority per date:
//   1. busjs/data/<date>.parquet  — converted (local_parquet)
//   2. busjs/data/<date>.jsonl    — in-progress / not yet converted (jsonl)
//   3. ../history/<date>.parquet  — Python-generated (parquet)
function listDates() {
  ensureDataDir();
  const byDate = new Map();
  const jsonlRe = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
  const parquetRe = /^(\d{4}-\d{2}-\d{2})\.parquet$/;

  // Local parquets take highest priority.
  for (const name of fs.readdirSync(DATA_DIR)) {
    const m = name.match(parquetRe);
    if (!m) continue;
    const f = path.join(DATA_DIR, name);
    const st = fs.statSync(f);
    byDate.set(m[1], {
      date: m[1],
      source: "local_parquet",
      size_bytes: st.size,
      mtime_ms: st.mtimeMs,
    });
  }
  // JSOLs win over Python parquets but yield to local parquets.
  for (const name of fs.readdirSync(DATA_DIR)) {
    const m = name.match(jsonlRe);
    if (!m) continue;
    if (byDate.has(m[1])) continue; // local parquet wins
    const f = path.join(DATA_DIR, name);
    const st = fs.statSync(f);
    byDate.set(m[1], {
      date: m[1],
      source: "jsonl",
      size_bytes: st.size,
      mtime_ms: st.mtimeMs,
    });
  }
  // Python history parquets as fallback.
  if (fs.existsSync(HISTORY_DIR)) {
    for (const name of fs.readdirSync(HISTORY_DIR)) {
      const m = name.match(parquetRe);
      if (!m) continue;
      if (byDate.has(m[1])) continue;
      const f = path.join(HISTORY_DIR, name);
      const st = fs.statSync(f);
      byDate.set(m[1], {
        date: m[1],
        source: "parquet",
        size_bytes: st.size,
        mtime_ms: st.mtimeMs,
      });
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

// Used by /api/health.
function storeStats() {
  const dates = listDates();
  let totalBytes = 0;
  let jsonlDays = 0;
  let parquetDays = 0;
  for (const d of dates) {
    totalBytes += d.size_bytes;
    if (d.source === "jsonl") jsonlDays += 1;
    else parquetDays += 1;
  }
  return {
    open_writers: writers.size,
    days_stored: dates.length,
    jsonl_days: jsonlDays,
    parquet_days: parquetDays,
    bytes_stored: totalBytes,
    newest_date: dates[0] ? dates[0].date : null,
    history_dir: HISTORY_DIR,
  };
}

module.exports = {
  DATA_DIR,
  appendTick,
  loadDate,
  listDates,
  storeStats,
  klDate,
  normalizeRow,
};
