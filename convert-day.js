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

// Convert busjs/data/<klDateStr>.jsonl → busjs/data/<klDateStr>.parquet.
// Deletes the JSONL after a successful write.
// Returns { rows, size_bytes } or null if no JSONL exists for that date.
async function convertDayToParquet(klDateStr) {
  const jsonlPath = path.join(DATA_DIR, `${klDateStr}.jsonl`);
  if (!fs.existsSync(jsonlPath)) return null;

  // Lazy-load so the module is only required when actually converting.
  const parquet = require("@dsnp/parquetjs");
  const outPath = path.join(DATA_DIR, `${klDateStr}.parquet`);
  // Unique per invocation — see augment-jsonl.js: makes concurrent-writer
  // collisions non-destructive (last rename wins instead of interleaved file).
  const tmpPath = `${outPath}.${process.pid}.${Date.now()}.tmp`;

  // Stream line-by-line instead of materializing every row object first —
  // the whole-day array held ~50-100k objects (tens of MB) at exactly the
  // moment (midnight rollover) the cross-day rebuild already peaks memory.
  // The awaited appendRow provides natural backpressure.
  const schema = buildSchema(parquet);
  const writer = await parquet.ParquetWriter.openFile(schema, tmpPath);
  let rowCount = 0;

  const stream = fs.createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try {
      r = normalizeRow(JSON.parse(line));
    } catch {
      continue; /* skip malformed lines */
    }
    rowCount += 1;
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

  // Empty day (zero parseable rows): keep the old semantics — delete the
  // JSONL, write no parquet. The writer was already opened against the tmp
  // path, so close it defensively and remove the tmp.
  if (rowCount === 0) {
    try { await writer.close(); } catch { /* empty writer may throw */ }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    fs.unlinkSync(jsonlPath);
    return { rows: 0, size_bytes: 0 };
  }

  await writer.close();
  // Atomic replace.
  fs.renameSync(tmpPath, outPath);

  // Verify the parquet is readable and complete BEFORE deleting the JSONL —
  // it is the only recovery source. loadDate's corrupt-parquet fallback
  // ("fall through to JSONL") is useless if the JSONL was already deleted
  // after an unverified write (truncated flush on power loss, parquetjs
  // encoding edge case close() doesn't surface). Read back with RAW
  // hyparquet, not store.js's loadDate — that loader skips non-finite-coord
  // rows (store.js:250), which would spuriously undercount on days with
  // null-position rows (precedent: 2026-01-27's 12k NaN lat/lon rows).
  let readBack = -1;
  try {
    // Full single-column decode (not just footer metadata) — a truncated
    // data section behind an intact footer must fail verification too.
    const { parquetReadObjects, asyncBufferFromFile } = await import("hyparquet");
    const ab = await asyncBufferFromFile(outPath);
    const verifyRows = await parquetReadObjects({ file: ab, columns: ["bus_id"] });
    readBack = verifyRows.length;
  } catch (err) {
    console.error(`[convert] readback of ${outPath} failed:`, err.message);
  }
  if (readBack !== rowCount) {
    // Move the bad parquet aside (kept for forensics as .bad) — it must not
    // stay at the .parquet path, where loadDate would prefer it and a
    // readable-but-short file would silently shadow the intact JSONL.
    const badPath = `${outPath}.bad`;
    try {
      fs.renameSync(outPath, badPath);
    } catch {
      try { fs.unlinkSync(outPath); } catch { /* leave it — loadDate's corrupt fallback covers unreadable files */ }
    }
    throw new Error(
      `parquet verification failed for ${klDateStr}: wrote ${rowCount} rows, read back ${readBack} — JSONL retained, bad file moved to ${path.basename(badPath)}`
    );
  }
  fs.unlinkSync(jsonlPath);

  const { size: size_bytes } = fs.statSync(outPath);
  return { rows: rowCount, size_bytes };
}

module.exports = { convertDayToParquet };
