// On-disk augmentation of `data/<YYYY-MM-DD>.jsonl` — port of Python
// busapp/history.py:snap_augment_parquet, with the same field semantics:
//
//   adj_lat / adj_lon  — cleaned position (raw when within 2 km of typical;
//                        cross-day-median substitution when farther; NaN
//                        when no typical position is available)
//   snap_shape_id      — GTFS shape_id that adj_lat/adj_lon projects onto
//                        (the bus's assigned route's polyline; not cross-
//                        route fallback for known routes — same trust model
//                        as Python)
//   snap_cumdist       — arc-length (m) along that shape from polyline start
//
// Atomic write: temp file + rename, so an interrupted augmentation can't
// corrupt the source JSONL. Skips today's file (live pipeline is still
// writing to it) and any file already carrying snap columns.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { normalizeRow } = require("./store");

const DATA_DIR = path.join(__dirname, "data");

// Strip the legacy field aliases (`t`, `speed_raw`, `speed_calc`, `speed_trust`)
// after normalization so the rewritten JSONL is purely current schema. Idempotent
// — a row already in the new schema keeps every key it had.
function stripLegacyKeys(row) {
  delete row.t;
  delete row.speed_raw;
  delete row.speed_calc;
  delete row.speed_trust;
  return row;
}

// Early-exit guard: if the first non-empty row already has adj/snap columns,
// the file has been augmented before and there's nothing new to do. Mirrors
// Python's `if "adj_lat" in df.columns and "snap_shape_id" in df.columns`.
async function isAlreadyAugmented(file) {
  if (!fs.existsSync(file)) return false;
  return await new Promise((resolve, reject) => {
    let answered = false;
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (answered || !line) return;
      try {
        const row = JSON.parse(line);
        answered = true;
        rl.close();
        resolve(row.adj_lat !== undefined && row.snap_shape_id !== undefined);
      } catch {
        /* skip malformed line, keep scanning */
      }
    });
    rl.on("close", () => {
      if (!answered) resolve(false);
    });
    rl.on("error", (err) => reject(err));
  });
}

// Augment a single `data/<date>.jsonl` file. `model` is the cross-day
// position model (from cross-day.js / maintenance-pass.js); `snapper` is the
// initialized snapper (server.js builds + reloads it); `shapesByRoute` is
// gtfs.shapesByRoute; `inferredByBus` is `{bus_id: shape_id}` for unknown-
// route buses whose positions matched a known shape closely (computed by
// the caller, may be empty).
//
// Returns `{rows, augmented_rows}` where `augmented_rows` is the count that
// actually got new columns (vs. rows where typical+route lookup yielded
// nothing useful).
async function augmentJsonlFile(date, model, snapper, shapesByRoute, inferredByBus = {}) {
  const file = path.join(DATA_DIR, `${date}.jsonl`);
  if (!fs.existsSync(file)) return { rows: 0, augmented_rows: 0, skipped: true };
  if (await isAlreadyAugmented(file)) {
    return { rows: 0, augmented_rows: 0, skipped: true };
  }

  // Read the whole file first so we can sort by (bus_id, time) for per-bus
  // shape-variant stickiness. Files top out at ~20 MB on the busiest days;
  // an in-memory sort is fine and matches Python's approach.
  const rows = [];
  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (!line) return;
      try {
        // Normalize legacy field names on read so the rewrite is uniformly
        // current schema. Strip the aliases so we don't write both copies.
        rows.push(stripLegacyKeys(normalizeRow(JSON.parse(line))));
      } catch {
        /* tolerate partial last line */
      }
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });

  rows.sort((a, b) => {
    if (a.bus_id !== b.bus_id) return String(a.bus_id).localeCompare(String(b.bus_id));
    return a.time - b.time;
  });

  // Per-bus previous-shape tracker so snapPoint can apply Pass-18 stickiness.
  const prevShapeByBus = new Map();
  // Cross-day haversine for the 2 km deviation test.
  const EARTH_R_KM = 6371.0088;
  const toRad = (x) => (x * Math.PI) / 180;
  function haversineKm(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R_KM * Math.asin(Math.sqrt(a));
  }
  // Half-hour bucket in KL time. Same convention as cross-day.js / Python.
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

  const DEVIATION_THRESHOLD_M = 2000; // 2 km — beyond this, raw is replaced.

  let augmentedRows = 0;
  const tmp = file + ".tmp";
  const out = fs.createWriteStream(tmp, { flags: "w" });

  for (const row of rows) {
    const augmented = { ...row };
    const route = row.route;
    const knownRoute = route && route !== "Unknown";
    const bucket = bucketOf(row.time);

    // adj_lat / adj_lon: prefer raw when within 2 km of typical, otherwise
    // substitute typical. When no typical exists at all, fall through to
    // raw (Python "case 3" — leave NaN; we use raw here because JSONL has
    // no NaN distinct from missing, and the renderer already drops rows
    // with null lat/lon).
    let adjLat = row.lat;
    let adjLon = row.lon;
    if (model && knownRoute) {
      const tier =
        model.byBusRouteBucket.get(`${row.bus_id}|${route}|${bucket}`) ||
        model.byRouteBucket.get(`${route}|${bucket}`);
      if (tier && tier.lat != null && tier.lon != null) {
        if (row.lat != null && row.lon != null) {
          const distKm = haversineKm(row.lat, row.lon, tier.lat, tier.lon);
          if (distKm * 1000 > DEVIATION_THRESHOLD_M) {
            adjLat = tier.lat;
            adjLon = tier.lon;
          }
        } else {
          adjLat = tier.lat;
          adjLon = tier.lon;
        }
      }
    }
    augmented.adj_lat = adjLat;
    augmented.adj_lon = adjLon;

    // snap_shape_id / snap_cumdist: project the adj position onto the bus's
    // assigned route. For unknown-route buses, fall back to the inferred
    // shape (one per bus, when available). Cross-route fallback is NOT
    // applied here — Python only does that for unknown routes too.
    let candidateSids = null;
    if (knownRoute) {
      candidateSids = shapesByRoute[route] || null;
    } else if (inferredByBus[row.bus_id]) {
      candidateSids = [inferredByBus[row.bus_id]];
    }
    if (candidateSids && candidateSids.length > 0 && adjLat != null && adjLon != null) {
      const prev = prevShapeByBus.get(row.bus_id) || null;
      const snap = snapper.snapPoint(adjLat, adjLon, candidateSids, prev);
      if (snap) {
        augmented.snap_shape_id = snap.shape_id;
        augmented.snap_cumdist = snap.cumdist;
        prevShapeByBus.set(row.bus_id, snap.shape_id);
        augmentedRows += 1;
      } else {
        augmented.snap_shape_id = null;
        augmented.snap_cumdist = null;
      }
    } else {
      augmented.snap_shape_id = null;
      augmented.snap_cumdist = null;
    }

    out.write(JSON.stringify(augmented) + "\n");
  }

  await new Promise((resolve) => out.end(resolve));
  fs.renameSync(tmp, file);
  return { rows: rows.length, augmented_rows: augmentedRows, skipped: false };
}

module.exports = {
  augmentJsonlFile,
  isAlreadyAugmented,
};
