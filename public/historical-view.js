// Historical map view modes — port of busapp/ui/historical.py density layer.
// Exposes:
//   busHistoricalView.TIME_PERIODS              — period definitions (matches Python)
//   busHistoricalView.filterByPeriod(positions, period)
//   busHistoricalView.computeCountThresholds(positions, nBuckets)
//   busHistoricalView.buildDensityCells(positions, palette, thresholds)
//   busHistoricalView.PALETTES                  — speed / density / compare-A / compare-B
//   busHistoricalView.flattenTrails(buses)      — extract all positions from /api/buses
// All rendering of the resulting cells happens in main.js via deck.PolygonLayer.

(function () {
  // Hour bucketing must use Kuala Lumpur time regardless of the user's
  // browser timezone, otherwise period filters slice the wrong hours when
  // viewing from a different region.
  const KL_HOUR_FMT = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kuala_Lumpur",
    hour: "numeric",
    hourCycle: "h23",
  });
  const KL_MINUTE_FMT = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kuala_Lumpur",
    minute: "2-digit",
  });
  function klHour(tMs) {
    return parseInt(KL_HOUR_FMT.format(new Date(tMs)), 10) % 24;
  }
  function klMinute(tMs) {
    return parseInt(KL_MINUTE_FMT.format(new Date(tMs)), 10);
  }

  // 8 periods + the "All" sentinel handled in main.js. Hours match Python
  // exactly (fractional hours supported for half-hour bounds like 16.5).
  const TIME_PERIODS = [
    { key: "pre_rush", name: "Pre-Rush", hours: [5, 7], range_label: "5:00 AM - 7:00 AM" },
    { key: "morning_peak", name: "AM Peak", hours: [7, 10], range_label: "7:00 AM - 10:00 AM" },
    { key: "midday", name: "Midday", hours: [10, 12], range_label: "10:00 AM - 12:00 PM" },
    { key: "lunch_surge", name: "Lunch", hours: [12, 14], range_label: "12:00 PM - 2:00 PM" },
    { key: "afternoon_calm", name: "Afternoon", hours: [14, 16.5], range_label: "2:00 PM - 4:30 PM" },
    { key: "evening_peak", name: "PM Peak", hours: [16.5, 20], range_label: "4:30 PM - 8:00 PM" },
    { key: "post_peak", name: "Post-Peak", hours: [20, 22], range_label: "8:00 PM - 10:00 PM" },
    { key: "late_night", name: "Late Night", hours: [22, 26], range_label: "10:00 PM - 2:00 AM", special: "wrap" },
  ];
  const TIME_PERIODS_BY_KEY = Object.fromEntries(TIME_PERIODS.map((p) => [p.key, p]));

  // Palettes lifted verbatim from busapp/ui/historical.py.
  const PALETTES = {
    // Locked Speed (Traffic) palette — must not be modified without explicit
    // user approval. Matches HEX_PALETTE_SPEED in the Python source.
    speed: [
      [255, 0, 0, 180],     // red       — slow
      [255, 165, 0, 180],   // orange
      [255, 255, 0, 180],   // yellow
      [144, 238, 144, 180], // light green
      [0, 255, 0, 180],     // green
      [0, 128, 0, 180],     // dark green — fast
    ],
    density: [
      [0, 220, 0, 220],
      [170, 240, 30, 235],
      [255, 230, 0, 245],
      [255, 150, 0, 250],
      [255, 70, 20, 253],
      [200, 0, 0, 255],
    ],
    compareA: [
      [255, 50, 50, 180],
      [255, 30, 30, 173],
      [255, 20, 20, 167],
      [255, 10, 10, 160],
      [255, 0, 0, 153],
    ],
    compareB: [
      [50, 230, 50, 180],
      [30, 240, 30, 173],
      [20, 250, 20, 167],
      [10, 255, 10, 160],
      [0, 255, 0, 153],
    ],
  };

  // ────────────────────────────────────────────────────────────────────
  // Flatten /api/buses response into a positions array — each row has
  // { bus_id, route, lat, lon, hour, frac_hour } so the rest of the
  // module can stay pandas-equivalent.
  // ────────────────────────────────────────────────────────────────────

  // Field names match the Python-matching schema produced by /api/buses
  // (and ultimately by store.js:appendTick). `time` is ms-epoch, `speed`
  // is the raw GTFS-RT value, `calculated_speed` / `weighted_speed` mirror
  // the Python parquet column names.
  function flattenTrails(buses) {
    const out = [];
    for (const b of buses) {
      const trail = b.trail || [];
      for (const p of trail) {
        if (p.lat == null || p.lon == null) continue;
        const hour = klHour(p.time);
        const frac = hour + klMinute(p.time) / 60;
        out.push({
          bus_id: b.bus_id,
          route: b.route,
          lat: p.lat,
          lon: p.lon,
          hour,
          frac_hour: frac,
          time: p.time,
          speed: p.speed,
          speed_corrected: p.speed_corrected ?? null,
          calculated_speed: p.calculated_speed,
          speed_kalman: p.speed_kalman,
          weighted_speed: p.weighted_speed,
        });
      }
    }
    return out;
  }

  // Mirrors Python _filter_by_period. Wrap periods (Late Night 22→26) split
  // around midnight.
  function filterByPeriod(positions, period) {
    if (!period) return positions;
    const [start, end] = period.hours;
    if (period.special === "wrap") {
      return positions.filter((p) => p.hour >= Math.floor(start) || p.hour < Math.floor(end) - 24);
    }
    return positions.filter((p) => p.frac_hour >= start && p.frac_hour < end);
  }

  function filterByHourRange(positions, hourMin, hourMax) {
    return positions.filter((p) => p.frac_hour >= hourMin && p.frac_hour <= hourMax);
  }

  // Grid-based spatial sample — mirrors busapp/geo.spatial_sample.
  // Caps the number of positions per ~grid_size_m × grid_size_m cell so dense
  // areas don't dominate the HexagonLayer's aggregation cost. Python applies
  // this in `_render_density_layer` only on the Speed (Traffic) branch (the
  // density PolygonLayer must NEVER be sampled — sampling caps per-cell counts
  // and biases coloring; HexagonLayer aggregates internally and is fine).
  function spatialSample(positions, maxPoints = 3000, gridSizeM = 100) {
    if (positions.length <= maxPoints) return positions;
    const step = gridSizeM / 111000;
    const buckets = new Map();
    for (const p of positions) {
      const key = `${Math.round(p.lat / step)}|${Math.round(p.lon / step)}`;
      const arr = buckets.get(key) || [];
      arr.push(p);
      buckets.set(key, arr);
    }
    // Decide a per-bucket cap such that totalKept ≈ maxPoints.
    const totalBuckets = buckets.size;
    const perBucket = Math.max(1, Math.ceil(maxPoints / totalBuckets));
    const out = [];
    for (const arr of buckets.values()) {
      if (arr.length <= perBucket) {
        for (const p of arr) out.push(p);
      } else {
        const stride = arr.length / perBucket;
        for (let i = 0; i < perBucket; i++) out.push(arr[Math.floor(i * stride)]);
      }
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────────────
  // Density grid binning
  // ────────────────────────────────────────────────────────────────────

  // Bucket positions to ~200m square cells. Each cell's value is the count
  // of **distinct buses** that visited it (Pass-24 metric), not raw pings.
  function binToGrid(positions, gridSizeM = 200) {
    const step = gridSizeM / 111000;
    const cells = new Map(); // "lat|lon" -> Set<bus_id>
    for (const p of positions) {
      const latBin = Math.round(p.lat / step);
      const lonBin = Math.round(p.lon / step);
      const key = `${latBin}|${lonBin}`;
      let buses = cells.get(key);
      if (!buses) {
        buses = new Set();
        cells.set(key, buses);
      }
      buses.add(p.bus_id);
    }
    const rows = [];
    for (const [key, buses] of cells) {
      const [latBin, lonBin] = key.split("|").map(Number);
      rows.push({ latBin, lonBin, count: buses.size });
    }
    return { rows, step };
  }

  function quantile(sorted, q) {
    if (sorted.length === 0) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // Compute absolute thresholds from the full-day distribution of
  // distinct-bus counts per cell. Returns nBuckets-1 cut points; cap the
  // top quantile at 0.95 so a few hyper-busy cells don't push the top
  // threshold so high that nothing reaches it.
  function computeCountThresholds(positions, nBuckets, gridSizeM = 200) {
    if (!positions.length || nBuckets < 2) return [];
    const { rows } = binToGrid(positions, gridSizeM);
    if (rows.length === 0) return [];
    const counts = rows.map((r) => r.count).sort((a, b) => a - b);
    const cuts = [];
    for (let i = 0; i < nBuckets - 1; i++) {
      let q = (i + 1) / nBuckets;
      if (i === nBuckets - 2) q = Math.min(q, 0.95);
      cuts.push(q);
    }
    const thresholds = cuts.map((q) => Math.max(Math.round(quantile(counts, q)), 1));
    // Force strictly increasing so dead buckets don't appear when most cells
    // share the same count.
    for (let i = 1; i < thresholds.length; i++) {
      if (thresholds[i] <= thresholds[i - 1]) thresholds[i] = thresholds[i - 1] + 1;
    }
    return thresholds;
  }

  // Build PolygonLayer-ready rows from positions. When `thresholds` is
  // given, absolute coloring is used (same count → same color across views);
  // otherwise a rank-based fallback colors cells by their position in the
  // sorted unique-count list (guarantees gradient visibility per frame).
  function buildDensityCells(positions, palette, thresholds, gridSizeM = 200) {
    if (positions.length === 0) return [];
    const { rows, step } = binToGrid(positions, gridSizeM);
    if (rows.length === 0) return [];
    const nStops = palette.length;

    function rankColors() {
      const unique = [...new Set(rows.map((r) => r.count))].sort((a, b) => a - b);
      if (unique.length === 1) {
        const top = palette[nStops - 1];
        return rows.map(() => top);
      }
      const lookup = new Map();
      for (let i = 0; i < unique.length; i++) {
        const idx = Math.min(Math.floor((i / (unique.length - 1)) * nStops), nStops - 1);
        lookup.set(unique[i], palette[idx]);
      }
      return rows.map((r) => lookup.get(r.count));
    }

    function thresholdColors() {
      return rows.map((r) => {
        for (let i = 0; i < thresholds.length; i++) {
          if (r.count <= thresholds[i]) return palette[i];
        }
        return palette[nStops - 1];
      });
    }

    const colors = thresholds && thresholds.length ? thresholdColors() : rankColors();
    const half = step / 2;
    return rows.map((r, i) => {
      const lat = r.latBin * step;
      const lon = r.lonBin * step;
      return {
        polygon: [
          [lon - half, lat - half],
          [lon + half, lat - half],
          [lon + half, lat + half],
          [lon - half, lat + half],
        ],
        color: colors[i],
        count: r.count,
      };
    });
  }

  window.busHistoricalView = {
    TIME_PERIODS,
    TIME_PERIODS_BY_KEY,
    PALETTES,
    flattenTrails,
    filterByPeriod,
    filterByHourRange,
    spatialSample,
    computeCountThresholds,
    buildDensityCells,
  };
})();
