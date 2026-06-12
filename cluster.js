// Hierarchical clustering of routes by their (mode × hour) heatmap signature.
// Hand-rolled agglomerative algorithm with two linkage strategies:
//   - Ward (used for Euclidean distance) — minimizes within-cluster variance
//   - Average (used for correlation distance) — Lance-Williams average update
// Mirrors busapp/ui/timeline.py:_cluster_routes_with_ids.
//
// Implementation notes:
//   * N ≈ 80 routes in the worst case, so O(N³) agglomerative is fine
//     (~500k ops, <100 ms in Node).
//   * Distance updates use the Lance-Williams formula so we never touch the
//     original feature matrix after building the distance matrix.
//   * Cluster IDs are renumbered 1..K in the *visual leaves-order* of the
//     dendrogram so cluster 1 is always the leftmost band in the heatmap.

const { buildHeatmap, buildHistoricalHeatmap } = require("./heatmap");
const { computePooledMedians } = require("./pooled");
const { loadDate } = require("./store");

// All 5 modes (Python _STACKED_MODES parity). The pre-fix version used 4
// (no `corrected`) — clustering features were therefore 96-dim instead of
// Python's 120-dim, and routes that diverge primarily in their corrected
// signal landed in the wrong cluster.
const MODES = ["raw", "corrected", "calc", "kalman", "trust"];

// ──────────────────────────────────────────────────────────────────────────
// Feature matrix construction
// ──────────────────────────────────────────────────────────────────────────

// Pull median speeds for every route × hour × mode out of the accumulator.
// Routes missing a particular (mode, hour) cell get column-mean fill — same
// behaviour as `_hierarchical_link` in the Python port.
//
// `anchors` is an optional `{mode: anchor_kmh}` map (from pooled medians).
// When supplied, each mode's bin edges are scaled by `anchor/physical_anchor`
// — same convention Python uses via _resolve_anchor — so cluster features
// reflect the active anchor choice instead of always-physical.
//
// `date` is an optional historical YYYY-MM-DD string. When non-null and not
// "today", features come from `buildHistoricalHeatmap` for that date —
// matching Python compute_route_clusters which takes a source dataframe
// and can be fed either today's live data or any historical date's parquet.
async function buildFeatureMatrix(anchors = null, date = null) {
  const wantsHistorical = date && date !== "today";
  const modeData = {};
  for (const mode of MODES) {
    // > 0 (not just != null): zero pooled anchors collapse bin edges — mirror Python's `if v and v > 0`.
    const anchor = anchors && anchors[mode] > 0 ? anchors[mode] : null;
    if (wantsHistorical) {
      const hist = await buildHistoricalHeatmap(date, loadDate, { mode, anchor });
      // No data for that date → empty stub so downstream loops are no-ops.
      modeData[mode] = hist || { routes: [], cells: [] };
    } else {
      modeData[mode] = buildHeatmap({ mode, anchor });
    }
  }

  const routeSet = new Set();
  for (const mode of MODES) for (const r of modeData[mode].routes) routeSet.add(r);
  const routes = [...routeSet].sort();
  if (routes.length < 3) return { routes, features: [], hasData: false };

  // Pre-bucket cells per (mode, route).
  const cellsByModeRoute = {};
  for (const mode of MODES) {
    const out = {};
    for (const c of modeData[mode].cells) {
      const route = modeData[mode].routes[c.r];
      if (!out[route]) out[route] = {};
      out[route][c.h] = c.v;
    }
    cellsByModeRoute[mode] = out;
  }

  // 5 modes × 24 hours = 120 features per route.
  const numCols = MODES.length * 24;
  const features = [];
  for (const route of routes) {
    const vec = new Array(numCols);
    let col = 0;
    for (const mode of MODES) {
      const hours = cellsByModeRoute[mode][route] || {};
      for (let h = 0; h < 24; h++) vec[col++] = h in hours ? hours[h] : null;
    }
    features.push(vec);
  }

  // Column-mean fill (only on non-null entries).
  const colMean = new Array(numCols).fill(0);
  const colCount = new Array(numCols).fill(0);
  for (const row of features) {
    for (let j = 0; j < numCols; j++) {
      if (row[j] != null) {
        colMean[j] += row[j];
        colCount[j] += 1;
      }
    }
  }
  for (let j = 0; j < numCols; j++) {
    colMean[j] = colCount[j] > 0 ? colMean[j] / colCount[j] : 0;
  }
  for (const row of features) {
    for (let j = 0; j < numCols; j++) if (row[j] == null) row[j] = colMean[j];
  }

  return { routes, features, hasData: true };
}

// ──────────────────────────────────────────────────────────────────────────
// Distance functions
// ──────────────────────────────────────────────────────────────────────────

function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function pearson(a, b) {
  const n = a.length;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

function correlationDistance(a, b) {
  return 1 - pearson(a, b);
}

function pairwiseDistances(features, distFn) {
  const n = features.length;
  const D = new Array(n);
  for (let i = 0; i < n; i++) D[i] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = distFn(features[i], features[j]);
      D[i][j] = d;
      D[j][i] = d;
    }
  }
  return D;
}

// ──────────────────────────────────────────────────────────────────────────
// Agglomerative clustering with Lance-Williams updates
// ──────────────────────────────────────────────────────────────────────────

function agglomerative(D, method) {
  const n = D.length;
  // size[id] — number of original points contained in cluster `id`.
  // Cluster ids 0..n-1 are the originals; merges create ids n..2n-2.
  const size = new Array(2 * n - 1).fill(0);
  for (let i = 0; i < n; i++) size[i] = 1;

  // Pairwise distances between currently-active clusters. Keyed "a|b" with a<b.
  const dist = new Map();
  const active = new Set();
  for (let i = 0; i < n; i++) {
    active.add(i);
    for (let j = i + 1; j < n; j++) dist.set(`${i}|${j}`, D[i][j]);
  }

  const merges = []; // [{ left, right, dist, size }] in merge order
  let nextId = n;

  while (active.size > 1) {
    // Find the minimum-distance pair among active clusters. O(active²); we
    // accept this since N is small.
    const ids = [...active];
    let bestA = -1, bestB = -1, bestD = Infinity;
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i];
      for (let j = i + 1; j < ids.length; j++) {
        const b = ids[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const d = dist.get(key);
        if (d != null && d < bestD) {
          bestD = d;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0) break;

    const newId = nextId++;
    size[newId] = size[bestA] + size[bestB];
    merges.push({ left: bestA, right: bestB, dist: bestD, size: size[newId] });

    active.delete(bestA);
    active.delete(bestB);
    const nA = size[bestA];
    const nB = size[bestB];
    const dAB = bestD;

    for (const c of active) {
      const keyAC = bestA < c ? `${bestA}|${c}` : `${c}|${bestA}`;
      const keyBC = bestB < c ? `${bestB}|${c}` : `${c}|${bestB}`;
      const dAC = dist.get(keyAC);
      const dBC = dist.get(keyBC);
      const nC = size[c];

      let dNew;
      if (method === "ward") {
        dNew = Math.sqrt(
          ((nA + nC) * dAC * dAC +
            (nB + nC) * dBC * dBC -
            nC * dAB * dAB) /
            (nA + nB + nC)
        );
      } else if (method === "average") {
        dNew = (nA * dAC + nB * dBC) / (nA + nB);
      } else {
        throw new Error(`unknown linkage method: ${method}`);
      }

      const newKey = newId < c ? `${newId}|${c}` : `${c}|${newId}`;
      dist.set(newKey, dNew);
      dist.delete(keyAC);
      dist.delete(keyBC);
    }
    // Pair AB is already gone via the active.delete + nobody re-reads it.
    active.add(newId);
  }

  return { merges, originalN: n };
}

// ──────────────────────────────────────────────────────────────────────────
// Tree utilities — leaves order + cluster cut at K
// ──────────────────────────────────────────────────────────────────────────

function leavesOf({ merges, originalN }, rootId) {
  const out = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (id < originalN) {
      out.push(id);
    } else {
      const m = merges[id - originalN];
      // Push left after right so left ends up first when popping.
      stack.push(m.right);
      stack.push(m.left);
    }
  }
  return out;
}

function leavesOrder(tree) {
  if (tree.originalN === 0) return [];
  if (tree.originalN === 1) return [0];
  const topId = tree.originalN + tree.merges.length - 1;
  return leavesOf(tree, topId);
}

// fcluster(criterion="maxclust") equivalent. Walk the dendrogram from the
// top, splitting the highest-distance merge each iteration, until K open
// subtrees remain.
function cutTree(tree, k) {
  const { merges, originalN } = tree;
  if (merges.length === 0) {
    return originalN === 1 ? [1] : [];
  }
  const topId = originalN + merges.length - 1;
  let openRoots = [topId];

  while (openRoots.length < k && openRoots.length > 0) {
    let pickIdx = -1;
    let pickDist = -Infinity;
    for (let i = 0; i < openRoots.length; i++) {
      const id = openRoots[i];
      if (id < originalN) continue;
      const m = merges[id - originalN];
      if (m.dist > pickDist) {
        pickDist = m.dist;
        pickIdx = i;
      }
    }
    if (pickIdx < 0) break; // every open root is a leaf — can't split further
    const splitId = openRoots[pickIdx];
    const m = merges[splitId - originalN];
    openRoots.splice(pickIdx, 1, m.left, m.right);
  }

  const labels = new Array(originalN).fill(0);
  for (let i = 0; i < openRoots.length; i++) {
    for (const leaf of leavesOf(tree, openRoots[i])) labels[leaf] = i + 1;
  }
  return labels;
}

// ──────────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────────

// Compute the clustered hour order (hours × (mode × route) feature pivot).
// Mirrors Python timeline.py:_cluster_hours — features for hour `h` are
// every route's median speed at hour `h` across all 5 modes. Returns the
// 24 hour indices in dendrogram-leaves order. Uses average linkage with the
// requested metric (Ward + Euclidean for "euclidean"; average + correlation
// for "correlation").
async function computeHourOrder({ metric = "euclidean", anchorMode = "physical", date = null } = {}) {
  let anchors = null;
  if (anchorMode === "pooled") {
    try {
      const pooled = await computePooledMedians();
      anchors = pooled && pooled.anchors ? pooled.anchors : null;
    } catch {
      anchors = null;
    }
  }
  // Reuse the same route-by-mode heatmap pull buildFeatureMatrix uses; we
  // just transpose: rows = hours, cols = (mode × route).
  const wantsHistorical = date && date !== "today";
  const modeData = {};
  const routesUnion = new Set();
  for (const mode of MODES) {
    // > 0 (not just != null): zero pooled anchors collapse bin edges — mirror Python's `if v and v > 0`.
    const anchor = anchors && anchors[mode] > 0 ? anchors[mode] : null;
    if (wantsHistorical) {
      const hist = await buildHistoricalHeatmap(date, loadDate, { mode, anchor });
      modeData[mode] = hist || { routes: [], cells: [] };
    } else {
      modeData[mode] = buildHeatmap({ mode, anchor });
    }
    for (const r of modeData[mode].routes) routesUnion.add(r);
  }
  const routes = [...routesUnion].sort();
  if (routes.length < 2) return Array.from({ length: 24 }, (_, i) => i);

  // Build a 24 × (5 × routes.length) feature matrix. Empty cells stay null;
  // fall back to column mean below.
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const numCols = MODES.length * routes.length;
  const features = hours.map(() => new Array(numCols).fill(null));

  // O(1) column lookup — routes.indexOf inside the cells loop was an O(R)
  // scan per cell (~10k cells × ~80 routes).
  const colByRoute = new Map(routes.map((r, i) => [r, i]));
  for (let m = 0; m < MODES.length; m++) {
    const mode = MODES[m];
    const md = modeData[mode];
    for (const c of md.cells) {
      const route = md.routes[c.r];
      const colInUnion = colByRoute.has(route) ? colByRoute.get(route) : -1;
      if (colInUnion < 0) continue;
      const col = m * routes.length + colInUnion;
      const hourRow = c.h;
      if (features[hourRow]) features[hourRow][col] = c.v;
    }
  }

  // Column-mean fill (only over non-null entries).
  const colMean = new Array(numCols).fill(0);
  const colCount = new Array(numCols).fill(0);
  for (const row of features) {
    for (let j = 0; j < numCols; j++) {
      if (row[j] != null) {
        colMean[j] += row[j];
        colCount[j] += 1;
      }
    }
  }
  for (let j = 0; j < numCols; j++) {
    colMean[j] = colCount[j] > 0 ? colMean[j] / colCount[j] : 0;
  }
  for (const row of features) {
    for (let j = 0; j < numCols; j++) if (row[j] == null) row[j] = colMean[j];
  }

  const distFn = metric === "correlation" ? correlationDistance : euclidean;
  const method = metric === "correlation" ? "average" : "ward";
  const D = pairwiseDistances(features, distFn);
  const tree = agglomerative(D, method);
  return leavesOrder(tree); // already 0..23 indices since the input rows are hours
}

async function computeRouteClusters({
  metric = "euclidean",
  k = 6,
  anchorMode = "physical",
  date = null,
} = {}) {
  // When anchor mode is pooled, fetch the pooled medians and feed them into
  // the feature matrix so the bin scaling matches what the heatmap shows.
  let anchors = null;
  if (anchorMode === "pooled") {
    try {
      const pooled = await computePooledMedians();
      anchors = pooled && pooled.anchors ? pooled.anchors : null;
    } catch {
      anchors = null;
    }
  }
  const { routes, features, hasData } = await buildFeatureMatrix(anchors, date);
  if (!hasData || routes.length < 2) {
    return {
      routes,
      order: routes,
      cluster_by_route: {},
      k: 0,
      metric,
    };
  }

  const distFn = metric === "correlation" ? correlationDistance : euclidean;
  const method = metric === "correlation" ? "average" : "ward";
  const D = pairwiseDistances(features, distFn);
  const tree = agglomerative(D, method);
  const order = leavesOrder(tree);
  const rawLabels = cutTree(tree, k);

  // Renumber 1..K in visual order — cluster 1 is the leftmost band in the
  // heatmap, matching the Python convention.
  const seen = new Map();
  const finalLabels = new Array(routes.length).fill(0);
  for (const idx of order) {
    const raw = rawLabels[idx];
    if (raw === 0) continue;
    if (!seen.has(raw)) seen.set(raw, seen.size + 1);
    finalLabels[idx] = seen.get(raw);
  }

  const clusterByRoute = {};
  for (let i = 0; i < routes.length; i++) {
    clusterByRoute[routes[i]] = finalLabels[i];
  }

  return {
    routes,
    order: order.map((i) => routes[i]), // route labels in clustered order
    cluster_by_route: clusterByRoute,
    k: seen.size,
    metric,
  };
}

module.exports = {
  computeRouteClusters,
  computeHourOrder,
  // Exported for tests:
  _internals: {
    buildFeatureMatrix,
    pairwiseDistances,
    agglomerative,
    leavesOrder,
    cutTree,
    euclidean,
    correlationDistance,
  },
};
