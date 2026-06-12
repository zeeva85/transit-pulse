// router.js — OSM road graph + A* routing with live bus congestion weighting.
// Phase 1: KL bbox fetched first (~2 min), router goes live immediately.
// Phase 2: remaining Peninsular Malaysia tiles fetched in background, graph hot-swapped.
// Full graph cached to data/my-road-graph.json; KL interim to data/kl-road-graph.json.

const fetch  = require("node-fetch");
const fs     = require("fs");
const path   = require("path");
const config = require("./config");

const GRAPH_CACHE    = path.join(__dirname, "data", "my-road-graph.json");
const KL_CACHE       = path.join(__dirname, "data", "kl-road-graph.json");
const OVERPASS_MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const KL_BBOX = config.KL_BBOX;
const MY_BBOX = config.MY_BBOX;

// Free-flow speeds by OSM highway tag (km/h)
const ROAD_SPEEDS = {
  motorway: 110,  motorway_link: 70,
  trunk: 90,      trunk_link: 60,
  primary: 60,    primary_link: 50,
  secondary: 50,  secondary_link: 40,
  tertiary: 40,   tertiary_link: 35,
  residential: 30, unclassified: 30,
  living_street: 15,
};

const MAX_SPEED_KMH = 110; // used for A* heuristic

// ─── geometry ────────────────────────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;
const R_M     = 6_371_000;

function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) *
            Math.sin(dLon / 2) ** 2;
  return 2 * R_M * Math.asin(Math.sqrt(a));
}

// ─── Overpass fetch + graph build ────────────────────────────────────────────

// Split BBOX into a rows×cols grid so each tile stays under Node's ~512 MB string limit.
function bboxTiles(bbox, rows, cols) {
  const [s, w, n, e] = bbox.split(",").map(Number);
  const dLat = (n - s) / rows;
  const dLon = (e - w) / cols;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ts = (s + r * dLat).toFixed(4);
      const tw = (w + c * dLon).toFixed(4);
      const tn = (s + (r + 1) * dLat).toFixed(4);
      const te = (w + (c + 1) * dLon).toFixed(4);
      tiles.push(`${ts},${tw},${tn},${te}`);
    }
  }
  return tiles;
}

async function fetchOsmTile(bbox) {
  const query =
    `[out:json][timeout:180];` +
    `(way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link` +
    `|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street)$"]` +
    `(${bbox}););out body;>;out skel qt;`;

  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; MY-Bus-Router/1.0)",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const BODY = "data=" + encodeURIComponent(query);

  let lastErr;
  for (const mirror of OVERPASS_MIRRORS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[router]   mirror ${mirror.split("/")[2]} attempt ${attempt}…`);
        const res = await fetch(mirror, {
          method: "POST", headers: HEADERS, body: BODY, timeout: 210_000,
        });
        if (res.status === 504 || res.status === 503) {
          const msg = `HTTP ${res.status} (busy)`;
          if (attempt < 3) {
            console.log(`[router]   ${msg} — waiting ${config.ROUTER_504_WAIT / 1000} s…`);
            await new Promise(r => setTimeout(r, config.ROUTER_504_WAIT));
            continue;
          }
          throw new Error(msg);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return data;
      } catch (err) {
        lastErr = err;
        if (attempt < 3 && (err.message.includes("504") || err.message.includes("503"))) {
          console.log(`[router]   retrying after: ${err.message}`);
          await new Promise(r => setTimeout(r, config.ROUTER_504_WAIT));
        } else {
          console.warn(`[router]   mirror failed: ${err.message}`);
          break;
        }
      }
    }
  }
  throw new Error(`All mirrors failed for tile ${bbox}. Last: ${lastErr && lastErr.message}`);
}

// Fetch a list of tiles and build the graph incrementally. seedGraph (optional)
// pre-populates nodes/edges from an already-built graph (e.g. the KL cache) so
// phase 2 doesn't re-fetch the KL tile. seenEdges is intentionally omitted —
// duplicate edges from tile-border ways don't affect A* correctness and a
// string-keyed Set at peninsular scale costs ~1 GB.
async function fetchOsmGraph(tiles, seedGraph = null) {
  console.log(`[router] fetching ${tiles.length} tile(s)…`);

  const allNodeCoords = new Map();
  const adj           = new Map();
  let edgeCount = 0;

  // Pre-populate from seed (avoids re-fetching KL in phase 2)
  if (seedGraph) {
    for (const [id, ll] of Object.entries(seedGraph.nodes)) allNodeCoords.set(id, ll);
    for (const [id, nbrs] of Object.entries(seedGraph.edges)) {
      adj.set(id, nbrs);
      edgeCount += nbrs.length;
    }
    console.log(`[router] seeded from cache — nodes: ${allNodeCoords.size}, edges: ${edgeCount}`);
  }

  for (let i = 0; i < tiles.length; i++) {
    console.log(`[router] tile ${i + 1}/${tiles.length} ${tiles[i]}`);
    const data = await fetchOsmTile(tiles[i]);

    // Index this tile's nodes locally
    const tileNodes = new Map();
    for (const el of data.elements)
      if (el.type === "node") tileNodes.set(el.id, [el.lat, el.lon]);

    // Merge new nodes into global map
    for (const [id, ll] of tileNodes)
      if (!allNodeCoords.has(id)) allNodeCoords.set(id, ll);

    // Build edges from this tile's ways
    for (const el of data.elements) {
      if (el.type !== "way") continue;
      const nds = el.nodes.filter(id => tileNodes.has(id));
      if (nds.length < 2) continue;

      const highway   = (el.tags && el.tags.highway) || "unclassified";
      const speedKmh  = ROAD_SPEEDS[highway] || 30;
      const oneway    = el.tags && (
        el.tags.oneway === "yes" || el.tags.oneway === "1" ||
        el.tags.junction === "roundabout"
      );
      const onewayRev = el.tags && el.tags.oneway === "-1";

      for (let j = 0; j < nds.length - 1; j++) {
        const a = nds[j], b = nds[j + 1];
        const aLL = tileNodes.get(a), bLL = tileNodes.get(b);
        if (!aLL || !bLL) continue;
        const distM = haversineM(aLL[0], aLL[1], bLL[0], bLL[1]);
        if (distM < 0.5) continue;

        if (!onewayRev) {
          if (!adj.has(a)) adj.set(a, []);
          adj.get(a).push([b, Math.round(distM), speedKmh]);
          edgeCount++;
        }
        if (!oneway) {
          if (!adj.has(b)) adj.set(b, []);
          adj.get(b).push([a, Math.round(distM), speedKmh]);
          edgeCount++;
        }
      }
    }
    // data goes out of scope → eligible for GC before next tile fetch
    console.log(`[router] tile ${i + 1} done — nodes: ${allNodeCoords.size}, edges: ${edgeCount}`);
    if (i < tiles.length - 1) {
      console.log(`[router] pausing ${config.ROUTER_INTER_TILE_DELAY / 1000} s before next tile…`);
      await new Promise(r => setTimeout(r, config.ROUTER_INTER_TILE_DELAY));
    }
  }

  // Compact: only keep nodes that have at least one edge; stringify IDs
  const nodes = {}, edges = {};
  for (const [id, ll] of allNodeCoords) if (adj.has(id)) nodes[String(id)] = ll;
  for (const [id, nbrs] of adj) edges[String(id)] = nbrs;

  console.log(`[router] graph built: ${Object.keys(nodes).length} nodes, ${edgeCount} edges`);
  return { nodes, edges };
}

// ─── Spatial index (grid for nearest-node lookup) ────────────────────────────

const SPATIAL_CELL = 0.002; // ~200 m

function buildSpatialIndex(nodes) {
  const grid = new Map();
  for (const [id, [lat, lon]] of Object.entries(nodes)) {
    const key = `${Math.floor(lat / SPATIAL_CELL)},${Math.floor(lon / SPATIAL_CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push([id, lat, lon]);
  }
  return grid;
}

function nearestNode(grid, mainComponent, lat, lon) {
  const gr = Math.floor(lat / SPATIAL_CELL);
  const gc = Math.floor(lon / SPATIAL_CELL);

  let bestAny  = null, bestAnyDist  = Infinity; // absolute nearest fallback
  let bestMain = null, bestMainDist = Infinity; // nearest node in main component

  // Search ±4 cells (~1.6 km radius)
  for (let dr = -4; dr <= 4; dr++) {
    for (let dc = -4; dc <= 4; dc++) {
      const cell = grid.get(`${gr + dr},${gc + dc}`);
      if (!cell) continue;
      for (const [id, nLat, nLon] of cell) {
        const d = haversineM(lat, lon, nLat, nLon);
        if (d < bestAnyDist) { bestAnyDist = d; bestAny = id; }
        if (mainComponent.has(id) && d < bestMainDist) { bestMainDist = d; bestMain = id; }
      }
    }
  }

  if (bestMain) return { nodeId: bestMain, distM: bestMainDist };
  return { nodeId: bestAny, distM: bestAnyDist };
}

// ─── Congestion index (grid from live bus observations) ──────────────────────

const CONGESTION_CELL = 0.001; // ~100 m

function buildCongestionIndex(observations) {
  const grid = new Map();
  for (const obs of observations) {
    if (obs == null || obs.speed == null || obs.speed < 0) continue;
    const key =
      `${Math.floor(obs.lat / CONGESTION_CELL)},${Math.floor(obs.lon / CONGESTION_CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(obs.speed);
  }
  return grid;
}

function congestionSpeed(grid, lat, lon, freeFlowKmh) {
  if (!grid || grid.size === 0) return freeFlowKmh;
  const gr = Math.floor(lat / CONGESTION_CELL);
  const gc = Math.floor(lon / CONGESTION_CELL);
  const speeds = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const cell = grid.get(`${gr + dr},${gc + dc}`);
      if (cell) for (const s of cell) speeds.push(s);
    }
  }
  if (speeds.length === 0) return freeFlowKmh;
  speeds.sort((a, b) => a - b);
  const median = speeds[speeds.length >> 1];
  // floor at 5 km/h to avoid divide-by-zero; cap at free-flow
  return Math.max(5, Math.min(freeFlowKmh, median));
}

// ─── Min-heap priority queue ─────────────────────────────────────────────────

class MinHeap {
  constructor() { this._h = []; }
  get size() { return this._h.length; }
  push(item, pri) {
    this._h.push([pri, item]);
    this._up(this._h.length - 1);
  }
  pop() {
    const top = this._h[0][1];
    const last = this._h.pop();
    if (this._h.length) { this._h[0] = last; this._down(0); }
    return top;
  }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._h[p][0] <= this._h[i][0]) break;
      [this._h[p], this._h[i]] = [this._h[i], this._h[p]];
      i = p;
    }
  }
  _down(i) {
    const n = this._h.length;
    for (;;) {
      let m = i, l = 2 * i + 1, r = l + 1;
      if (l < n && this._h[l][0] < this._h[m][0]) m = l;
      if (r < n && this._h[r][0] < this._h[m][0]) m = r;
      if (m === i) break;
      [this._h[m], this._h[i]] = [this._h[i], this._h[m]];
      i = m;
    }
  }
}

// ─── A* ──────────────────────────────────────────────────────────────────────

function astar(edges, nodes, _fromId, _toId, congGrid) {
  // Normalise IDs to strings — spatial index returns strings, edge `to`
  // values are numbers in the cached JSON. Map uses strict equality so
  // mixing types causes a* to never detect arrival. Coerce once here.
  const fromId = String(_fromId);
  const toId   = String(_toId);

  if (fromId === toId) return null;

  const [toLat, toLon] = nodes[toId];
  const maxSpeedMs     = MAX_SPEED_KMH / 3.6;

  const gScore = new Map([[fromId, 0]]);
  const prev   = new Map();
  const heap   = new MinHeap();
  heap.push(fromId, 0);

  const MAX_SETTLED = config.ROUTER_MAX_SETTLED;
  let settled = 0;

  while (heap.size > 0 && settled < MAX_SETTLED) {
    const cur = heap.pop();
    settled++;
    if (cur === toId) break;

    const g = gScore.get(cur);
    if (g === undefined) continue;
    const [curLat, curLon] = nodes[cur];

    for (const [_nbr, distM, freeKmh] of (edges[cur] || [])) {
      const nbr = String(_nbr);
      const nn  = nodes[nbr];
      if (!nn) continue;
      const [nLat, nLon] = nn;

      const midLat = (curLat + nLat) / 2;
      const midLon = (curLon + nLon) / 2;
      const effMs  = congestionSpeed(congGrid, midLat, midLon, freeKmh) / 3.6;
      const edgeS  = distM / effMs;
      const ng     = g + edgeS;

      if (!gScore.has(nbr) || ng < gScore.get(nbr)) {
        gScore.set(nbr, ng);
        prev.set(nbr, cur);
        const h = haversineM(nLat, nLon, toLat, toLon) / maxSpeedMs;
        heap.push(nbr, ng + h);
      }
    }
  }

  if (!prev.has(toId) && fromId !== toId) return null;

  const path = [];
  for (let cur = toId; cur !== undefined; cur = prev.get(cur)) path.push(cur);
  path.reverse();
  return { path, travelTimeS: gScore.get(toId) || 0 };
}

// ─── Router class ────────────────────────────────────────────────────────────

class Router {
  constructor(graph) {
    this.edges         = graph.edges;
    this.nodes         = graph.nodes;
    this.spatialIndex  = buildSpatialIndex(graph.nodes);
    this.mainComponent = this._findMainComponent();
    console.log(`[router] main component: ${this.mainComponent.size} nodes`);
  }

  // BFS from a seed node near KL city centre to find the largest connected component.
  _findMainComponent() {
    // Seed: KL city centre (~3.148, 101.694). Find the nearest node with edges.
    const SEED_LAT = 3.148, SEED_LON = 101.694;
    let seedId = null, seedDist = Infinity;
    for (const [id, [lat, lon]] of Object.entries(this.nodes)) {
      if (!this.edges[id] || this.edges[id].length === 0) continue;
      const d = haversineM(lat, lon, SEED_LAT, SEED_LON);
      if (d < seedDist) { seedDist = d; seedId = id; }
    }
    if (!seedId) return new Set();

    const visited = new Set([seedId]);
    const queue   = [seedId];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      for (const [_nbr] of (this.edges[cur] || [])) {
        const nbr = String(_nbr);
        if (!visited.has(nbr)) {
          visited.add(nbr);
          queue.push(nbr);
        }
      }
    }
    return visited;
  }

  // Replace the graph in-place after background fetch completes.
  upgradeGraph(graph) {
    this.edges         = graph.edges;
    this.nodes         = graph.nodes;
    this.spatialIndex  = buildSpatialIndex(graph.nodes);
    this.mainComponent = this._findMainComponent();
    console.log(`[router] graph upgraded — main component: ${this.mainComponent.size} nodes`);
  }

  findRoute(fromLat, fromLon, toLat, toLon, busObservations = []) {
    const from = nearestNode(this.spatialIndex, this.mainComponent, fromLat, fromLon);
    const to   = nearestNode(this.spatialIndex, this.mainComponent, toLat,   toLon);
    if (!from.nodeId || !to.nodeId) return { error: "No nearby road found" };

    const congGrid = buildCongestionIndex(busObservations);
    const result   = astar(this.edges, this.nodes, from.nodeId, to.nodeId, congGrid);
    if (!result) return { error: "No route found between those points" };

    const coords = result.path.map(id => {
      const [lat, lon] = this.nodes[id];
      return [lon, lat]; // GeoJSON [lon, lat]
    });

    let distM = 0;
    for (let i = 1; i < result.path.length; i++) {
      const [aLat, aLon] = this.nodes[result.path[i - 1]];
      const [bLat, bLon] = this.nodes[result.path[i]];
      distM += haversineM(aLat, aLon, bLat, bLon);
    }

    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {
        distance_km:       Math.round(distM / 100) / 10,
        duration_min:      Math.round(result.travelTimeS / 60),
        congestion_obs:    busObservations.length,
        snap_from_m:       Math.round(from.distM),
        snap_to_m:         Math.round(to.distM),
      },
    };
  }
}

// ─── streaming graph write (avoids JSON.stringify peak allocation) ────────────

async function writeGraphStreaming(filePath, graph) {
  const { once } = require("events");
  const tmp = filePath + ".tmp";
  const s = fs.createWriteStream(tmp);
  // Honor backpressure: this function exists to avoid JSON.stringify's peak
  // allocation for the multi-hundred-MB Malaysia graph, but ignoring the
  // write() return meant the whole serialized graph piled up in the stream's
  // in-memory queue anyway when the disk lagged — OOM risk in the exact
  // FULL_MALAYSIA_GRAPH scenario it was written for.
  const w = async (chunk) => {
    if (!s.write(chunk)) await once(s, "drain");
  };
  await w('{"nodes":{');
  let first = true;
  for (const [id, ll] of Object.entries(graph.nodes)) {
    await w(`${first ? "" : ","}"${id}":[${ll[0]},${ll[1]}]`);
    first = false;
  }
  await w('},"edges":{');
  first = true;
  for (const [id, nbrs] of Object.entries(graph.edges)) {
    await w(`${first ? "" : ","}"${id}":${JSON.stringify(nbrs)}`);
    first = false;
  }
  await w("}}");
  await new Promise((resolve, reject) => {
    s.on("error", reject);
    s.end(() => {
      fs.rename(tmp, filePath, (err) => (err ? reject(err) : resolve()));
    });
  });
}

// ─── init ─────────────────────────────────────────────────────────────────────

async function initRouter() {
  fs.mkdirSync(path.dirname(GRAPH_CACHE), { recursive: true });

  // ── Full graph already cached → load and return immediately ──────────────────
  if (fs.existsSync(GRAPH_CACHE)) {
    console.log("[router] loading cached Peninsular Malaysia graph…");
    const graph = JSON.parse(fs.readFileSync(GRAPH_CACHE, "utf8"));
    console.log(`[router] ${Object.keys(graph.nodes).length} nodes ready`);
    return new Router(graph);
  }

  // ── Phase 1: KL graph → router goes live in ~2 min ───────────────────────────
  let klGraph;
  if (fs.existsSync(KL_CACHE)) {
    console.log("[router] loading cached KL graph (phase 1)…");
    klGraph = JSON.parse(fs.readFileSync(KL_CACHE, "utf8"));
    if (klGraph.bbox !== KL_BBOX) {
      console.log(`[router] bbox changed (${klGraph.bbox} → ${KL_BBOX}) — rebuilding cache…`);
      fs.unlinkSync(KL_CACHE);
      klGraph = null;
    }
  }
  if (!klGraph) {
    console.log("[router] fetching KL graph (phase 1)…");
    klGraph = await fetchOsmGraph([KL_BBOX]);
    klGraph.bbox = KL_BBOX;
    fs.writeFileSync(KL_CACHE, JSON.stringify(klGraph));
    console.log("[router] KL graph cached →", KL_CACHE);
  }
  const router = new Router(klGraph);

  // ── Phase 2: remaining tiles → only when FULL_MALAYSIA_GRAPH=true ────────────
  // Requires ~3 GB RAM. Disabled on Railway (low-memory containers) by default.
  // Set FULL_MALAYSIA_GRAPH=true in .env or shell to enable locally.
  if (process.env.FULL_MALAYSIA_GRAPH === "true") {
    console.log("[router] ✓ KL trip planner ready — fetching rest of Malaysia in background…");
    const remainingTiles = bboxTiles(MY_BBOX, config.ROUTER_TILE_ROWS, config.ROUTER_TILE_COLS).filter(tile => {
      const [s, w, n, e] = tile.split(",").map(Number);
      const [ks, kw, kn, ke] = KL_BBOX.split(",").map(Number);
      return !(s < kn && n > ks && w < ke && e > kw);
    });
    (async () => {
      try {
        const klSeed = JSON.parse(fs.readFileSync(KL_CACHE, "utf8"));
        const fullGraph = await fetchOsmGraph(remainingTiles, klSeed);
        await writeGraphStreaming(GRAPH_CACHE, fullGraph);
        console.log("[router] graph cached →", GRAPH_CACHE);
        router.upgradeGraph(fullGraph);
        console.log("[router] ✓ Peninsular Malaysia trip planner ready");
        if (fs.existsSync(KL_CACHE)) fs.unlinkSync(KL_CACHE);
      } catch (err) {
        console.error("[router] background fetch failed:", err.message);
      }
    })();
  } else {
    console.log("[router] ✓ KL trip planner ready (set FULL_MALAYSIA_GRAPH=true to expand)");
  }

  return router;
}

module.exports = { initRouter };
