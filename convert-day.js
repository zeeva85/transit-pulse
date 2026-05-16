// End-of-day JSONL → Parquet conversion.
// Called automatically at KL midnight (maybeRunDayRollover) after the day's
// JSONL has been augmented with adj_lat/adj_lon/snap_* columns.
//
// Schema mirrors Python history/*.parquet (busapp/pipeline.py columns +
// augmentation columns). `time` is stored as INT64 (ms-epoch) — Python writes
// a datetime; hyparquet handles both via
//   r.time instanceof Date ? r.time.getTime() : Number(r.time)
// so loadParquetFile in store.js reads JS and Python parquets identically.
//
// Atomic write: .parquet.tmp → .parquet rename. Source JSONL is deleted only
// after a successful write, so an interrupted conversion leaves the JSONL
// intact and can be retried.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { normalizeRow, DATA_DIR } = require("./store");

// Parquet schema — optional: true marks nullable columns.
function buildSchema(parquet) {
  return new parquet.ParquetSchema({
    bus_id:           { type: "UTF8" },
    route:            { type: "UTF8" },
    time:             { type: "INT64" },
    lat:              { type: "DOUBLE", optional: true },
    lon:              { type: "DOUBLE", optional: true },
    speed:            { type: "DOUBLE", optional: true },
    speed_corrected:  { type: "DOUBLE", optional: true },
    calculated_speed: { type: "DOUBLE", optional: true },
    speed_kalman:     { type: "DOUBLE", optional: true },
    weighted_speed:   { type: "DOUBLE", optional: true },
    trust_score:      { type: "DOUBLE", optional: true },
    adj_lat:          { type: "DOUBLE", optional: true },
    adj_lon:          { type: "DOUBLE", optional: true },
    snap_shape_id:    { type: "UTF8",   optional: true },
    snap_cumdist:     { type: "DOUBLE", optional: true },
    weather_temp:     { type: "DOUBLE", optional: true },
    weather_precip:   { type: "DOUBLE", optional: true },
    weather_wind:     { type: "DOUBLE", optional: true },
    weather_code:     { type: "INT32",  optional: true },
  });
}

// Coerce to finite float or null for optional DOUBLE fields.
function toDouble(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function readJsonlRows(file) {
  const rows = [];
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        rows.push(normalizeRow(JSON.parse(line)));
      } catch {
        /* skip malformed lines */
      }
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });
  return rows;
}

// Convert busjs/data/<klDateStr>.jsonl → busjs/data/<klDateStr>.parquet.
// Deletes the JSONL after a successful write.
// Returns { rows, size_bytes } or null if no JSONL exists for that date.
async function convertDayToParquet(klDateStr) {
  const jsonlPath = path.join(DATA_DIR, `${klDateStr}.jsonl`);
  if (!fs.existsSync(jsonlPath)) return null;

  // Lazy-load so the module is only required when actually converting.
  const parquet = require("@dsnp/parquetjs");
  const outPath = path.join(DATA_DIR, `${klDateStr}.parquet`);
  const tmpPath = `${outPath}.tmp`;

  const rows = await readJsonlRows(jsonlPath);
  if (rows.length === 0) {
    fs.unlinkSync(jsonlPath);
    return { rows: 0, size_bytes: 0 };
  }

  const schema = buildSchema(parquet);
  const writer = await parquet.ParquetWriter.openFile(schema, tmpPath);

  for (const r of rows) {
    await writer.appendRow({
      bus_id:           String(r.bus_id || ""),
      route:            String(r.route || "Unknown"),
      time:             Math.round(Number(r.time) || 0),
      lat:              toDouble(r.lat),
      lon:              toDouble(r.lon),
      speed:            toDouble(r.speed),
      speed_corrected:  toDouble(r.speed_corrected),
      calculated_speed: toDouble(r.calculated_speed),
      speed_kalman:     toDouble(r.speed_kalman),
      weighted_speed:   toDouble(r.weighted_speed),
      trust_score:      toDouble(r.trust_score),
      adj_lat:          toDouble(r.adj_lat),
      adj_lon:          toDouble(r.adj_lon),
      snap_shape_id:    r.snap_shape_id != null ? String(r.snap_shape_id) : null,
      snap_cumdist:     toDouble(r.snap_cumdist),
      weather_temp:     toDouble(r.weather_temp),
      weather_precip:   toDouble(r.weather_precip),
      weather_wind:     toDouble(r.weather_wind),
      weather_code:     r.weather_code != null ? Math.round(Number(r.weather_code)) : null,
    });
  }

  await writer.close();
  // Atomic replace, then delete source.
  fs.renameSync(tmpPath, outPath);
  fs.unlinkSync(jsonlPath);

  const { size: size_bytes } = fs.statSync(outPath);
  return { rows: rows.length, size_bytes };
}

module.exports = { convertDayToParquet };
