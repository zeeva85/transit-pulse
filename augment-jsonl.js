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
const { adjustRow } = require("./cross-day");

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

  let augmentedRows = 0;
  const tmp = file + ".tmp";
  const out = fs.createWriteStream(tmp, { flags: "w" });

  for (const row of rows) {
    const augmented = { ...row };
    const route = row.route;
    const knownRoute = route && route !== "Unknown";

    // adj_lat / adj_lon: delegate to cross-day.js:adjustRow which handles all
    // 3 lookup tiers (including Tier 3 byBusBucket for unknown-route buses)
    // and fractional bucket interpolation. Returns null when no typical
    // position exists (case 3) — fall through to raw in that case.
    let adjLat = row.lat;
    let adjLon = row.lon;
    if (model) {
      const adj = adjustRow(model, row);
      if (adj) {
        adjLat = adj.lat;
        adjLon = adj.lon;
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
