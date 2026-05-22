// Frontend: poll /api/buses, render trails + dots + route polylines on
// deck.gl over maplibre-gl. Mirrors the Python live-map view.

const KL_CENTER = APP_CONFIG.KL_CENTER;

// Module-level KL time formatter — reused across trail rendering and period
// filtering to avoid allocating a new Intl.DateTimeFormat per bus per frame.
const _KL_HHMM_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kuala_Lumpur",
  hour: "numeric",
  hourCycle: "h23",
  minute: "2-digit",
});
function klHourFractional(tMs) {
  const parts = _KL_HHMM_FMT.formatToParts(new Date(tMs));
  const hh = parseInt(parts.find((p) => p.type === "hour").value, 10);
  const mm = parseInt(parts.find((p) => p.type === "minute").value, 10);
  return hh + mm / 60;
}

// Apply CSS custom properties from config so style.css can reference them
document.documentElement.style.setProperty("--dim-deck-opacity", APP_CONFIG.DIM_DECK_OPACITY);

// Match Streamlit's map style selector — same 4 options. The satellite tile
// URL needs a MapTiler API key; the server reads `MAPTILER_KEY` from the
// environment and rewrites the placeholder. If the env var is missing, the
// well-known MapTiler demo placeholder is left in (will rate-limit fast).
const MAP_STYLES = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  road: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  // Patched by `/api/config` on startup. Default is the public placeholder
  // every MapTiler example uses — fine for local hacking, throttled at scale.
  satellite:
    "https://api.maptiler.com/maps/hybrid/style.json?key=get_your_own_OpIi9ZULNHzrESv6T2vL",
};

let mapStyle = "dark";
let map = null;
let deckOverlay = null;
let appSetBearing = false; // true when fitBoundsOptimal set a non-zero bearing
let cachedZoom = KL_CENTER.zoom;
let staticLayers = [];   // layers built by rebuildLayers, pulse appended on top
let pulsePhase = 0;
let pulseRafId = null;

const DIM_SOURCE = "map-dim-overlay";
const DIM_LAYER  = "map-dim-overlay-fill";
function setMapDim(on) {
  document.body.classList.toggle("map-dimmed", on);
  if (!map) return;
  if (on) {
    if (map.getSource(DIM_SOURCE)) return;
    map.addSource(DIM_SOURCE, {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "Polygon",
        coordinates: [[[-180,-90],[180,-90],[180,90],[-180,90],[-180,-90]]] } },
    });
    map.addLayer({
      id: DIM_LAYER, type: "fill", source: DIM_SOURCE,
      paint: { "fill-color": "#000000", "fill-opacity": APP_CONFIG.DIM_FILL_OPACITY },
    });
  } else {
    if (map.getLayer(DIM_LAYER))  map.removeLayer(DIM_LAYER);
    if (map.getSource(DIM_SOURCE)) map.removeSource(DIM_SOURCE);
  }
}

function matchTableToMap() {
  const tableSection = document.getElementById("table-section");
  if (!tableSection) return;
  if (!document.body.classList.contains("historical")) {
    tableSection.style.height = "";
    return;
  }
  requestAnimationFrame(() => {
    const mapSection = document.getElementById("map-section");
    if (!mapSection) return;
    const mapBottom = mapSection.getBoundingClientRect().bottom;
    const tableTop = tableSection.getBoundingClientRect().top;
    tableSection.style.height = Math.max(mapBottom - tableTop, 200) + "px";
  });
}
window.addEventListener("resize", matchTableToMap);

let maptilerKey = null;

// Fetch server config (MapTiler key etc.) once at boot so the satellite tile
// URL gets the right key before maplibre actually requests tiles.
async function loadServerConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.maptiler_key) {
      maptilerKey = cfg.maptiler_key;
      MAP_STYLES.satellite = `https://api.maptiler.com/maps/hybrid/style.json?key=${encodeURIComponent(maptilerKey)}`;
    }
  } catch {
    /* config is optional — fall through with defaults */
  }
}

// Resolve a place-name string to { lat, lon, displayName }.
// If the input already looks like "lat, lon" coordinates it's returned as-is (no fetch).
// Uses MapTiler when MAPTILER_KEY is available, falls back to Nominatim otherwise.
// Throws a descriptive Error if the query resolves to nothing.
async function geocode(query) {
  const coordRe = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
  const m = coordRe.exec(query);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), displayName: query.trim() };

  if (maptilerKey) {
    const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json` +
      `?key=${encodeURIComponent(maptilerKey)}&bbox=${APP_CONFIG.GEOCODE_BBOX}&limit=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Geocoding request failed (${res.status})`);
    const data = await res.json();
    if (!data.features || data.features.length === 0) throw new Error(`No results for "${query}"`);
    const [lon, lat] = data.features[0].geometry.coordinates;
    return { lat, lon, displayName: data.features[0].place_name || query };
  }

  // Nominatim fallback (no key required)
  const [minLon, minLat, maxLon, maxLat] = APP_CONFIG.GEOCODE_BBOX.split(",");
  const url = `https://nominatim.openstreetmap.org/search` +
    `?q=${encodeURIComponent(query)}&countrycodes=my&format=json&limit=1` +
    `&viewbox=${minLon},${maxLat},${maxLon},${minLat}&bounded=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  if (!res.ok) throw new Error(`Geocoding request failed (${res.status})`);
  const data = await res.json();
  if (!data.length) throw new Error(`No results for "${query}"`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), displayName: data[0].display_name };
}

(async () => {
  await loadServerConfig();
  map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLES[mapStyle],
    center: [KL_CENTER.lon, KL_CENTER.lat],
    zoom: KL_CENTER.zoom,
    minZoom: APP_CONFIG.MAP_MIN_ZOOM,
    maxZoom: APP_CONFIG.MAP_MAX_ZOOM,
    scrollZoom: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl({
    onAdd(m) {
      const div = document.createElement("div");
      div.className = "maplibregl-ctrl maplibregl-ctrl-group";
      const btn = document.createElement("button");
      btn.title = "Reset view";
      btn.style.cssText = "font-size:16px;line-height:1;color:#e6e6e6;font-weight:bold;";
      btn.textContent = "⌂";
      btn.addEventListener("click", () =>
        m.flyTo({ center: [KL_CENTER.lon, KL_CENTER.lat], zoom: KL_CENTER.zoom, duration: 600 })
      );
      div.appendChild(btn);
      return div;
    },
    onRemove() {},
  }, "bottom-right");
  map.on("load", () => {
    deckOverlay = new deck.MapboxOverlay({ layers: [] });
    map.addControl(deckOverlay);
    start();
  });
  let _zoomHandle = null;
  map.on("zoom", () => {
    cachedZoom = map.getZoom();
    clearTimeout(_zoomHandle);
    _zoomHandle = setTimeout(rebuildLayers, 60);
  });
})();

// ──────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────

const state = {
  buses: [],
  lastFetch: null,
  intervalSec: 30,
  trailMode: "all",       // none | all | selected
  trailColorBy: "speed",  // speed | time   (matches Python Trail Color By)
  colorBy: "speed",       // speed | status
  speedSource: "trust",   // trust | kalman | calc | raw
  showStationary: true,
  hideUnknown: false,
  selectedBus: null,
  pollHandle: null,
  // Clustering state
  clusterOn: false,
  clusterHoursOn: false,       // independent of clusterOn; reorders heatmap y-axis
  clusterMetric: "euclidean",  // euclidean | correlation
  clusterK: 6,
  clusterByRoute: {},          // route_label -> 1..K
  clusterOrder: [],            // route labels in dendrogram leaf order
  clustersSelected: new Set(), // 1..K filter; empty = "all selected"
  clusterHourOrder: null,      // [0..23] in clustered order, or null
  // Date mode — "today" means live polling; a YYYY-MM-DD string means
  // historical replay. Synced from the heatmap toolbar's date picker so the
  // map and heatmap always reflect the same day.
  date: "today",
  // Historical-view state machine — matches Python st.session_state keys.
  // Active only while `date` is a historical YYYY-MM-DD.
  timeFilter: "All",       // "All" | "TRAILS" | "OFF" | period_key | "compare"
  comparePeriods: [],      // 0–2 period keys, FIFO when exceeding 2
  hourRange: [0, 23],      // [min, max] for the All-Times scrubber
  densityThresholds: null, // cached per-(date) absolute count thresholds
  historicalView: "density", // "density" | "speed"
  // Route polyline overlay — fetched once per unique set of visible routes.
  routeShapes: {},   // shape_id -> [[lon, lat], …]
  routeOf: {},       // shape_id -> route_label
  _lastRouteFetchKey: "", // serialised sorted route list, guards redundant fetches
  autoSwitchedToHistorical: false,
  liveCheckHandle: null,
};

// ──────────────────────────────────────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────────────────────────────────────

async function fetchBuses() {
  // Pass the user's interval through so the server cache window tracks the
  // slider. Matches Python's max(interval, 30) cache_ttl recompute per rerun.
  const baseParams = new URLSearchParams();
  baseParams.set("interval", String(state.intervalSec));
  if (state.date && state.date !== "today") {
    baseParams.set("date", state.date);
  }
  const url = `/api/buses?${baseParams.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  let buses = data.buses;
  // Hide-unknown-routes filter — mirrors the Python sidebar checkbox.
  if (state.hideUnknown) buses = buses.filter((b) => b.route && b.route !== "Unknown");
  state.buses = buses;
  state.lastFetch = new Date(data.ts);
  document.getElementById("bus-count").textContent =
    state.buses.length.toLocaleString();
  document.getElementById("route-count").textContent = new Set(
    state.buses.map((b) => b.route)
  ).size;
  const mapDateLabel = document.getElementById("map-date-label");
  mapDateLabel.textContent = data.is_historical
    ? `(Viewing ${data.date})`
    : `(Updated ${state.lastFetch.toLocaleTimeString()})`;
  mapDateLabel.hidden = false;
  document.getElementById("header-date").textContent =
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kuala_Lumpur",
      day: "2-digit", month: "short", year: "numeric",
    }).format(state.lastFetch) + " KL";
}

// Fetch GTFS route polylines for all currently-visible buses whose route is
// known. Uses /api/shapes?routes=... so only the relevant shapes are returned.
// Skips the fetch when the set of visible routes hasn't changed since last call.
async function fetchShapeRouteIndex() {
  const knownRoutes = [
    ...new Set(
      state.buses
        .map((b) => b.route)
        .filter((r) => r && r !== "Unknown")
    ),
  ].sort();
  const key = knownRoutes.join(",");
  if (key === state._lastRouteFetchKey) return; // nothing new to fetch
  if (knownRoutes.length === 0) {
    state.routeShapes = {};
    state.routeOf = {};
    state._lastRouteFetchKey = key;
    return;
  }
  try {
    const res = await fetch(
      `/api/shapes?routes=${encodeURIComponent(knownRoutes.join(","))}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.routeShapes = data.shapes || {};
    state.routeOf = data.route_of || {};
    state._lastRouteFetchKey = key;
  } catch (err) {
    console.warn("fetchShapeRouteIndex failed", err);
  }
}

async function fetchClusters() {
  // The cluster endpoint is also the source of the clustered hour-of-day
  // order for the heatmap, so it gets fetched even when route clustering is
  // off but hour clustering is on.
  if (!state.clusterOn && !state.clusterHoursOn) return;
  try {
    // Pass the active heatmap anchor + the selected date through so the
    // cluster feature matrix is built from the same data the heatmap shows.
    // Python's compute_route_clusters takes a `source` dataframe — live or
    // historical — and honors settings.anchor_mode.
    const anchor = document.getElementById("heatmap-anchor")?.value || "physical";
    const params = new URLSearchParams({
      metric: state.clusterMetric,
      k: String(state.clusterK),
      anchor,
    });
    if (state.date && state.date !== "today") params.set("date", state.date);
    if (state.clusterHoursOn) params.set("hours", "1");
    const res = await fetch(`/api/clusters?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.clusterByRoute = data.cluster_by_route || {};
    state.clusterOrder = data.order || [];
    state.clusterHourOrder = state.clusterHoursOn
      ? (data.hour_order || null)
      : null;
    if (window.busHeatmap) {
      window.busHeatmap.setClusters(state.clusterByRoute, state.clusterOrder);
      window.busHeatmap.setHourOrder(state.clusterHourOrder);
    }
    // If selection is empty, treat as "all on". When K changes we reset.
    const allClusters = new Set(Object.values(state.clusterByRoute));
    for (const c of [...state.clustersSelected]) {
      if (!allClusters.has(c)) state.clustersSelected.delete(c);
    }
    rebuildClusterFilterUI();
    updateClusterStatus(data);
  } catch (err) {
    console.error("cluster fetch failed", err);
    updateClusterStatus(null, err.message);
  }
}

function rebuildClusterFilterUI() {
  const wrap = document.getElementById("cluster-filter");
  const chips = document.getElementById("cluster-filter-chips");
  if (!state.clusterOn || Object.keys(state.clusterByRoute).length === 0) {
    wrap.hidden = true;
    chips.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  // Cluster ids = 1..K, deduplicate from clusterByRoute values.
  const ids = [...new Set(Object.values(state.clusterByRoute))].sort((a, b) => a - b);
  const counts = {};
  for (const c of Object.values(state.clusterByRoute)) counts[c] = (counts[c] || 0) + 1;

  chips.innerHTML = "";
  for (const id of ids) {
    const on =
      state.clustersSelected.size === 0 || state.clustersSelected.has(id);
    const chip = document.createElement("span");
    chip.className = "cluster-chip " + (on ? "on" : "off");
    chip.title = `${counts[id]} route(s)`;
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = window.CLUSTER_PALETTE.clusterCssColor(id);
    chip.appendChild(sw);
    chip.appendChild(document.createTextNode(`#${id} (${counts[id]})`));
    chip.addEventListener("click", () => toggleClusterSelection(id));
    chips.appendChild(chip);
  }
}

function toggleClusterSelection(id) {
  const allIds = new Set(Object.values(state.clusterByRoute));
  if (state.clustersSelected.size === 0) {
    // Currently "all on" → first click means "only show this one"
    state.clustersSelected = new Set([id]);
  } else if (state.clustersSelected.has(id)) {
    state.clustersSelected.delete(id);
    // If we just deselected the last one, jump back to "all on"
    if (state.clustersSelected.size === 0) state.clustersSelected = new Set();
  } else {
    state.clustersSelected.add(id);
    // If user reselected everything, normalize back to "all on"
    if (state.clustersSelected.size === allIds.size) state.clustersSelected = new Set();
  }
  rebuildClusterFilterUI();
  rebuildLayers();
}

function updateClusterStatus(data, errMsg) {
  const el = document.getElementById("cluster-status");
  if (!state.clusterOn) {
    el.textContent = "off";
    return;
  }
  if (errMsg) {
    el.textContent = `error: ${errMsg}`;
    return;
  }
  if (!data || !data.routes || data.routes.length === 0) {
    el.textContent = "waiting for samples…";
    return;
  }
  el.textContent = `${data.k} clusters over ${data.routes.length} routes (${data.metric})`;
}

// ──────────────────────────────────────────────────────────────────────────
// Color logic — mirrors the Python `_speed_to_color` and live `bus_layer`.
// ──────────────────────────────────────────────────────────────────────────

// `bus.*` field names match the Python parquet schema (see store.js header
// comment). `state.speedSource` carries internal mode short-names mapped to
// schema columns: raw → `speed`, calc → `calculated_speed`, trust →
// `weighted_speed`, others pass through unchanged.
function effectiveSpeed(bus) {
  switch (state.speedSource) {
    case "raw":
      return bus.speed;
    case "corrected":
      return bus.speed_corrected != null ? bus.speed_corrected : bus.speed;
    case "calc":
      return bus.calculated_speed != null ? bus.calculated_speed : bus.speed;
    case "kalman":
      return bus.speed_kalman != null ? bus.speed_kalman : bus.speed;
    case "trust":
    default:
      return bus.weighted_speed != null ? bus.weighted_speed : bus.speed;
  }
}

// Per-bus-dot speed coloring. Byte-for-byte match with Python
// `_speed_to_color` in busapp/ui/historical.py:730-737 — RGBA with α=180.
// (This is NOT the locked HexagonLayer palette — that's `PALETTES.speed`
// in historical-view.js, unchanged.)
function speedColor(speed) {
  if (speed == null) return [128, 128, 128, 180];
  if (speed < 20) return [255, 0, 0, 180];
  if (speed < 40) return [255, 165, 0, 180];
  return [0, 255, 0, 180];
}

// Status-mode coloring. Pure RGB values match Python's live dot lambda
// (busapp/pipeline.py:154-159) — no softening / no alpha. The grey-stale
// short-circuit lives in busFillColor; this function is reached only when
// the bus is non-stale.
function statusColor(bus) {
  // Prefer the server's status field (computed with Python's
  // displacement-OR-speed rule). Fall back to speed-only for historical
  // replays which don't carry it.
  const speed = effectiveSpeed(bus);
  const moving =
    bus.status != null
      ? bus.status === "Moving"
      : speed != null && speed > 1;
  return moving ? [0, 255, 0] : [255, 0, 0];
}

function busFillColor(bus) {
  // Match Python busapp/pipeline.py:154-159 — stale rows (vehicle.timestamp
  // older than 90 s) render in grey regardless of mode. Python uses pure
  // [128, 128, 128] (3-val RGB) in live, so we match here too; deck.gl
  // defaults alpha to 255 when missing.
  if (bus.is_stale) return [128, 128, 128];
  if (state.colorBy === "status") return statusColor(bus);
  return speedColor(effectiveSpeed(bus));
}

// When the route-search filter is active, dim non-matching bus dots to near-
// invisible so the matching routes stand out on the map.
function busFillColorWithFilter(bus) {
  const q = window.busTable ? window.busTable.getFilterText() : "";
  if (q) {
    const match =
      (bus.route || "").toLowerCase().includes(q) ||
      (bus.bus_id || "").toLowerCase().includes(q);
    if (!match) return [90, 90, 90, 35];
  }
  return busFillColor(bus);
}

function busRadius(bus) {
  // Pixel radius scales with zoom so dots stay readable at any zoom level.
  // zoom 9 → ~5px, zoom 12 → ~8px, zoom 15 → ~12px, zoom 17 → ~15px
  const base = Math.round(Math.max(2, Math.min(15, (cachedZoom - 7) * 1.1)));
  if (state.selectedBus && bus.bus_id === state.selectedBus) return Math.round(base * 2);
  if (bus.is_stale) return Math.max(4, base - 1);
  if (bus.status === "Stationary") return base + 1;
  return base;
}

// ──────────────────────────────────────────────────────────────────────────
// Trail layer — one LineLayer with per-segment color + alpha fade by age.
// Same structure as the Python `build_trail_layer` output.
// ──────────────────────────────────────────────────────────────────────────

// Map a fractional hour (0–23.999) to an RGB color. Stops are byte-for-byte
// from busapp/ui/util.py:HOUR_PALETTE so a trail rendered at e.g. 22:00 is
// the same deep-red here as in the Python app (the previous JS stops had
// purple at 22, sky-blue variants at 7/10, and slightly muted navy at 0/4).
function hourToColor(h) {
  const stops = [
    [0, [10, 10, 80]],       // midnight: deep navy
    [4, [50, 50, 150]],      // 4 am:    indigo
    [7, [135, 206, 235]],    // 7 am:    pale sky blue
    [10, [180, 230, 200]],   // 10 am:   cyan-green
    [13, [255, 230, 100]],   // 1 pm:    yellow
    [16, [255, 165, 0]],     // 4 pm:    orange
    [19, [240, 80, 50]],     // 7 pm:    red-orange
    [22, [200, 30, 50]],     // 10 pm:   deep red
    [24, [10, 10, 80]],      // midnight wrap
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [h1, c1] = stops[i];
    const [h2, c2] = stops[i + 1];
    if (h >= h1 && h <= h2) {
      const t = (h - h1) / (h2 - h1);
      return [
        Math.round(c1[0] + (c2[0] - c1[0]) * t),
        Math.round(c1[1] + (c2[1] - c1[1]) * t),
        Math.round(c1[2] + (c2[2] - c1[2]) * t),
      ];
    }
  }
  return [128, 128, 128];
}

// Returns PathLayer-ready rows when snapped_trail is present (curved paths
// along GTFS shape polylines), else falls back to one LineLayer-style row
// per consecutive position pair (straight chords). The colour-by-segment
// logic is identical in both paths so visually only the geometry changes.
function buildTrailRows(buses, trailModeOverride = null, periodHours = null) {
  const mode = trailModeOverride || state.trailMode;
  if (mode === "none") return { paths: [], segments: [] };

  let visibleBuses = buses;
  if (mode === "selected") {
    if (!state.selectedBus) return { paths: [], segments: [] };
    const selBus = buses.find((b) => b.bus_id === state.selectedBus);
    const selRoute = selBus && selBus.route && selBus.route !== "Unknown" ? selBus.route : null;
    visibleBuses = selRoute
      ? buses.filter((b) => b.route === selRoute)
      : buses.filter((b) => b.bus_id === state.selectedBus);
  }

  const clusterTrailMode = isClusterTrailMode();

  // Period filter — skip trail segments outside the active period's hour range.
  // Late Night wraps: hours [22, 26] means ≥ 22:00 OR < 02:00.
  let inPeriod = null;
  if (periodHours) {
    const [hStart, hEnd] = periodHours;
    inPeriod = (tMs) => {
      if (tMs == null) return false;
      const frac = klHourFractional(tMs);
      if (hEnd > 24) return frac >= hStart || frac < (hEnd - 24);
      return frac >= hStart && frac < hEnd;
    };
  }

  const paths = [];
  const segments = []; // fallback for buses without snapped_trail (live, no shape)

  for (const bus of visibleBuses) {
    const trail = bus.trail || [];
    if (trail.length < 2) continue;
    const snapped = bus.snapped_trail || null;
    const last = trail.length - 1;

    // Cluster-trail override: every segment of this bus uses its route's
    // cluster color. Mirrors the `force_color` path in Python
    // paths_from_snap_paths.
    let clusterColor = null;
    if (clusterTrailMode) {
      const cid = state.clusterByRoute[bus.route];
      if (cid != null) clusterColor = window.CLUSTER_PALETTE.clusterColor(cid);
    }

    // Match Python:
    //  - Live view + Time (Fade): comet alpha-fade by recency (no hour hue).
    //  - Historical view + Time (Fade): hue from hour-of-day (KL time).
    //  - Speed (Traffic): same red/orange/green as Python `_speed_to_color`
    //    in both views.
    const historical = isHistoricalDate();

    function segColor(p1, p2, i) {
      if (clusterColor) return clusterColor;
      let base, alpha;
      if (state.trailColorBy === "time") {
        if (historical) {
          base = hourToColor(klHourFractional(p1.time));
          alpha = 200;
        } else {
          // Live: Python uses pure alpha-fade-by-recency (no hour hue) — see
          // busapp/ui/trails.py:_segment_color. Match the comet semantics.
          base = [100, 100, 255];
          alpha = Math.round(50 + ((i + 1) / Math.max(last, 1)) * 205);
        }
      } else {
        const segSpeed = p2 ? effectiveSpeedFromTrail(null, p2) : null;
        base = speedColor(segSpeed);
        alpha = Math.round(40 + ((i + 1) / last) * 215);
      }
      return [base[0], base[1], base[2], alpha];
    }

    // Bucketed colour for PathLayer consolidation (historical only).
    // Mirrors busapp/ui/trails.py:_bucketed_color — Time mode buckets to
    // integer hour (24 distinct hues), Speed mode to the 3-bucket
    // red/orange/green palette. Returns null in live mode so each segment
    // keeps its per-pair alpha (LineLayer comet, no consolidation possible).
    function bucketedColor(p1, p2) {
      if (clusterColor) return clusterColor;
      if (!historical) return null;
      if (state.trailColorBy === "time") {
        const hh = Math.floor(klHourFractional(p1.time)) % 24;
        return [...hourToColor(hh), 200];
      }
      // Speed: respect the active Speed Display Mode (trust/kalman/corrected/
      // raw/calc) — same 3-bucket palette as Python's _bucketed_color.
      const s1 = effectiveSpeedFromTrail(null, p1);
      const s2 = p2 ? effectiveSpeedFromTrail(null, p2) : null;
      const vals = [s1, s2].filter((v) => v != null && Number.isFinite(v));
      if (vals.length === 0) return [128, 128, 128, 180];
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      if (avg < 20) return [255, 0, 0, 180];
      if (avg < 40) return [255, 165, 0, 180];
      return [0, 255, 0, 180];
    }

    if (snapped && snapped.length > 0) {
      if (historical) {
        // Consolidate consecutive same-bucket snapped sub-paths into single
        // multi-vertex PathLayer rows. Matches Python paths_from_snap_paths.
        // Endpoint alignment is checked via the shared vertex equality test
        // (Python relies on its slice_polyline outputs being numerically
        // identical at shape boundaries; same property holds here).
        let currentPath = null;
        let currentColor = null;
        const flush = () => {
          if (currentPath && currentPath.length >= 2) {
            paths.push({
              path: currentPath,
              color: currentColor,
              bus_id: bus.bus_id,
            });
          }
          currentPath = null;
          currentColor = null;
        };
        for (let i = 0; i < snapped.length; i++) {
          const s = snapped[i];
          if (!s.path || s.path.length < 2) {
            flush();
            continue;
          }
          if (inPeriod && !inPeriod(trail[i].time)) {
            flush();
            continue;
          }
          const color = bucketedColor(trail[i], trail[i + 1]);
          const matches =
            currentPath &&
            currentColor &&
            color[0] === currentColor[0] &&
            color[1] === currentColor[1] &&
            color[2] === currentColor[2] &&
            color[3] === currentColor[3] &&
            currentPath[currentPath.length - 1][0] === s.path[0][0] &&
            currentPath[currentPath.length - 1][1] === s.path[0][1];
          if (matches) {
            for (let k = 1; k < s.path.length; k++) currentPath.push(s.path[k]);
          } else {
            flush();
            currentPath = s.path.slice();
            currentColor = color;
          }
        }
        flush();
      } else {
        // Live: per-segment alpha → no consolidation, one path per pair.
        for (let i = 0; i < snapped.length; i++) {
          const s = snapped[i];
          if (!s.path || s.path.length < 2) continue;
          paths.push({
            path: s.path,
            color: segColor(trail[i], trail[i + 1], i),
            bus_id: bus.bus_id,
          });
        }
      }
    } else {
      // No snap — fall back to straight chord segments.
      for (let i = 0; i < last; i++) {
        const p1 = trail[i];
        const p2 = trail[i + 1];
        if (inPeriod && !inPeriod(p1.time)) continue;
        segments.push({
          from: [p1.lon, p1.lat],
          to: [p2.lon, p2.lat],
          color: segColor(p1, p2, i),
          bus_id: bus.bus_id,
        });
      }
    }
  }
  return { paths, segments };
}

// ──────────────────────────────────────────────────────────────────────────
// Layer assembly
// ──────────────────────────────────────────────────────────────────────────

function busPassesClusterFilter(bus) {
  if (!state.clusterOn || state.clustersSelected.size === 0) return true;
  const cid = state.clusterByRoute[bus.route];
  return cid != null && state.clustersSelected.has(cid);
}

// Cluster-trail mode: when clustering is on in historical view, Python
// forces time_filter = OFF and renders trails colored by each route's
// cluster. Mirrors busapp/ui/historical.py Pass 29.
function isClusterTrailMode() {
  return state.clusterOn && isHistoricalDate();
}

// ──────────────────────────────────────────────────────────────────────────
// Historical view UI (period buttons + hour-range slider)
// ──────────────────────────────────────────────────────────────────────────

function isHistoricalDate() {
  return state.date && state.date !== "today";
}

function renderHistoricalControls() {
  const wrap = document.getElementById("historical-controls");
  if (!isHistoricalDate()) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const btnRow      = document.getElementById("period-buttons");
  const stateRow    = document.getElementById("view-state-buttons");
  btnRow.innerHTML  = "";
  stateRow.innerHTML = "";

  const makeBtn = (key, name, isActive, special, container) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "period-btn" + (isActive ? " active" : "") + (special ? " special" : "");
    b.textContent = name;
    b.dataset.key = key;
    b.addEventListener("click", () => onPeriodClick(key));
    container.appendChild(b);
  };

  // All Times / Trails Only / OFF go in the top-right corner of the view row.
  makeBtn("All",    "All Times",   state.timeFilter === "All",    false, stateRow);
  makeBtn("TRAILS", "Trails Only", state.timeFilter === "TRAILS", false, stateRow);
  makeBtn("OFF",    "OFF",         state.timeFilter === "OFF",    false, stateRow);

  // Time-period buttons stay in their own row below.
  for (const p of window.busHistoricalView.TIME_PERIODS) {
    const active =
      state.comparePeriods.includes(p.key) ||
      state.timeFilter === p.key;
    makeBtn(p.key, p.name, active, p.special === "wrap", btnRow);
  }

  document.getElementById("hour-range-row").hidden = state.timeFilter !== "All";
  document.getElementById("hour-min").value = state.hourRange[0];
  document.getElementById("hour-max").value = state.hourRange[1];
  document.getElementById("hour-min-label").textContent =
    String(state.hourRange[0]).padStart(2, "0");
  document.getElementById("hour-max-label").textContent =
    String(state.hourRange[1]).padStart(2, "0");

  // Caption — describes what the active view is showing + colour legend.
  const cap = document.getElementById("historical-caption");
  const tf = state.timeFilter;
  let mainText = "";
  if (tf === "TRAILS") {
    mainText = "🛤️ Trails only — position dots hidden";
  } else if (tf === "OFF") {
    mainText = "⏹️ Map off";
  } else if (tf === "compare") {
    const [a, b] = state.comparePeriods;
    mainText = `🔀 Compare: 🔴 ${
      window.busHistoricalView.TIME_PERIODS_BY_KEY[a].name
    }  vs  🟢 ${window.busHistoricalView.TIME_PERIODS_BY_KEY[b].name}`;
  } else if (tf === "All") {
    mainText = `🌐 All Times · hour range ${state.hourRange[0]}:00 – ${state.hourRange[1]}:00`;
  } else if (window.busHistoricalView.TIME_PERIODS_BY_KEY[tf]) {
    const p = window.busHistoricalView.TIME_PERIODS_BY_KEY[tf];
    mainText = `📊 ${p.name} (${p.range_label})`;
  }

  cap.textContent = mainText;
}

// Period button click: maintains the {timeFilter, comparePeriods} state
// machine identical to Python's _render_time_filter_buttons.
function onPeriodClick(key) {
  const TP = window.busHistoricalView.TIME_PERIODS_BY_KEY;
  if (key === "All" || key === "TRAILS" || key === "OFF") {
    state.timeFilter = key;
    state.comparePeriods = [];
  } else if (TP[key]) {
    const cp = state.comparePeriods;
    if (cp.includes(key)) {
      state.comparePeriods = cp.filter((k) => k !== key);
    } else {
      state.comparePeriods = [...cp, key];
      if (state.comparePeriods.length > 2) state.comparePeriods.shift();
    }
    if (state.comparePeriods.length === 0) state.timeFilter = "All";
    else if (state.comparePeriods.length === 1) state.timeFilter = state.comparePeriods[0];
    else state.timeFilter = "compare";
  }
  state.densityThresholds = null; // recompute on next build
  renderHistoricalControls();
  rebuildLayers();
}

// ──────────────────────────────────────────────────────────────────────────
// Density layer construction (PolygonLayer) — historical mode only
// ──────────────────────────────────────────────────────────────────────────

function ensureDensityThresholds(positions) {
  if (state.densityThresholds) return state.densityThresholds;
  state.densityThresholds = window.busHistoricalView.computeCountThresholds(
    positions,
    window.busHistoricalView.PALETTES.density.length
  );
  return state.densityThresholds;
}

// Build the layer set for the active historical view. In density mode it's
// one or two pre-binned PolygonLayers; in speed mode it's a single
// HexagonLayer with colorAggregation=MEAN over the active speed source.
function buildHistoricalLayers() {
  return state.historicalView === "speed"
    ? buildHistoricalSpeedLayers()
    : buildHistoricalDensityLayers();
}

function buildHistoricalSpeedLayers() {
  const HV = window.busHistoricalView;
  const allPositions = HV.flattenTrails(state.buses).map((p) => {
    const speed = effectiveSpeedFromTrail(state.buses, p);
    return { ...p, speed };
  });
  if (allPositions.length === 0) return [];
  const tf = state.timeFilter;
  if (tf === "OFF" || tf === "TRAILS") return [];

  function speedHex(id, positions) {
    if (positions.length === 0) return null;
    let data = positions.filter(
      (p) => p.speed != null && p.speed >= 0 && p.speed <= 200
    );
    // Match Python _render_density_layer (busapp/ui/historical.py:571-572):
    // grid-sample at >3000 positions so dense parquets don't tank perf. The
    // density PolygonLayer branch must NEVER sample (it would bias coloring)
    // — only this speed-hex branch.
    if (data.length > 3000) {
      data = HV.spatialSample(data, 3000, 100);
    }
    return new deck.HexagonLayer({
      id,
      data,
      getPosition: (p) => [p.lon, p.lat],
      getColorWeight: (p) => p.speed,
      colorAggregation: "MEAN",
      radius: 200,
      coverage: 0.9,
      opacity: 0.7,
      extruded: false,
      colorRange: HV.PALETTES.speed.map((c) => [c[0], c[1], c[2]]),
      pickable: true,
    });
  }

  if (tf === "compare") {
    const [aKey, bKey] = state.comparePeriods;
    const aPos = HV.filterByPeriod(allPositions, HV.TIME_PERIODS_BY_KEY[aKey]);
    const bPos = HV.filterByPeriod(allPositions, HV.TIME_PERIODS_BY_KEY[bKey]);
    return [speedHex("speed-a", aPos), speedHex("speed-b", bPos)].filter(Boolean);
  }
  let positions;
  if (tf === "All") {
    positions = HV.filterByHourRange(allPositions, state.hourRange[0], state.hourRange[1]);
  } else if (HV.TIME_PERIODS_BY_KEY[tf]) {
    positions = HV.filterByPeriod(allPositions, HV.TIME_PERIODS_BY_KEY[tf]);
  } else {
    positions = allPositions;
  }
  return [speedHex("speed", positions)].filter(Boolean);
}

// effectiveSpeed reads from a bus object; here we have a flattened trail
// point with the schema fields embedded by flattenTrails. Mode short-name →
// column: raw → `speed`, calc → `calculated_speed`, trust → `weighted_speed`
// (Python parquet schema parity).
function effectiveSpeedFromTrail(_buses, p) {
  switch (state.speedSource) {
    case "raw":
      return p.speed;
    case "corrected":
      return p.speed_corrected != null ? p.speed_corrected : p.speed;
    case "calc":
      return p.calculated_speed != null ? p.calculated_speed : p.speed;
    case "kalman":
      return p.speed_kalman != null ? p.speed_kalman : p.speed;
    case "trust":
    default:
      return p.weighted_speed != null ? p.weighted_speed : p.speed;
  }
}

function buildHistoricalDensityLayers() {
  const HV = window.busHistoricalView;
  // Flatten every bus's trail into individual positions so we can bin them.
  const allPositions = HV.flattenTrails(state.buses);
  if (allPositions.length === 0) return [];

  const tf = state.timeFilter;
  if (tf === "OFF" || tf === "TRAILS") return []; // density never renders in these modes
  const thresholds = ensureDensityThresholds(allPositions);

  // Helper to make one PolygonLayer with the given positions + palette.
  function densityLayer(id, positions, palette) {
    const cells = HV.buildDensityCells(positions, palette, thresholds);
    if (cells.length === 0) return null;
    return new deck.PolygonLayer({
      id,
      data: cells,
      getPolygon: (d) => d.polygon,
      getFillColor: (d) => d.color,
      getLineColor: [0, 0, 0, 0],
      stroked: false,
      filled: true,
      pickable: true,
    });
  }

  if (tf === "compare") {
    const [aKey, bKey] = state.comparePeriods;
    const aPos = HV.filterByPeriod(allPositions, HV.TIME_PERIODS_BY_KEY[aKey]);
    const bPos = HV.filterByPeriod(allPositions, HV.TIME_PERIODS_BY_KEY[bKey]);
    return [
      densityLayer("density-a", aPos, HV.PALETTES.compareA),
      densityLayer("density-b", bPos, HV.PALETTES.compareB),
    ].filter(Boolean);
  }

  let positions;
  if (tf === "All") {
    positions = HV.filterByHourRange(allPositions, state.hourRange[0], state.hourRange[1]);
  } else if (HV.TIME_PERIODS_BY_KEY[tf]) {
    positions = HV.filterByPeriod(allPositions, HV.TIME_PERIODS_BY_KEY[tf]);
  } else {
    positions = allPositions;
  }
  return [densityLayer("density", positions, HV.PALETTES.density)].filter(Boolean);
}

function buildPulseLayer() {
  // Pulse is live-only — no rings on historical density/traffic views, and
  // no rings when a route is selected in historical mode (trail shows position).
  if (isHistoricalDate()) return null;

  let buses = state.buses;
  if (state.selectedBus) {
    buses = buses.filter((b) => b.bus_id === state.selectedBus);
  }
  const moving = buses.filter((b) => b.status !== "Stationary" && !b.is_stale);
  if (moving.length === 0) return null;
  const expand = (Math.sin(pulsePhase * Math.PI * 2) * 0.5 + 0.5); // 0→1 oscillation
  const alpha  = Math.round((1 - expand) * 200);
  return new deck.ScatterplotLayer({
    id: "pulse-rings",
    data: moving,
    getPosition: (b) => [b.lon, b.lat],
    getRadius: (b) => busRadius(b) + Math.round(expand * busRadius(b) * 1.2),
    radiusUnits: "pixels",
    getFillColor: [0, 0, 0, 0],
    getLineColor: (b) => { const c = busFillColor(b); return [...c.slice(0, 3), alpha]; },
    stroked: true,
    filled: false,
    getLineWidth: 2,
    lineWidthUnits: "pixels",
    pickable: false,
    updateTriggers: { getRadius: [pulsePhase, cachedZoom], getLineColor: [pulsePhase] },
  });
}

function startPulseAnimation() {
  if (pulseRafId) return;
  let last = null;
  function frame(ts) {
    if (last != null) pulsePhase = (pulsePhase + (ts - last) / 1400) % 1;
    last = ts;
    if (deckOverlay && staticLayers.length > 0) {
      const pulse = buildPulseLayer();
      const allLayers = pulse ? [...staticLayers, pulse] : staticLayers;
      deckOverlay.setProps({ layers: allLayers });
    }
    pulseRafId = requestAnimationFrame(frame);
  }
  pulseRafId = requestAnimationFrame(frame);
}

function stopPulseAnimation() {
  if (pulseRafId) { cancelAnimationFrame(pulseRafId); pulseRafId = null; }
}

function rebuildLayers() {
  if (!deckOverlay) return;

  let visibleBuses = state.showStationary
    ? state.buses
    : state.buses.filter((b) => {
        const sp = effectiveSpeed(b);
        return sp != null && sp > 1;
      });

  if (state.clusterOn && state.clustersSelected.size > 0) {
    visibleBuses = visibleBuses.filter(busPassesClusterFilter);
  }

  // Single-bus drill-down: any bus selected in a historical view (except
  // compare and OFF) narrows the map to that bus's trail + dot.
  const histSelectedBus = isHistSelectedBus();
  const liveSelectedBus = !isHistoricalDate() && !!state.selectedBus;
  const anySelectedBus  = histSelectedBus || liveSelectedBus;

  // Density/speed-hex view: active when no bus is selected and a density-
  // compatible time filter is active.
  const histDensity =
    isHistoricalDate() &&
    !histSelectedBus &&
    (state.timeFilter === "All" ||
      state.timeFilter === "compare" ||
      window.busHistoricalView.TIME_PERIODS_BY_KEY[state.timeFilter]);
  const histTrailsOnly = isHistoricalDate() && state.timeFilter === "TRAILS";
  const histOff        = isHistoricalDate() && state.timeFilter === "OFF";
  if (histOff) { staticLayers = []; deckOverlay.setProps({ layers: [] }); return; }

  // Cluster filter chip overlay is meaningless when no polylines/dots render.
  const clusterChipPanel = document.getElementById("cluster-filter");
  if (clusterChipPanel) {
    clusterChipPanel.style.opacity = histDensity ? 0.3 : 1;
  }

  const layers = [];

  // Route polyline overlay — full GTFS shape for every visible bus's route,
  // drawn as a faint background beneath trails and dots so the user can see
  // the complete route even where the bus hasn't yet travelled.
  // Hidden in density / speed-hex historical views (those use polygon/hex layers).
  // In histSelectedBus mode only the selected bus's route polylines are shown.
  if (!histDensity && Object.keys(state.routeShapes).length > 0) {
    // Build the set of route labels that should be visible.
    let visibleRouteSet = null; // null = show all fetched shapes
    if (anySelectedBus && state.selectedBus) {
      const selBus = visibleBuses.find((b) => b.bus_id === state.selectedBus);
      if (selBus && selBus.route && selBus.route !== "Unknown") {
        visibleRouteSet = new Set([selBus.route]);
      }
    }

    const routePolylines = Object.entries(state.routeShapes)
      .filter(([sid]) => {
        if (!visibleRouteSet) return true;
        return visibleRouteSet.has(state.routeOf[sid]);
      })
      .map(([sid, coords]) => {
        const routeLabel = state.routeOf[sid];
        const cid = routeLabel ? state.clusterByRoute[routeLabel] : null;
        const base = cid != null
          ? window.CLUSTER_PALETTE.clusterColor(cid)
          : [210, 210, 210];
        return { path: coords, color: [...base.slice(0, 3), 130] };
      });

    if (routePolylines.length > 0) {
      layers.push(
        new deck.PathLayer({
          id: "route-shapes",
          data: routePolylines,
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          getWidth: 3,
          widthMinPixels: 2,
          pickable: false,
        })
      );
    }
  }

  // Trails (between routes and dots). Snapped paths get a PathLayer; any
  // bus without snap info falls back to LineLayer chords. Suppressed in
  // historical density / speed-hex views — the hexagon/polygon layer is
  // the whole story there; trails just clutter the visualization.
  const activePeriod = histSelectedBus && window.busHistoricalView.TIME_PERIODS_BY_KEY[state.timeFilter];
  const trailRows = histDensity
    ? { paths: [], segments: [] }
    : buildTrailRows(
        visibleBuses,
        anySelectedBus ? "selected" : null,
        activePeriod ? activePeriod.hours : null
      );
  if (trailRows.paths.length) {
    layers.push(
      new deck.PathLayer({
        id: "trails-snapped",
        data: trailRows.paths,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        getWidth: 2,
        widthMinPixels: 2,
        pickable: false,
      })
    );
  }
  if (trailRows.segments.length) {
    layers.push(
      new deck.LineLayer({
        id: "trails-chord",
        data: trailRows.segments,
        getSourcePosition: (d) => d.from,
        getTargetPosition: (d) => d.to,
        getColor: (d) => d.color,
        getWidth: 2,
        widthMinPixels: 2,
        pickable: false,
      })
    );
  }

  // Historical view layers — density polygons or speed hexagons,
  // depending on state.historicalView.
  if (histDensity) {
    for (const dl of buildHistoricalLayers()) layers.push(dl);
  }

  // Bus dots — live only (or historical non-density non-trails with no bus
  // selected). Historical density, trails-only, and any historical bus
  // selection all suppress dots — the trail is the position indicator there.
  if (!histDensity && !histSelectedBus && !histTrailsOnly) {
    let dotData = visibleBuses;
    if (anySelectedBus) {
      dotData = visibleBuses.filter((b) => b.bus_id === state.selectedBus);
    }
    layers.push(
      new deck.ScatterplotLayer({
        id: "buses",
        data: dotData,
        getPosition: (b) => [b.lon, b.lat],
        getFillColor: busFillColorWithFilter,
        getRadius: busRadius,
        radiusUnits: "pixels",
        pickable: true,
        onClick: (info) => {
          if (info && info.object) {
            selectBus(info.object.bus_id);
          }
        },
        updateTriggers: {
          getFillColor: [state.colorBy, state.speedSource],
          getRadius: [state.selectedBus, cachedZoom],
        },
      })
    );
  }

  staticLayers = layers;
  deckOverlay.setProps({
    layers: staticLayers,
    getTooltip: ({ object }) => {
      if (!object) return null;
      if (object.bus_id) return { html: tooltipHtml(object) };
      if (object.count != null && object.polygon) {
        // Density cell — show its distinct-bus count.
        return { html: `<b>${object.count}</b> distinct bus${object.count === 1 ? "" : "es"} in this cell` };
      }
      return null;
    },
  });

  updateTrailColorCaption();
  updateMapLegend();
}

// Returns true when a historical bus is selected and the map is showing that
// bus's trail (not density). Used by both legend functions.
function isHistSelectedBus() {
  return (
    isHistoricalDate() &&
    !!state.selectedBus &&
    state.timeFilter !== "compare" &&
    state.timeFilter !== "OFF" &&
    (state.timeFilter === "All" ||
      state.timeFilter === "TRAILS" ||
      !!window.busHistoricalView.TIME_PERIODS_BY_KEY[state.timeFilter])
  );
}

function updateMapLegend() {
  const el = document.getElementById("map-legend");
  if (!el) return;

  const historical = isHistoricalDate();
  const tf = state.timeFilter;
  const showingMap = historical && tf !== "OFF" && tf !== "TRAILS";

  // When a bus is selected the trail color caption conveys the speed legend —
  // the density/speed-hex map legend is irrelevant (nothing is rendered there).
  if (!showingMap || isHistSelectedBus()) { el.hidden = true; return; }

  const isDensity = state.historicalView === "density";
  const PALETTES = window.busHistoricalView.PALETTES;
  const palette = isDensity ? PALETTES.density : PALETTES.speed;

  const [lowLabel, highLabel] = isDensity ? ["sparse", "dense"] : ["slow", "fast"];
  const title = isDensity ? "Density" : "Speed";

  el.innerHTML =
    `<div class="legend-title">${title}</div>` +
    `<span style="font-size:9px;opacity:0.6;">${lowLabel}</span>` +
    palette.map((c) =>
      `<div class="legend-swatch" title="" style="background:rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})"></div>`
    ).join("") +
    `<span style="font-size:9px;opacity:0.6;">${highLabel}</span>`;

  el.hidden = false;
}

// Mirrors Python busapp/ui/live.py:181-182 and busapp/ui/historical.py
// "Color = hour of day…" / "🔴 Slow…" captions — surfaces the active
// trail color legend whenever trails are rendered. Hidden in OFF historical
// mode (no trails), in density / speed-hex historical mode (no trails), and
// in cluster-trail mode (trail color encodes cluster id, not speed/hour).
function updateTrailColorCaption() {
  const el = document.getElementById("trail-color-caption");
  if (!el) return;
  // Trails are rendered when:
  //   • live view with trail mode on, OR
  //   • historical TRAILS mode, OR
  //   • historical with a bus selected (single-bus trail in any time filter)
  // Trails are NOT rendered in density/speed-hex historical views (All Times,
  // compare, period buttons) unless a bus is selected.
  const histSelected = isHistSelectedBus();
  const trailsRendered =
    state.trailMode !== "none" &&
    !(
      isHistoricalDate() &&
      !histSelected &&
      (state.timeFilter === "All" ||
        state.timeFilter === "compare" ||
        window.busHistoricalView.TIME_PERIODS_BY_KEY[state.timeFilter])
    );
  if (!trailsRendered || isClusterTrailMode()) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  if (state.trailColorBy === "speed") {
    el.textContent =
      "🔴 Slow (<20 km/h)   🟠 Medium (20–40 km/h)   🟢 Fast (>40 km/h)";
  } else if (isHistoricalDate()) {
    el.textContent = "Trail color = time of day · 🔵 early → 🟡 midday → 🔴 late";
  } else {
    el.textContent = "Trail fades from older (faint) to newer (bright).";
  }
  el.hidden = false;
}

function tooltipHtml(bus) {
  const sp = effectiveSpeed(bus);
  const speedFmt = sp != null ? `${sp.toFixed(1)} km/h` : "—";
  const f = (v) => (v != null ? v.toFixed(1) : "—");
  return (
    `<b>${bus.bus_id}</b><br/>` +
    `Route: ${bus.route}<br/>` +
    `Speed (${state.speedSource}): ${speedFmt}<br/>` +
    `<small>raw=${f(bus.speed)} · calc=${f(bus.calculated_speed)} · ` +
    `kalman=${f(bus.speed_kalman)} · trust=${f(bus.weighted_speed)} ` +
    `(score=${f(bus.trust_score)}) · trail=${bus.trail.length}</small>`
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Selection
// ──────────────────────────────────────────────────────────────────────────

function showSidebarTimeline() {
  const el = document.getElementById("sidebar-timeline");
  const sidebar = document.getElementById("sidebar");
  if (el && sidebar) {
    // Insert after the date-calendar section (after its trailing <hr>),
    // so the date picker always stays at the very top of the sidebar.
    const firstSep = sidebar.querySelector(".sidebar-sep");
    if (firstSep && firstSep.nextSibling) {
      sidebar.insertBefore(el, firstSep.nextSibling);
    } else {
      sidebar.prepend(el);
    }
    el.hidden = false;
    requestAnimationFrame(() => {
      if (window.busTimeline && window.busTimeline.resize) window.busTimeline.resize();
    });
  }
}

function hideSidebarTimeline() {
  const el = document.getElementById("sidebar-timeline");
  if (el) el.hidden = true;
}

// PCA on route coords to find the principal axis angle, returned as a MapLibre
// bearing (degrees clockwise from north) that makes the route appear horizontal.
// Uses the atan2-based formula which avoids degeneracy on pure E-W or N-S routes.
function computeOptimalBearing(coords, midLat) {
  if (!coords || coords.length < 3) return null;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  let mx = 0, my = 0;
  for (const c of coords) { mx += c.lon * cosLat; my += c.lat; }
  mx /= coords.length; my /= coords.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const c of coords) {
    const x = c.lon * cosLat - mx;
    const y = c.lat - my;
    sxx += x * x; syy += y * y; sxy += x * y;
  }
  // Principal axis angle from east (x-axis), in [-π/2, π/2]
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // Compass bearing of the principal axis (clockwise from north)
  const compassBearing = 90 - (theta * 180 / Math.PI);
  // Map bearing that makes the route appear horizontal = compassBearing - 90.
  // Exploit line symmetry (b ≡ b+180) to keep result in (-90, 90].
  let b = ((compassBearing - 90) % 360 + 360) % 360;
  if (b > 180) b -= 180;
  if (b > 90)  b -= 180;
  return Math.round(b);
}

function fitBoundsOptimal(minLat, maxLat, minLon, maxLon, bearing) {
  if (bearing == null) {
    // Fallback: binary 0/90 decision from bounding-box aspect ratio.
    const midLat = (minLat + maxLat) / 2;
    const routeW = (maxLon - minLon) * 111 * Math.cos(midLat * Math.PI / 180);
    const routeH = (maxLat - minLat) * 111;
    const mapEl  = document.getElementById("map");
    const mapAspect = mapEl ? mapEl.offsetWidth / mapEl.offsetHeight : 1.6;
    bearing = (routeW / Math.max(routeH, 0.001)) < (1 / mapAspect) ? 90 : 0;
  }
  appSetBearing = bearing !== 0;
  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { bearing, padding: 60, duration: 600, maxZoom: 16 });
}

async function fitToSelectedBus(busId) {
  if (!map) return;
  const bus = state.buses.find((b) => b.bus_id === busId);
  if (!bus) return;

  // Primary: full GTFS route shape — same geometry that's rendered on the map.
  // This is the authoritative bbox for both zoom and bearing in live and historical.
  const shapeCoords = [];
  if (bus.route && bus.route !== "Unknown") {
    for (const [sid, polyline] of Object.entries(state.routeShapes)) {
      if (state.routeOf[sid] === bus.route) {
        for (const [lon, lat] of polyline) shapeCoords.push({ lat, lon });
      }
    }
  }
  if (shapeCoords.length > 0) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of shapeCoords) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    fitBoundsOptimal(minLat, maxLat, minLon, maxLon,
      computeOptimalBearing(shapeCoords, (minLat + maxLat) / 2));
    return;
  }

  // Fallback for live Unknown-route buses: historical bbox from the server.
  if (!isHistoricalDate()) {
    try {
      const res = await fetch(`/api/bus-bbox?bus_id=${encodeURIComponent(busId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.bbox) {
          const { minLat, maxLat, minLon, maxLon } = data.bbox;
          fitBoundsOptimal(minLat, maxLat, minLon, maxLon, null);
          return;
        }
      }
    } catch (err) { /* fall through */ }
  }

  // Last resort: trail points.
  const trailCoords = (bus.trail || []).filter((p) => p.lat != null && p.lon != null);
  if (trailCoords.length === 0) return;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of trailCoords) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  fitBoundsOptimal(minLat, maxLat, minLon, maxLon,
    computeOptimalBearing(trailCoords, (minLat + maxLat) / 2));
}

function selectBus(busId) {
  state.selectedBus = busId;
  if (window.busTable) window.busTable.setSelected(busId);
  showSidebarTimeline();
  renderSelectedBusTimeline();
  setMapDim(true);
  rebuildLayers();
  fitToSelectedBus(busId);
}

function clearSelection() {
  state.selectedBus = null;
  if (window.busTable) window.busTable.setSelected(null);
  hideSidebarTimeline();
  setMapDim(false);
  rebuildLayers();
  if (map) {
    const flyOpts = { center: [KL_CENTER.lon, KL_CENTER.lat], zoom: KL_CENTER.zoom, duration: 600 };
    if (appSetBearing) flyOpts.bearing = 0;
    appSetBearing = false;
    map.flyTo(flyOpts);
  }
}

document.getElementById("sidebar-timeline-close").addEventListener("click", clearSelection);

// ──────────────────────────────────────────────────────────────────────────
// Hamburger menu toggle
// ──────────────────────────────────────────────────────────────────────────
(function () {
  const btn = document.getElementById("hamburger-btn");
  const panel = document.getElementById("hamburger-panel");
  if (!btn || !panel) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });

  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) {
      panel.hidden = true;
    }
  });
})();

// ──────────────────────────────────────────────────────────────────────────
// Light / dark mode toggle
(function () {
  const btn = document.getElementById("theme-toggle");
  const iconSun = document.getElementById("icon-sun");
  const iconMoon = document.getElementById("icon-moon");
  if (!btn || !iconSun || !iconMoon) return;

  const STORAGE_KEY = "busjs-theme";
  let isLight = localStorage.getItem(STORAGE_KEY) === "light";

  function applyTheme() {
    document.body.classList.toggle("light-mode", isLight);
    iconSun.style.display = isLight ? "none" : "block";
    iconMoon.style.display = isLight ? "block" : "none";
    btn.title = isLight ? "Switch to dark mode" : "Switch to light mode";
  }

  applyTheme();

  btn.addEventListener("click", () => {
    isLight = !isLight;
    localStorage.setItem(STORAGE_KEY, isLight ? "light" : "dark");
    applyTheme();
  });
})();

// ──────────────────────────────────────────────────────────────────────────
// Polling loop
// ──────────────────────────────────────────────────────────────────────────

function setMapLoading(on) {
  const el = document.getElementById("map-loading");
  if (el) el.hidden = !on;
}

function showAutoSwitchNotice() {
  const el = document.getElementById("auto-switch-notice");
  if (!el) return;
  el.textContent = "⚠ No live service";
  el.hidden = false;
}

function hideAutoSwitchNotice() {
  const el = document.getElementById("auto-switch-notice");
  if (el) el.hidden = true;
}

async function maybeAutoSwitchToHistorical() {
  try {
    const res = await fetch("/api/dates");
    if (!res.ok) return false;
    const { dates } = await res.json();
    const todayKL = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
    const best = (dates || []).find(d => d.date !== todayKL);
    if (!best) return false;
    state.autoSwitchedToHistorical = true;
    updateBusArtStatus();
    showAutoSwitchNotice();
    window._calendarSetDate(best.date);
    // Poll live quietly in the background; switch back when buses return.
    if (state.liveCheckHandle) clearInterval(state.liveCheckHandle);
    state.liveCheckHandle = setInterval(async () => {
      try {
        const r = await fetch(`/api/buses?interval=${state.intervalSec}`);
        if (!r.ok) return;
        const d = await r.json();
        if (!d.is_historical && (d.buses || []).length > 0) {
          clearInterval(state.liveCheckHandle);
          state.liveCheckHandle = null;
          state.autoSwitchedToHistorical = false;
          updateBusArtStatus();
          hideAutoSwitchNotice();
          window._calendarSetDate("today");
        }
      } catch { /* network blip */ }
    }, Math.max(state.intervalSec, 60) * 1000);
    return true;
  } catch (err) {
    console.warn("auto-switch failed", err);
    return false;
  }
}

async function refreshOnce() {
  const historical = isHistoricalDate();
  if (historical) setMapLoading(true);
  try {
    await fetchBuses();
    if (!isHistoricalDate() && state.buses.length === 0 && !state.autoSwitchedToHistorical) {
      const switched = await maybeAutoSwitchToHistorical();
      if (switched) return;
    }
    await fetchShapeRouteIndex();
    rebuildLayers();
    // Refresh dependent views.
    document.body.classList.toggle("historical", historical);
    matchTableToMap();
    if (window.busTable) {
      window.busTable.setHistorical(historical);
      window.busTable.render(state.buses);
      window.busTable.setSelected(state.selectedBus);
    }
    if (window.busTimeline) {
      window.busTimeline.populateDropdown(state.buses, state.selectedBus);
      renderSelectedBusTimeline();
    }
    // Heatmap pulls from a separate accumulator endpoint — refresh on the
    // same tick so the chart visibly grows over time. Skip when the user
    // has selected a historical date (snapshot, won't change).
    if (window.busHeatmap) {
      const dp = document.getElementById("heatmap-date-picker");
      const onHistorical = dp && dp.value && dp.value !== "today";
      if (!onHistorical) window.busHeatmap.refresh();
    }
    // Re-run clustering each tick so cluster IDs reflect the latest data.
    if (state.clusterOn) await fetchClusters();
  } catch (err) {
    console.error("refresh failed", err);
  } finally {
    if (historical) setMapLoading(false);
  }
}

function speedSourceLabel() {
  return (
    {
      trust: "Trust-Weighted",
      kalman: "Kalman Filtered",
      calc: "Calculated Displacement",
      raw: "Raw GPS",
    }[state.speedSource] || state.speedSource
  );
}

function speedFromTrailPoint(p) {
  switch (state.speedSource) {
    case "raw":
      return p.speed;
    case "calc":
      return p.calculated_speed != null ? p.calculated_speed : p.speed;
    case "kalman":
      return p.speed_kalman != null ? p.speed_kalman : p.speed;
    case "trust":
    default:
      return p.weighted_speed != null ? p.weighted_speed : p.speed;
  }
}

function renderSelectedBusTimeline() {
  if (!window.busTimeline) return;
  const bus = state.selectedBus
    ? state.buses.find((b) => b.bus_id === state.selectedBus)
    : null;
  window.busTimeline.render(bus, speedSourceLabel(), speedFromTrailPoint);
}

function schedulePolling() {
  if (state.pollHandle) clearInterval(state.pollHandle);
  // Historical date = static snapshot, no point polling it.
  if (state.date && state.date !== "today") return;
  state.pollHandle = setInterval(refreshOnce, state.intervalSec * 1000);
}

// ──────────────────────────────────────────────────────────────────────────
// Sidebar wiring
// ──────────────────────────────────────────────────────────────────────────

document.getElementById("interval").addEventListener("change", (e) => {
  const v = parseInt(e.target.value, 10);
  if (Number.isFinite(v) && v >= 10) {
    state.intervalSec = v;
    schedulePolling();
  }
});

document.getElementById("trail-mode").addEventListener("change", (e) => {
  state.trailMode = e.target.value;
  rebuildLayers();
});

document.getElementById("color-by").addEventListener("change", (e) => {
  state.colorBy = e.target.value;
  rebuildLayers();
});

function syncCorrectionMethodVisibility() {
  const show = state.speedSource === "corrected";
  document.getElementById("correction-method-row").style.display = show ? "" : "none";
}

document.getElementById("speed-source").addEventListener("change", (e) => {
  state.speedSource = e.target.value;
  syncCorrectionMethodVisibility();
  rebuildLayers();
  if (window.busTable) {
    window.busTable.render(state.buses);
    window.busTable.setSelected(state.selectedBus);
  }
  renderSelectedBusTimeline();
});

syncCorrectionMethodVisibility();

document.getElementById("show-stationary").addEventListener("change", (e) => {
  state.showStationary = e.target.checked;
  rebuildLayers();
});

document.getElementById("cluster-on").addEventListener("change", async (e) => {
  state.clusterOn = e.target.checked;
  const eitherClusterOn = state.clusterOn || state.clusterHoursOn;
  document.getElementById("cluster-metric").disabled = !eitherClusterOn;
  document.getElementById("cluster-k").disabled = !eitherClusterOn;
  // Cluster-trail mode (Pass 29 parity): when clustering activates in
  // historical view, force OFF time filter + All-Buses trails so the map
  // shows the geographic footprint of each cluster.
  if (state.clusterOn && isHistoricalDate()) {
    state.timeFilter = "TRAILS";
    state.comparePeriods = [];
    if (state.trailMode === "none") {
      state.trailMode = "all";
      document.getElementById("trail-mode").value = "all";
    }
    renderHistoricalControls();
  }
  if (state.clusterOn) {
    await fetchClusters();
  } else {
    state.clusterByRoute = {};
    state.clusterOrder = [];
    state.clustersSelected = new Set();
    rebuildClusterFilterUI();
    updateClusterStatus(null);
    if (window.busHeatmap) window.busHeatmap.setClusters({}, []);
  }
  rebuildLayers();
});

document.getElementById("cluster-metric").addEventListener("change", async (e) => {
  state.clusterMetric = e.target.value;
  state.clustersSelected = new Set();
  await fetchClusters();
  rebuildLayers();
});

document.getElementById("cluster-k").addEventListener("input", (e) => {
  state.clusterK = parseInt(e.target.value, 10);
  document.getElementById("cluster-k-value").textContent = state.clusterK;
});
document.getElementById("cluster-k").addEventListener("change", async () => {
  state.clustersSelected = new Set();
  await fetchClusters();
  rebuildLayers();
});

// Independent hour-clustering toggle. Mirrors Python's settings.cluster_hours
// — reorders only the heatmap's y-axis, never the map. Route clustering can
// be off while hour clustering is on.
const clusterHoursEl = document.getElementById("cluster-hours-on");
if (clusterHoursEl) {
  clusterHoursEl.addEventListener("change", async (e) => {
    state.clusterHoursOn = e.target.checked;
    // Distance-metric and K selectors need to be enabled if either toggle is on.
    const eitherOn = state.clusterOn || state.clusterHoursOn;
    document.getElementById("cluster-metric").disabled = !eitherOn;
    document.getElementById("cluster-k").disabled = !eitherOn;
    if (state.clusterOn || state.clusterHoursOn) {
      await fetchClusters();
    } else {
      state.clusterHourOrder = null;
      if (window.busHeatmap) window.busHeatmap.setHourOrder(null);
    }
  });
}

// Wire the heatmap toolbar's date picker so picking a historical date also
// drives the map. The picker is mounted by heatmap.js after busHeatmap.mount;
// we attach our own listener so both components stay in sync without the
// heatmap module having to know about main.js.
// Inspect every trail point's KL hour to find the data's actual hour window.
// Mirrors Python _render_hour_scrubber_view (busapp/ui/historical.py:640-647)
// which derives min/max from the data's timestamps and clamps the slider's
// initial position. Returns [0, 23] when there's no data to inspect.
function computeDataHourRange() {
  const KL = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kuala_Lumpur",
    hour: "numeric",
    hourCycle: "h23",
    minute: "2-digit",
  });
  let minH = null;
  let maxH = null;
  let maxHadMinutes = false;
  for (const b of state.buses) {
    for (const p of b.trail || []) {
      const parts = KL.formatToParts(new Date(p.time));
      const hh = parseInt(parts.find((x) => x.type === "hour").value, 10);
      const mm = parseInt(parts.find((x) => x.type === "minute").value, 10);
      if (minH == null || hh < minH) minH = hh;
      if (maxH == null || hh > maxH) {
        maxH = hh;
        maxHadMinutes = mm > 0;
      } else if (hh === maxH && mm > 0) {
        maxHadMinutes = true;
      }
    }
  }
  if (minH == null) return [0, 23];
  // Python rounds the upper bound up if the last sample falls past the hour
  // mark, capped at 23.
  if (maxHadMinutes) maxH = Math.min(maxH + 1, 23);
  if (maxH < minH) maxH = minH;
  return [minH, maxH];
}

// ── Calendar widget ──────────────────────────────────────────────────────────
// Renders a month-grid calendar in the sidebar. Available dates are read from
// the hidden <select> (which heatmap.js populates from /api/dates). Selecting
// a day sets the hidden select's value and dispatches "change" so all existing
// listeners (bindDatePickerToMap + heatmap.js) fire normally.
function initDateCalendar() {
  const dp       = document.getElementById("heatmap-date-picker");
  const cal      = document.getElementById("date-calendar");
  const grid     = document.getElementById("date-cal-days");
  const title    = document.getElementById("date-cal-title");
  const liveBtn  = document.getElementById("date-cal-live");
  const trigger  = document.getElementById("date-cal-trigger");
  const trigLabel = document.getElementById("date-cal-trigger-label");
  if (!dp || !grid || !trigger) return;

  const todayStr = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());

  let viewYear, viewMonth;
  { const t = new Date(); viewYear = t.getFullYear(); viewMonth = t.getMonth(); }

  function availableDates() {
    return new Set([...dp.options].map((o) => o.value).filter((v) => v !== "today"));
  }

  function selectedDate() { return dp.value; }

  function updateTriggerLabel(val) {
    if (!trigLabel) return;
    if (!val || val === "today") {
      trigLabel.textContent = "Today (live)";
    } else {
      // Format as "13 May 2026"
      const [y, m, d] = val.split("-").map(Number);
      trigLabel.textContent = new Date(y, m - 1, d)
        .toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    }
  }

  function closeCalendar() {
    cal.hidden = true;
    trigger.classList.remove("open");
  }

  function setDate(val) {
    if (dp.value === val) { closeCalendar(); return; }
    dp.value = val;
    dp.dispatchEvent(new Event("change", { bubbles: true }));
    updateTriggerLabel(val);
    closeCalendar();
  }

  function render() {
    const avail    = availableDates();
    const selected = selectedDate();
    const today    = todayStr();

    title.textContent = new Date(viewYear, viewMonth, 1)
      .toLocaleDateString("en-US", { month: "long", year: "numeric" });
    liveBtn.classList.toggle("active", selected === "today");
    updateTriggerLabel(selected);

    grid.innerHTML = "";
    const firstDow    = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    for (let i = 0; i < firstDow; i++) grid.insertAdjacentHTML("beforeend", "<div></div>");
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const cell = document.createElement("div");
      cell.className = ["date-cal-day",
        avail.has(dateStr) ? "has-data" : "",
        selected === dateStr ? "selected" : "",
        dateStr === today ? "is-today" : "",
      ].filter(Boolean).join(" ");
      cell.textContent = d;
      if (avail.has(dateStr)) cell.addEventListener("click", () => setDate(dateStr));
      grid.appendChild(cell);
    }
  }

  function openCalendar() {
    const rect = trigger.getBoundingClientRect();
    cal.style.top  = `${rect.bottom + 4}px`;
    cal.style.left = `${rect.left}px`;
    cal.hidden = false;
    trigger.classList.add("open");
    render();
  }

  // Toggle open/close
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    cal.hidden ? openCalendar() : closeCalendar();
  });

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!cal.hidden && !cal.contains(e.target) && e.target !== trigger) closeCalendar();
  });

  // Nav buttons
  document.getElementById("date-cal-prev").addEventListener("click", (e) => {
    e.stopPropagation();
    viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } render();
  });
  document.getElementById("date-cal-next").addEventListener("click", (e) => {
    e.stopPropagation();
    viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } render();
  });

  liveBtn.addEventListener("click", () => setDate("today"));

  // Watch for new <option> elements added by heatmap.js (async /api/dates fetch).
  const observer = new MutationObserver(() => { if (!cal.hidden) render(); updateTriggerLabel(dp.value); });
  observer.observe(dp, { childList: true });

  // Expose programmatic date switch for auto-switch feature.
  window._calendarSetDate = setDate;

  // Expose for syncPicker to jump viewport to a restored date.
  window._calendarRender = (dateStr) => {
    if (dateStr && dateStr !== "today") {
      const [y, m] = dateStr.split("-").map(Number);
      viewYear = y; viewMonth = m - 1;
    }
    updateTriggerLabel(dateStr || "today");
    if (!cal.hidden) render();
  };

  updateTriggerLabel(dp.value);
}

function bindDatePickerToMap() {
  const dp = document.getElementById("heatmap-date-picker");
  if (!dp) return;
  dp.addEventListener("change", async (e) => {
    state.date = e.target.value || "today";
    // Only persist manual date picks — never persist auto-switch selections.
    if (!state.autoSwitchedToHistorical) {
      if (state.date && state.date !== "today") {
        localStorage.setItem("busjs-date", state.date);
      } else {
        localStorage.removeItem("busjs-date");
      }
    }
    // User manually picked a date — cancel background live-check.
    if (!state.autoSwitchedToHistorical && state.liveCheckHandle) {
      clearInterval(state.liveCheckHandle);
      state.liveCheckHandle = null;
    }
    // Each new date gets its own density threshold baseline and route shapes.
    state.densityThresholds = null;
    state._lastRouteFetchKey = "";
    // Reset historical view state to a sensible default when entering / leaving.
    if (isHistoricalDate()) {
      // Cluster-trail mode (Pass 29 parity) — when clustering is already
      // on, entering historical jumps straight to OFF + trails-by-cluster.
      if (state.clusterOn) {
        state.timeFilter = "OFF";
        state.comparePeriods = [];
        if (state.trailMode === "none") {
          state.trailMode = "all";
          document.getElementById("trail-mode").value = "all";
        }
      } else {
        state.timeFilter = "All";
        state.comparePeriods = [];
        // Hour range gets recomputed below from the actual data window
        // once refreshOnce has populated state.buses.
      }
    }
    // Show historical controls + stop live polling immediately — don't wait
    // for the slow parquet fetch. The user sees the period buttons appear
    // right away, confirming the date change was registered.
    renderHistoricalControls();
    schedulePolling();
    await refreshOnce();
    // Clamp the All-Times scrubber to the data's actual hour window
    // (Python parity — see _render_hour_scrubber_view). Skip when not
    // viewing historical or when clustering forced OFF mode.
    if (isHistoricalDate() && !state.clusterOn) {
      state.hourRange = computeDataHourRange();
      renderHistoricalControls(); // re-render to update hour labels after data loads
    }
    // Re-cluster against the new date's data.
    if (state.clusterOn) await fetchClusters();
  });
}

function bindHistoricalControls() {
  for (const btn of document.querySelectorAll(".view-btn")) {
    btn.addEventListener("click", () => {
      state.historicalView = btn.dataset.view;
      for (const b of document.querySelectorAll(".view-btn")) {
        b.classList.toggle("active", b.dataset.view === state.historicalView);
      }
      rebuildLayers();
    });
  }
  document.getElementById("hour-min").addEventListener("input", (e) => {
    let v = parseInt(e.target.value, 10);
    if (v > state.hourRange[1]) v = state.hourRange[1];
    state.hourRange = [v, state.hourRange[1]];
    document.getElementById("hour-min-label").textContent = String(v).padStart(2, "0");
    rebuildLayers();
    document.getElementById("historical-caption").textContent =
      `🌐 All Times · hour range ${state.hourRange[0]}:00 – ${state.hourRange[1]}:00`;
  });
  document.getElementById("hour-max").addEventListener("input", (e) => {
    let v = parseInt(e.target.value, 10);
    if (v < state.hourRange[0]) v = state.hourRange[0];
    state.hourRange = [state.hourRange[0], v];
    document.getElementById("hour-max-label").textContent = String(v).padStart(2, "0");
    rebuildLayers();
    document.getElementById("historical-caption").textContent =
      `🌐 All Times · hour range ${state.hourRange[0]}:00 – ${state.hourRange[1]}:00`;
  });
}

// ── Service-day progress + bus-art colour ────────────────────────────────────
// Service window: 05:00 → 01:30 KL (next calendar day). The ASCII bus art
// turns green when buses are running, red when the last service has ended.
// A thin road strip at the bottom of the header fills left-to-right over the
// service day so you can see at a glance how far through the day we are.
function updateBusArtStatus() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kuala_Lumpur",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const klHour   = parseInt(parts.find((p) => p.type === "hour").value);
  const klMinute = parseInt(parts.find((p) => p.type === "minute").value);
  const totalMins = klHour * 60 + klMinute;

  // Service day 05:00 → 01:30 next day (1230-minute window).
  const SVC_START = 5 * 60;        // 300
  const SVC_END   = 24 * 60 + 90;  // 1530
  const SVC_DUR   = SVC_END - SVC_START; // 1230

  // Shift post-midnight hours (00:00–04:59) into service-day time.
  const svcMin = totalMins >= SVC_START
    ? totalMins - SVC_START
    : 24 * 60 - SVC_START + totalMins;

  const isActive = svcMin < SVC_DUR;
  const progress = Math.min(svcMin / SVC_DUR, 1);

  // When auto-switched to historical (live feed returned 0 buses), show the
  // ended state regardless of clock time — the two signals must agree.
  const effectiveActive = isActive && !state.autoSwitchedToHistorical;

  // Colour the ASCII bus art.
  const busArt = document.querySelector(".bus-art");
  if (busArt) {
    busArt.classList.toggle("bus-art--active", effectiveActive);
    busArt.classList.toggle("bus-art--ended",  !effectiveActive);
  }

  // Move the road fill.
  const fill = document.getElementById("bus-day-fill");
  if (fill) {
    fill.style.width = `${progress * 100}%`;
    fill.classList.toggle("bus-day-fill--ended", !effectiveActive);
  }
}

async function start() {
  startPulseAnimation();
  if (window.busHeatmap) {
    window.busHeatmap.mount(document.getElementById("heatmap-chart"));
  }
  if (window.busTable) {
    window.busTable.mount({
      onSelect: (id) => (id ? selectBus(id) : clearSelection()),
      getSpeed: (b) => effectiveSpeed(b),
      onFilterChange: () => rebuildLayers(),
    });
  }
  if (window.busTimeline) {
    window.busTimeline.mount({
      onSelect: (id) => (id ? selectBus(id) : clearSelection()),
      onSelectBottom: (id) => {
        state.selectedBus = id || null;
        busTimeline.setSelected(id);
        renderSelectedBusTimeline();
        rebuildLayers();
      },
    });
  }
  initDateCalendar();
  bindDatePickerToMap();
  bindNewSidebarControls();
  bindHistoricalControls();

  // Always start in live mode — try live first on every page load.
  localStorage.removeItem("busjs-date");

  renderHistoricalControls();
  await refreshOnce();
  schedulePolling();

  // Sync the date picker UI and heatmap.js's internal currentDate after the
  // picker options have been populated by heatmap.js's async /api/dates fetch.
  // populateDatePicker() runs concurrently; it should finish around the same
  // time as our refreshOnce(), but we wait up to 3 s in case it's slower.
  if (state.date && state.date !== "today") {
    const targetDate = state.date;
    let syncAttempts = 0;
    const syncPicker = () => {
      const dp = document.getElementById("heatmap-date-picker");
      if (!dp) return;
      const optExists = [...dp.options].some((o) => o.value === targetDate);
      if (optExists) {
        dp.value = targetDate;
        if (window.busHeatmap) window.busHeatmap.setDate(targetDate);
        // Sync the calendar viewport to the restored date.
        if (window._calendarRender) window._calendarRender(targetDate);
      } else if (++syncAttempts < 10) {
        // Options not yet populated — retry after a short delay (max ~3 s).
        setTimeout(syncPicker, 300);
      } else {
        // Date no longer available — clear the stale saved value.
        localStorage.removeItem("busjs-date");
      }
    };
    syncPicker();
    if (!state.clusterOn) {
      state.hourRange = computeDataHourRange();
      renderHistoricalControls();
    }
  }
}

function bindNewSidebarControls() {
  document.getElementById("map-style").addEventListener("change", (e) => {
    mapStyle = e.target.value;
    map.setStyle(MAP_STYLES[mapStyle]);
    // setStyle drops all custom layers; re-add the deck overlay once the
    // basemap finishes reloading.
    map.once("style.load", () => {
      if (deckOverlay) {
        map.addControl(deckOverlay);
        rebuildLayers();
      }
    });
  });
  document.getElementById("trail-color-by").addEventListener("change", (e) => {
    state.trailColorBy = e.target.value;
    rebuildLayers();
  });
  document.getElementById("hide-unknown").addEventListener("change", async (e) => {
    state.hideUnknown = e.target.checked;
    await refreshOnce();
  });
  document.getElementById("correction-method").addEventListener("change", async (e) => {
    try {
      await fetch("/api/correction-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: e.target.value }),
      });
    } catch (err) {
      console.error("correction method change failed", err);
    }
  });

  // Rollover overlay — polls /api/rollover-status every 3 s while in progress,
  // every 60 s otherwise. Shows a full-page freeze with countdown when the
  // midnight pipeline is running.
  const rolloverOverlay = document.getElementById("rollover-overlay");
  const rolloverCountdown = document.getElementById("rollover-countdown");
  let rolloverPollTimer = null;
  let rolloverCountdownTimer = null;

  function startCountdown(startedAt, estimatedMs) {
    clearInterval(rolloverCountdownTimer);
    rolloverCountdownTimer = setInterval(() => {
      const remaining = Math.ceil((estimatedMs - (Date.now() - startedAt)) / 1000);
      rolloverCountdown.textContent = remaining > 5
        ? `~${remaining}s`
        : "any moment now…";
    }, 1000);
  }

  async function pollRollover() {
    try {
      const res = await fetch("/api/rollover-status");
      const data = await res.json();
      if (data.in_progress) {
        rolloverOverlay.hidden = false;
        startCountdown(data.started_at, data.estimated_ms);
        // Poll fast while in progress
        rolloverPollTimer = setTimeout(pollRollover, 3000);
      } else {
        if (!rolloverOverlay.hidden) {
          // Was showing — rollover just finished; reload fresh data
          rolloverOverlay.hidden = true;
          clearInterval(rolloverCountdownTimer);
          refreshOnce();
        }
        // Poll slowly when idle
        rolloverPollTimer = setTimeout(pollRollover, 60_000);
      }
    } catch {
      rolloverPollTimer = setTimeout(pollRollover, 10_000);
    }
  }

  pollRollover();

  // Kick off bus-art status and update every minute.
  updateBusArtStatus();
  setInterval(updateBusArtStatus, 60_000);
}

// ── Weather popover ──────────────────────────────────────────────────────────
// Click the header weather widget to see the full 24-hour forecast for the
// currently-viewed date (today or any historical date).
(function () {
  const trigger = document.getElementById("header-weather");
  if (!trigger) return;

  const pop = document.createElement("div");
  pop.id = "weather-popover";
  pop.hidden = true;
  document.body.appendChild(pop);

  const WX_ICONS = {
    0:"☀️",1:"🌤",2:"⛅",3:"☁️",45:"🌫",48:"🌫",
    51:"🌦",53:"🌦",55:"🌧",61:"🌧",63:"🌧",65:"🌧",
    71:"❄️",73:"❄️",75:"❄️",80:"🌦",81:"🌦",82:"🌧",
    95:"⛈",96:"⛈",99:"⛈",
  };
  function wxIcon(code) {
    if (code == null) return "";
    return WX_ICONS[code] || (code < 50 ? "☁️" : code < 70 ? "🌧" : code < 80 ? "❄️" : "⛈");
  }

  function renderHours(hours, dateStr) {
    const isToday = !dateStr || dateStr === "today";
    const klHour = isToday ? (((Date.now() + 8 * 3600_000) / 3600_000) | 0) % 24 : -1;
    const label = isToday ? "Today" : dateStr;
    let html = `<div class="wx-pop-header">24-hour forecast · ${label}</div>`;
    for (let h = 0; h < 24; h++) {
      const w = hours[h] || hours[String(h)] || {};
      html +=
        `<div class="wx-pop-row${h === klHour ? " wx-pop-current" : ""}">` +
        `<span class="wx-pop-hour">${String(h).padStart(2, "0")}:00</span>` +
        `<span class="wx-pop-icon">${wxIcon(w.code)}</span>` +
        `<span class="wx-pop-temp">${w.temp != null ? Math.round(w.temp) + "°" : "—"}</span>` +
        `<span class="wx-pop-precip">💧${w.precip != null ? w.precip.toFixed(1) : "—"}</span>` +
        `<span class="wx-pop-wind">🌬${w.wind != null ? Math.round(w.wind) : "—"}</span>` +
        `</div>`;
    }
    return html;
  }

  async function open() {
    const rect = trigger.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.right = `${window.innerWidth - rect.right}px`;
    pop.style.left = "";
    pop.innerHTML = `<div class="wx-pop-header">Loading…</div>`;
    pop.hidden = false;

    const dateStr = (typeof state !== "undefined" && state.date && state.date !== "today")
      ? state.date : "today";
    try {
      const res = await fetch(`/api/weather?date=${encodeURIComponent(dateStr)}`);
      if (!res.ok) throw new Error();
      const { hours } = await res.json();
      if (!hours) throw new Error();
      pop.innerHTML = renderHours(hours, dateStr);
      const cur = pop.querySelector(".wx-pop-current");
      if (cur) requestAnimationFrame(() => cur.scrollIntoView({ block: "center", behavior: "smooth" }));
    } catch {
      pop.innerHTML = `<div class="wx-pop-header" style="color:#a0a8b4">Weather unavailable</div>`;
    }
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.hidden ? open() : (pop.hidden = true);
  });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== trigger) pop.hidden = true;
  });
})();

// ── Header sequence ───────────────────────────────────────────────────────
// Desktop: weather always visible from load; brand fades out at 5s, bus art
//          fades in to brand position. Static after that.
// Mobile:  brand(3s) → art(2s) → weather(5s) → loop art↔weather forever.
(function () {
  const FADE_MS    = 400;
  const mq         = window.matchMedia("(max-width: 768px)");
  const meta       = document.querySelector(".header-brand-meta");
  const art        = document.querySelector(".bus-art");
  const weatherEl  = document.getElementById("header-weather");
  if (!meta || !art || !weatherEl) return;

  // Populate weather widget — shared by both paths. Refreshes every 5 min so
  // the displayed conditions track Open-Meteo's real-time current reading.
  function refreshWeatherWidget() {
    fetch("/api/weather?date=today")
      .then(r => r.json())
      .then(({ hours }) => {
        const klHour = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
        const w = hours[klHour] || hours[String(klHour)] || null;
        if (!w) return;
        const tempEl   = document.getElementById("wx-temp");
        const condEl   = document.getElementById("wx-cond");
        const precipEl = document.getElementById("wx-precip");
        const windEl   = document.getElementById("wx-wind");
        if (tempEl)   tempEl.textContent   = `${Math.round(w.temp)}°C`;
        if (condEl)   condEl.textContent   = w.label || "";
        if (precipEl) precipEl.textContent = `💧 ${w.precip != null ? w.precip.toFixed(1) : "--"} mm`;
        if (windEl)   windEl.textContent   = `🌬 ${w.wind != null ? Math.round(w.wind) : "--"} km/h`;
      })
      .catch(() => {});
  }
  refreshWeatherWidget();
  setInterval(refreshWeatherWidget, 5 * 60 * 1000);

  function fadeOut(el, cb) {
    el.style.transition = `opacity ${FADE_MS}ms`;
    el.style.opacity = "0";
    setTimeout(() => { el.style.display = "none"; if (cb) cb(); }, FADE_MS);
  }

  function fadeIn(el, displayVal, cb) {
    el.style.display = displayVal;
    el.getBoundingClientRect();
    el.style.transition = `opacity ${FADE_MS}ms`;
    el.style.opacity = "1";
    if (cb) setTimeout(cb, FADE_MS);
  }

  if (!mq.matches) {
    // ── DESKTOP ──────────────────────────────────────────────────────────
    // Weather on immediately, brand fades at 5s, bus art fades in. Done.
    fadeIn(weatherEl, "grid");
    setTimeout(() => {
      fadeOut(meta, () => fadeIn(art, "block"));
    }, 5000);

  } else {
    // ── MOBILE ───────────────────────────────────────────────────────────
    // brand(3s) → weather(5s) → bus(5s) → loop weather↔bus forever
    const SLOT_MS = 5000;

    function showWeather() {
      fadeIn(weatherEl, "grid", () => {
        setTimeout(() => fadeOut(weatherEl, showArt), SLOT_MS);
      });
    }
    function showArt() {
      fadeIn(art, "block", () => {
        setTimeout(() => fadeOut(art, showWeather), SLOT_MS);
      });
    }

    setTimeout(() => fadeOut(meta, showWeather), 3000);
  }
})();

// ── Mobile sidebar drawer ─────────────────────────────────────────────────
(function () {
  const sidebar = document.getElementById("sidebar");
  const btn     = document.getElementById("mobile-sidebar-btn");
  if (!btn || !sidebar) return;
  const mq = window.matchMedia("(max-width: 768px)");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    sidebar.classList.toggle("mobile-open");
  });
  document.addEventListener("click", (e) => {
    if (!mq.matches) return;
    if (sidebar.classList.contains("mobile-open") &&
        !sidebar.contains(e.target) && e.target !== btn) {
      sidebar.classList.remove("mobile-open");
    }
  });
  const dp = document.getElementById("heatmap-date-picker");
  if (dp) dp.addEventListener("change", () => {
    if (mq.matches) sidebar.classList.remove("mobile-open");
  });
})();

// ──────────────────────────────────────────────────────────────────────────
// Admin login
// ──────────────────────────────────────────────────────────────────────────
(function () {
  const SESSION_MS = APP_CONFIG.ADMIN_SESSION_TTL_MS;

  const loginForm   = document.getElementById("admin-login-form");
  const loggedInDiv = document.getElementById("admin-logged-in");
  const pwInput     = document.getElementById("admin-password");
  const loginBtn    = document.getElementById("admin-login-btn");
  const errorDiv    = document.getElementById("admin-login-error");
  const logoutBtn   = document.getElementById("admin-logout-btn");
  if (!loginForm || !loggedInDiv || !pwInput || !loginBtn || !logoutBtn) return;

  let _expiryTimer = null;

  function applyAdminState(unlocked) {
    document.body.classList.toggle("admin-unlocked", unlocked);
    loginForm.hidden   = unlocked;
    loggedInDiv.hidden = !unlocked;
    if (!unlocked) {
      pwInput.value = "";
      clearTimeout(_expiryTimer);
    }
  }

  function scheduleExpiry(ms) {
    clearTimeout(_expiryTimer);
    _expiryTimer = setTimeout(logout, ms);
  }

  async function logout() {
    try { await fetch("/api/admin/logout", { method: "POST" }); } catch (_) {}
    applyAdminState(false);
  }

  async function tryLogin() {
    loginBtn.disabled = true;
    try {
      const res  = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwInput.value }),
      });
      const data = await res.json();
      if (data.ok) {
        errorDiv.hidden = true;
        applyAdminState(true);
        scheduleExpiry(data.expiresIn || SESSION_MS);
      } else {
        errorDiv.textContent = data.error === "Admin not configured"
          ? "Admin not configured on server" : "Incorrect password";
        errorDiv.hidden = false;
        pwInput.select();
      }
    } catch (_) {
      errorDiv.textContent = "Server unreachable";
      errorDiv.hidden = false;
    } finally {
      loginBtn.disabled = false;
    }
  }

  // on load: ask server if cookie is still valid
  fetch("/api/admin/check")
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        applyAdminState(true);
        scheduleExpiry(SESSION_MS);
      }
    })
    .catch(() => {});

  loginBtn.addEventListener("click", tryLogin);
  pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryLogin(); });
  logoutBtn.addEventListener("click", logout);

  // Trip planner — calls /api/route and draws result on the MapLibre map
  const findBtn   = document.getElementById("trip-find-btn");
  const resultDiv = document.getElementById("trip-result");
  const originEl  = document.getElementById("trip-origin");
  const destEl    = document.getElementById("trip-destination");

  const ROUTE_SOURCE       = "trip-route";
  const ROUTE_LAYER        = "trip-route-line";
  const ROUTE_LAYER_BORDER = "trip-route-line-border";

  // HTML markers — maplibregl.Marker renders emoji reliably via DOM,
  // unlike symbol layers which use MapLibre's glyph renderer (no emoji support).
  let markerA = null;
  let markerB = null;

  function makeEmojiMarker(emoji, { flipX = false } = {}) {
    const el = document.createElement("div");
    el.style.cssText = "font-size:28px;line-height:1;cursor:default;user-select:none;" +
      (flipX ? "transform:scaleX(-1);" : "");
    el.textContent = emoji;
    return new maplibregl.Marker({ element: el, anchor: "bottom" });
  }

  function removeRouteLayer() {
    if (!map) return;
    [ROUTE_LAYER_BORDER, ROUTE_LAYER].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
    [ROUTE_SOURCE].forEach(id => { if (map.getSource(id)) map.removeSource(id); });
    if (markerA) { markerA.remove(); markerA = null; }
    if (markerB) { markerB.remove(); markerB = null; }
    setMapDim(false);
  }

  function drawRoute(geojson) {
    if (!map) return;
    removeRouteLayer();
    setMapDim(true);
    const coords = geojson.geometry.coordinates;

    map.addSource(ROUTE_SOURCE, { type: "geojson", data: geojson });
    // white border for contrast on dark/satellite tiles
    map.addLayer({
      id: ROUTE_LAYER_BORDER,
      type: "line",
      source: ROUTE_SOURCE,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": APP_CONFIG.ROUTE_BORDER_COLOR, "line-width": APP_CONFIG.ROUTE_BORDER_WIDTH, "line-opacity": APP_CONFIG.ROUTE_BORDER_OPACITY },
    });
    map.addLayer({
      id: ROUTE_LAYER,
      type: "line",
      source: ROUTE_SOURCE,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": APP_CONFIG.ROUTE_LINE_COLOR, "line-width": APP_CONFIG.ROUTE_LINE_WIDTH, "line-opacity": APP_CONFIG.ROUTE_LINE_OPACITY },
    });

    if (coords.length >= 2) {
      const [aLon, aLat] = coords[0];
      const [bLon, bLat] = coords[coords.length - 1];
      markerA = makeEmojiMarker("🚗", { flipX: bLon > aLon }).setLngLat([aLon, aLat]).addTo(map);
      markerB = makeEmojiMarker("🏁").setLngLat([bLon, bLat]).addTo(map);
    }

    // Fit map to the route
    if (coords.length > 1) {
      const lons = coords.map(c => c[0]);
      const lats = coords.map(c => c[1]);
      map.fitBounds(
        [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        { padding: 60, duration: 800 }
      );
    }
  }

  if (findBtn && resultDiv) {
    findBtn.addEventListener("click", async () => {
      const originQuery = originEl ? originEl.value.trim() : "";
      const destQuery   = destEl   ? destEl.value.trim()   : "";
      if (!originQuery || !destQuery) {
        resultDiv.textContent = "Enter both From and To.";
        return;
      }
      findBtn.disabled      = true;
      resultDiv.textContent = "Locating…";
      let originGeo, destGeo;
      try {
        [originGeo, destGeo] = await Promise.all([geocode(originQuery), geocode(destQuery)]);
      } catch (err) {
        resultDiv.textContent = err.message;
        findBtn.disabled = false;
        return;
      }
      function buildGeoLabel(originName, destName, suffix) {
        const span = document.createElement("span");
        span.style.cssText = "opacity:0.7;white-space:pre-line";
        span.textContent = `From: ${originName}\nTo: ${destName}`;
        const br = document.createElement("br");
        resultDiv.replaceChildren(span, br, document.createTextNode(suffix));
      }
      buildGeoLabel(originGeo.displayName, destGeo.displayName, "Routing…");
      try {
        const from = `${originGeo.lat},${originGeo.lon}`;
        const to   = `${destGeo.lat},${destGeo.lon}`;
        const res  = await fetch(`/api/route?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
        const data = await res.json();
        if (!res.ok || data.error) {
          resultDiv.textContent = data.error || "Routing failed.";
          removeRouteLayer();
          return;
        }
        const p = data.properties;
        const geoSpan = document.createElement("span");
        geoSpan.style.cssText = "opacity:0.7;white-space:pre-line";
        geoSpan.textContent = `From: ${originGeo.displayName}\nTo: ${destGeo.displayName}`;
        const statsSpan = document.createElement("span");
        statsSpan.style.opacity = "0.7";
        statsSpan.textContent = `${p.congestion_obs} bus observations used as congestion signal`;
        const distStrong = document.createElement("strong");
        distStrong.textContent = `${p.distance_km} km`;
        const durStrong = document.createElement("strong");
        durStrong.textContent = `~${p.duration_min} min`;
        resultDiv.replaceChildren(
          geoSpan,
          document.createElement("br"),
          document.createTextNode("📍 "), distStrong,
          document.createTextNode(" · 🕒 "), durStrong,
          document.createElement("br"),
          statsSpan
        );
        drawRoute(data);
      } catch (err) {
        resultDiv.textContent = "Network error — is the server running?";
      } finally {
        findBtn.disabled = false;
      }
    });
  }
})();

