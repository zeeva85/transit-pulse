// Trail snapping to GTFS shape polylines. Port of busapp/geo.py +
// busapp/ui/trails.py (`compute_snap_paths_for_pairs`).
//
// Given a bus's GPS trail and its assigned route, projects each consecutive
// pair onto the route's polyline candidates and emits a curved sub-path
// that follows the road, rather than a straight line between the two GPS
// points. Falls back to a straight chord when no candidate matches within
// the perpendicular-distance threshold, or to a "gap" when the chord would
// be implausibly long.
//
// All math is in meters via a small-area equirectangular projection around
// KL — same approximation Python uses, accurate to < 1 m at city zoom.

const SNAP_PERP_THRESHOLD_M = 200;       // cross-route fallback
const SNAP_OWN_ROUTE_THRESHOLD_M = 400;  // own-route candidates (GPS noise headroom)
const MAX_FALLBACK_CHORD_M = 3000; // Pass-19 cap from Python
// Pass-18 stickiness: prefer the bus's previously-chosen shape when its avg
// perp is within this much of the closest candidate. Suppresses spurious
// outbound↔inbound flipping on routes whose two variants run along the same
// road (the WUX5618 / WVN5432 case in Python).
const SNAP_STICKINESS_THRESHOLD_M = 30;

const KL_REF_LAT = 3.139;
const KL_REF_LON = 101.6869;
// Match Python's `latlon_to_meters`: R · π/180 with R = 6 371 000.
const M_PER_DEG_LAT = (6371000 * Math.PI) / 180;
const COS_REF_LAT = Math.cos((KL_REF_LAT * Math.PI) / 180);

function latlonToMeters(lat, lon) {
  return [
    (lon - KL_REF_LON) * M_PER_DEG_LAT * COS_REF_LAT,
    (lat - KL_REF_LAT) * M_PER_DEG_LAT,
  ];
}

// Precompute (xy, cumdist) arrays for one polyline. xy is the vertex
// positions in local meters; cumdist[i] is the arc-length to vertex i.
function buildShapeGeometry(polylineLatLon) {
  const n = polylineLatLon.length;
  const xy = new Array(n);
  const cumdist = new Array(n);
  if (n === 0) return { xy, cumdist };
  const [lon0, lat0] = polylineLatLon[0];
  xy[0] = latlonToMeters(lat0, lon0);
  cumdist[0] = 0;
  for (let i = 1; i < n; i++) {
    const [lon, lat] = polylineLatLon[i];
    xy[i] = latlonToMeters(lat, lon);
    const dx = xy[i][0] - xy[i - 1][0];
    const dy = xy[i][1] - xy[i - 1][1];
    cumdist[i] = cumdist[i - 1] + Math.sqrt(dx * dx + dy * dy);
  }
  return { xy, cumdist };
}

// Project a single (px, py) point in meters onto the polyline. Returns
// { cumdist, perp } — the arc-length from polyline start to the projection,
// and the perpendicular distance to that projection.
function projectPointToPolyline(px, py, xy, cumdist) {
  if (xy.length < 2) return { cumdist: 0, perp: Infinity };
  let bestPerpSq = Infinity;
  let bestCum = 0;
  for (let i = 0; i < xy.length - 1; i++) {
    const ax = xy[i][0], ay = xy[i][1];
    const bx = xy[i + 1][0], by = xy[i + 1][1];
    const dx = bx - ax, dy = by - ay;
    const segLenSq = dx * dx + dy * dy;
    let t = 0;
    if (segLenSq > 0) {
      t = ((px - ax) * dx + (py - ay) * dy) / segLenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    const perpSq = (px - projX) ** 2 + (py - projY) ** 2;
    if (perpSq < bestPerpSq) {
      bestPerpSq = perpSq;
      const segLen = Math.sqrt(segLenSq);
      bestCum = cumdist[i] + t * segLen;
    }
  }
  return { cumdist: bestCum, perp: Math.sqrt(bestPerpSq) };
}

// Return the sub-polyline between two arc-lengths. Endpoints are
// interpolated when they don't land on a vertex. Output stays in
// [lon, lat] coordinates ready to feed a PathLayer.
function slicePolyline(polylineLatLon, cumdist, dStart, dEnd) {
  if (dStart > dEnd) return [];
  const n = polylineLatLon.length;
  if (n === 0 || cumdist.length !== n) return [];
  const total = cumdist[n - 1];
  if (total <= 0) return [polylineLatLon[0].slice()];

  dStart = Math.max(0, Math.min(total, dStart));
  dEnd = Math.max(0, Math.min(total, dEnd));

  function interp(i, d) {
    const segLen = cumdist[i + 1] - cumdist[i];
    if (segLen <= 0) return polylineLatLon[i].slice();
    const t = (d - cumdist[i]) / segLen;
    const [lon1, lat1] = polylineLatLon[i];
    const [lon2, lat2] = polylineLatLon[i + 1];
    return [lon1 + t * (lon2 - lon1), lat1 + t * (lat2 - lat1)];
  }

  // First segment containing dStart.
  let startI = 0;
  while (startI < n - 1 && cumdist[startI + 1] < dStart) startI++;

  const out = [interp(startI, dStart)];
  for (let i = startI + 1; i < n; i++) {
    if (cumdist[i] >= dEnd) {
      out.push(interp(i - 1, dEnd));
      return out;
    }
    out.push(polylineLatLon[i].slice());
  }
  return out;
}

const EARTH_R_KM = 6371.0088;
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.sqrt(a));
}

// Snapper factory — wires up shape lookups and caches precomputed geometry.
// `shapesById`: { shape_id: [[lon, lat], …] }
// `shapesByRoute`: { route_label: [shape_id, …] }
function createSnapper(shapesById, shapesByRoute) {
  const geomCache = new Map();
  // Bounding box (with 200m padding in degrees ≈ 0.0018) per shape, for
  // the cross-route fallback's pre-filter so we don't project against
  // every one of the 180 shapes for each pair.
  const BBOX_PAD_DEG = 200 / 111000;
  const bboxCache = new Map();

  function getGeom(shapeId) {
    let g = geomCache.get(shapeId);
    if (g !== undefined) return g;
    const poly = shapesById[shapeId];
    if (!poly) {
      geomCache.set(shapeId, null);
      return null;
    }
    g = buildShapeGeometry(poly);
    geomCache.set(shapeId, g);
    return g;
  }

  function getBbox(shapeId) {
    let b = bboxCache.get(shapeId);
    if (b !== undefined) return b;
    const poly = shapesById[shapeId];
    if (!poly || poly.length === 0) {
      bboxCache.set(shapeId, null);
      return null;
    }
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of poly) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    b = { minLon, maxLon, minLat, maxLat };
    bboxCache.set(shapeId, b);
    return b;
  }

  function bboxContains(bbox, lon, lat) {
    if (!bbox) return false;
    return (
      lon >= bbox.minLon - BBOX_PAD_DEG &&
      lon <= bbox.maxLon + BBOX_PAD_DEG &&
      lat >= bbox.minLat - BBOX_PAD_DEG &&
      lat <= bbox.maxLat + BBOX_PAD_DEG
    );
  }

  // Try every candidate shape and collect successful projections. If
  // `previousShapeId` is given and its avg perp is within the stickiness
  // threshold of the closest candidate, prefer it — same Pass-18 rule
  // Python's snap_augment_parquet uses.
  function snapPair(lon1, lat1, lon2, lat2, candidateShapeIds, previousShapeId = null, perpThreshold = SNAP_PERP_THRESHOLD_M) {
    const [px1, py1] = latlonToMeters(lat1, lon1);
    const [px2, py2] = latlonToMeters(lat2, lon2);
    const matches = []; // { sid, avg, dLo, dHi, reversed }
    for (const sid of candidateShapeIds) {
      const g = getGeom(sid);
      if (!g || g.xy.length < 2) continue;
      const proj1 = projectPointToPolyline(px1, py1, g.xy, g.cumdist);
      const proj2 = projectPointToPolyline(px2, py2, g.xy, g.cumdist);
      if (proj1.perp > perpThreshold) continue;
      if (proj2.perp > perpThreshold) continue;
      const avg = (proj1.perp + proj2.perp) / 2;
      matches.push({
        sid,
        avg,
        dLo: Math.min(proj1.cumdist, proj2.cumdist),
        dHi: Math.max(proj1.cumdist, proj2.cumdist),
        reversed: proj1.cumdist > proj2.cumdist,
      });
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => a.avg - b.avg);
    let pick = matches[0];
    if (previousShapeId) {
      const prev = matches.find((m) => m.sid === previousShapeId);
      if (prev && prev.avg <= matches[0].avg + SNAP_STICKINESS_THRESHOLD_M) {
        pick = prev;
      }
    }
    let sub = slicePolyline(shapesById[pick.sid], getGeom(pick.sid).cumdist, pick.dLo, pick.dHi);
    if (pick.reversed) sub = sub.reverse();
    if (sub.length < 2) return null;
    return { path: sub, shape_id: pick.sid };
  }

  // Fallback: search every shape whose bounding box covers both endpoints.
  // Slower than the per-route path, so only called when that fails.
  // Mirrors Python `_snap_pair_cross_route`.
  function snapPairCrossRoute(lon1, lat1, lon2, lat2) {
    const candidateIds = [];
    for (const sid of Object.keys(shapesById)) {
      const bbox = getBbox(sid);
      if (bboxContains(bbox, lon1, lat1) && bboxContains(bbox, lon2, lat2)) {
        candidateIds.push(sid);
      }
    }
    if (candidateIds.length === 0) return null;
    return snapPair(lon1, lat1, lon2, lat2, candidateIds);
  }

  // Snap a full trail. Returns one entry per consecutive pair:
  //   { path: [[lon, lat], …] | null, source: "on_route" | "cross_route" |
  //     "fallback" | "gap" }
  // The renderer consumes the array index-aligned with the source trail (so
  // out[i] covers trail[i]→trail[i+1]); per-pair timestamps live on the
  // trail itself and don't need to be duplicated here.
  // Caller decides how to render gaps (draw nothing or a faint chord).
  function snapTrail(trail, routeLabel) {
    const out = [];
    if (!trail || trail.length < 2) return out;
    const candidates = shapesByRoute[routeLabel] || [];
    // Track the previously-chosen shape across the trail so the Pass-18
    // stickiness rule can suppress spurious outbound↔inbound flipping when
    // both variants run along the same road.
    let prevShapeId = null;
    for (let i = 0; i < trail.length - 1; i++) {
      const p1 = trail[i];
      const p2 = trail[i + 1];
      if (p1.lat == null || p1.lon == null || p2.lat == null || p2.lon == null) {
        continue;
      }

      // Fast path: both points have the same precomputed snap_shape_id (set by
      // Python snap_augment_parquet or JS augmentation). Slice the polyline
      // directly — no distance projection needed.
      if (
        p1.snap_shape_id && p2.snap_shape_id &&
        p1.snap_shape_id === p2.snap_shape_id &&
        p1.snap_cumdist != null && p2.snap_cumdist != null
      ) {
        const poly = shapesById[p1.snap_shape_id];
        const geom = getGeom(p1.snap_shape_id);
        if (poly && geom) {
          const dLo = Math.min(p1.snap_cumdist, p2.snap_cumdist);
          const dHi = Math.max(p1.snap_cumdist, p2.snap_cumdist);
          const sub = slicePolyline(poly, geom.cumdist, dLo, dHi);
          const reversed = p1.snap_cumdist > p2.snap_cumdist;
          if (sub.length >= 2) {
            prevShapeId = p1.snap_shape_id;
            out.push({ path: reversed ? sub.reverse() : sub, source: "on_route" });
            continue;
          }
        }
      }

      let snapped = null;
      if (candidates.length > 0) {
        // Use a more generous threshold for the bus's own route shapes — GPS
        // noise in KL's urban canyons can push readings 200–400m from the
        // GTFS centreline.  Cross-route fallback keeps the tighter 200m so we
        // don't snap to a parallel road on a different line.
        snapped = snapPair(p1.lon, p1.lat, p2.lon, p2.lat, candidates, prevShapeId, SNAP_OWN_ROUTE_THRESHOLD_M);
      }
      // Cross-route fallback when the bus's assigned route's shapes don't
      // match (off-route GPS, route reassignment, learned-shape buses, …).
      // Recovers about 4–5% of pairs on a typical day.
      let crossRoute = false;
      if (!snapped) {
        const cross = snapPairCrossRoute(p1.lon, p1.lat, p2.lon, p2.lat);
        if (cross) {
          snapped = cross;
          crossRoute = true;
        }
      }
      if (snapped) {
        prevShapeId = snapped.shape_id;
        out.push({
          path: snapped.path,
          source: crossRoute ? "cross_route" : "on_route",
        });
      } else {
        const chordKm = haversineKm(p1.lat, p1.lon, p2.lat, p2.lon);
        if (chordKm * 1000 > MAX_FALLBACK_CHORD_M) {
          out.push({ path: null, source: "gap" });
        } else {
          out.push({
            path: [
              [p1.lon, p1.lat],
              [p2.lon, p2.lat],
            ],
            source: "fallback",
          });
        }
      }
    }
    return out;
  }

  // Single-point projection used by the JSONL augmenter. Mirrors the inner
  // loop of Python snap_augment_parquet: project the point onto every
  // candidate shape, keep ones within SNAP_PERP_THRESHOLD_M, and apply the
  // Pass-18 stickiness rule when `previousShapeId` is supplied.
  // Returns `{shape_id, cumdist}` or null when no candidate is in range.
  function snapPoint(lat, lon, candidateShapeIds, previousShapeId = null) {
    const [px, py] = latlonToMeters(lat, lon);
    const matches = [];
    for (const sid of candidateShapeIds) {
      const g = getGeom(sid);
      if (!g || g.xy.length < 2) continue;
      const proj = projectPointToPolyline(px, py, g.xy, g.cumdist);
      if (proj.perp > SNAP_PERP_THRESHOLD_M) continue;
      matches.push({ sid, perp: proj.perp, cumdist: proj.cumdist });
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => a.perp - b.perp);
    let pick = matches[0];
    if (previousShapeId) {
      const prev = matches.find((m) => m.sid === previousShapeId);
      if (prev && prev.perp <= matches[0].perp + SNAP_STICKINESS_THRESHOLD_M) {
        pick = prev;
      }
    }
    return { shape_id: pick.sid, cumdist: pick.cumdist };
  }

  return { snapTrail, snapPair, snapPairCrossRoute, snapPoint };
}

module.exports = {
  createSnapper,
  // Exported for tests + reuse.
  latlonToMeters,
  buildShapeGeometry,
  projectPointToPolyline,
  slicePolyline,
};
