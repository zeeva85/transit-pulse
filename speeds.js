// Speed estimators — port of busapp/speeds/{ekf.py, trust.py}.
//
// Hand-rolled matrix helpers because dimensions are small and fixed
// (4x4, 4x2, 2x4, 2x2). Avoids pulling in ml-matrix.

// ──────────────────────────────────────────────────────────────────────────
// Geo helpers — small-region equirectangular projection around KL center.
// ──────────────────────────────────────────────────────────────────────────

const REF_LAT = 3.139;
const REF_LON = 101.6869;
// Match Python: R · π/180 where R = 6 371 000 m. Differs from the common
// "111 320" approximation by ~0.11 %, but using Python's value keeps every
// meters-based computation (EKF state, snap projection, spread metrics)
// byte-comparable across the two ports.
const M_PER_DEG_LAT = (6371000 * Math.PI) / 180;
const COS_REF_LAT = Math.cos((REF_LAT * Math.PI) / 180);

function latlonToMeters(lat, lon) {
  const x = (lon - REF_LON) * M_PER_DEG_LAT * COS_REF_LAT;
  const y = (lat - REF_LAT) * M_PER_DEG_LAT;
  return [x, y];
}

function metersToLatlon(x, y) {
  const lat = REF_LAT + y / M_PER_DEG_LAT;
  const lon = REF_LON + x / (M_PER_DEG_LAT * COS_REF_LAT);
  return [lat, lon];
}

// ──────────────────────────────────────────────────────────────────────────
// Tiny matrix algebra (row-major nested arrays). Only what the EKF needs.
// ──────────────────────────────────────────────────────────────────────────

function mat(rows, cols, fill = 0) {
  const out = new Array(rows);
  for (let i = 0; i < rows; i++) out[i] = new Array(cols).fill(fill);
  return out;
}
function eye(n, scale = 1) {
  const m = mat(n, n);
  for (let i = 0; i < n; i++) m[i][i] = scale;
  return m;
}
function matMul(A, B) {
  const rows = A.length;
  const inner = B.length;
  const cols = B[0].length;
  const out = mat(rows, cols);
  for (let i = 0; i < rows; i++)
    for (let k = 0; k < inner; k++) {
      const aik = A[i][k];
      for (let j = 0; j < cols; j++) out[i][j] += aik * B[k][j];
    }
  return out;
}
function matVec(A, v) {
  const out = new Array(A.length).fill(0);
  for (let i = 0; i < A.length; i++)
    for (let k = 0; k < v.length; k++) out[i] += A[i][k] * v[k];
  return out;
}
function transpose(A) {
  const rows = A.length;
  const cols = A[0].length;
  const out = mat(cols, rows);
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) out[j][i] = A[i][j];
  return out;
}
function matAdd(A, B) {
  const out = mat(A.length, A[0].length);
  for (let i = 0; i < A.length; i++)
    for (let j = 0; j < A[0].length; j++) out[i][j] = A[i][j] + B[i][j];
  return out;
}
function matSub(A, B) {
  const out = mat(A.length, A[0].length);
  for (let i = 0; i < A.length; i++)
    for (let j = 0; j < A[0].length; j++) out[i][j] = A[i][j] - B[i][j];
  return out;
}
function vecSub(a, b) {
  return a.map((v, i) => v - b[i]);
}
function vecAdd(a, b) {
  return a.map((v, i) => v + b[i]);
}
function matScale(A, s) {
  const out = mat(A.length, A[0].length);
  for (let i = 0; i < A.length; i++)
    for (let j = 0; j < A[0].length; j++) out[i][j] = A[i][j] * s;
  return out;
}
function mat2Inv(A) {
  const [[a, b], [c, d]] = A;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return eye(2); // fallback — gates ~ zero update
  return [
    [d / det, -b / det],
    [-c / det, a / det],
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// EKF — state [x_m, y_m, vx_ms, vy_ms]. One instance per bus_id.
// Port of busapp/speeds/ekf.py:apply_ekf_filter.
// ──────────────────────────────────────────────────────────────────────────

const MAX_SPEED_MS = 150 / 3.6;
const MAX_GPS_JUMP_M = 500;
const MAX_DT = 120;
const LARGE_DT = 90; // reset velocity if gap exceeds this
const DIVERGENCE_SPEED_KMH = 200;
const DIVERGENCE_COV_TRACE = 1000;

const kalmanStates = new Map();

function applyEkfFilter(busId, lat, lon, measuredSpeedKmh, dt) {
  const [mx, my] = latlonToMeters(lat, lon);

  // First sighting: seed state with the measurement, zero velocity, big P.
  if (!kalmanStates.has(busId)) {
    kalmanStates.set(busId, {
      x: [mx, my, 0, 0],
      P: eye(4, 10),
      lastPosition: [mx, my],
      initCount: 0,
    });
    return { filteredLat: lat, filteredLon: lon, filteredSpeedKmh: measuredSpeedKmh };
  }
  const st = kalmanStates.get(busId);

  let dtSec = dt;
  if (dtSec <= 0) dtSec = 1;
  if (dtSec > MAX_DT) dtSec = MAX_DT;

  // Large gap: keep position, reset velocity + covariance.
  if (dtSec > LARGE_DT) {
    st.x[2] = 0;
    st.x[3] = 0;
    st.P = eye(4, 10);
    return { filteredLat: lat, filteredLon: lon, filteredSpeedKmh: measuredSpeedKmh };
  }

  // Bootstrap velocity from displacement on the first 2 observations after
  // initialization, so the filter has something other than zero velocity.
  if (st.initCount < 2) {
    const [lx, ly] = st.lastPosition;
    let vx = (mx - lx) / dtSec;
    let vy = (my - ly) / dtSec;
    const vmag = Math.hypot(vx, vy);
    if (vmag > MAX_SPEED_MS) {
      const scale = MAX_SPEED_MS / vmag;
      vx *= scale;
      vy *= scale;
    }
    st.x[2] = vx;
    st.x[3] = vy;
    st.initCount += 1;
    st.lastPosition = [mx, my];
  }

  // F: constant-velocity transition.
  const F = [
    [1, 0, dtSec, 0],
    [0, 1, 0, dtSec],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];

  // Adaptive process noise: bump up when GPS speed disagrees with our estimate.
  const estSpeedKmh = Math.hypot(st.x[2], st.x[3]) * 3.6;
  const speedChange = Math.abs(measuredSpeedKmh - estSpeedKmh);
  const q = speedChange > 20 ? 2 : 0.5;

  const dt2 = dtSec ** 2;
  const dt3 = dtSec ** 3;
  const dt4 = dtSec ** 4;
  const Q = [
    [dt4 / 4, 0, dt3 / 2, 0],
    [0, dt4 / 4, 0, dt3 / 2],
    [dt3 / 2, 0, dt2, 0],
    [0, dt3 / 2, 0, dt2],
  ];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) Q[i][j] *= q;

  // Predict
  const xPred = matVec(F, st.x);
  const Ft = transpose(F);
  const PPred = matAdd(matMul(matMul(F, st.P), Ft), Q);

  // H selects position rows; R is 2x2 measurement noise.
  const H = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ];
  const R = [
    [25, 0],
    [0, 25],
  ];
  const z = [mx, my];

  // GPS-jump gate: if the measurement is too far from prediction, skip update.
  const predicted = matVec(H, xPred);
  const jumpDist = Math.hypot(z[0] - predicted[0], z[1] - predicted[1]);
  if (jumpDist > MAX_GPS_JUMP_M) {
    st.x = xPred;
    st.P = PPred;
    st.lastPosition = [xPred[0], xPred[1]];
    const speedKmh = Math.hypot(xPred[2], xPred[3]) * 3.6;
    const [flat, flon] = metersToLatlon(xPred[0], xPred[1]);
    return { filteredLat: flat, filteredLon: flon, filteredSpeedKmh: speedKmh };
  }

  // Update
  const y = vecSub(z, predicted);
  const Ht = transpose(H);
  const S = matAdd(matMul(matMul(H, PPred), Ht), R);
  const Sinv = mat2Inv(S);
  let K = matMul(matMul(PPred, Ht), Sinv);

  let xUpd = vecAdd(xPred, matVec(K, y));
  let PUpd = matMul(matSub(eye(4), matMul(K, H)), PPred);

  // Soften the gain when Mahalanobis distance is large (outlier-ish update).
  const yT_Sinv = matVec(Sinv, y); // 2-vec
  const mahalanobis = Math.sqrt(y[0] * yT_Sinv[0] + y[1] * yT_Sinv[1]);
  if (mahalanobis > 3) {
    K = matScale(K, 0.3);
    xUpd = vecAdd(xPred, matVec(K, y));
  }

  // Velocity clamp.
  let vx = xUpd[2];
  let vy = xUpd[3];
  const speedMag = Math.hypot(vx, vy);
  if (speedMag > MAX_SPEED_MS) {
    const scale = MAX_SPEED_MS / speedMag;
    xUpd[2] = vx * scale;
    xUpd[3] = vy * scale;
  }

  const filteredSpeedKmh = Math.hypot(xUpd[2], xUpd[3]) * 3.6;
  const covTrace = PUpd[0][0] + PUpd[1][1] + PUpd[2][2] + PUpd[3][3];

  // Divergence auto-reset.
  if (
    filteredSpeedKmh > DIVERGENCE_SPEED_KMH ||
    covTrace > DIVERGENCE_COV_TRACE
  ) {
    kalmanStates.delete(busId);
    return { filteredLat: lat, filteredLon: lon, filteredSpeedKmh: measuredSpeedKmh };
  }

  st.x = xUpd;
  st.P = PUpd;
  st.lastPosition = [xUpd[0], xUpd[1]];

  const [flat, flon] = metersToLatlon(xUpd[0], xUpd[1]);
  return { filteredLat: flat, filteredLon: flon, filteredSpeedKmh };
}

// ──────────────────────────────────────────────────────────────────────────
// Trust-weighted speed — port of busapp/speeds/trust.py:detect_movement.
// ──────────────────────────────────────────────────────────────────────────

const ROLLING_WINDOW = 5;
const speedBuffers = new Map(); // bus_id -> [gps_speed, …]
const calcBuffers = new Map(); // bus_id -> [calc_speed, …]
const trustBuffers = new Map(); // bus_id -> [trust_score, …]

function pushBounded(map, busId, value) {
  const buf = map.get(busId) || [];
  buf.push(value);
  while (buf.length > ROLLING_WINDOW) buf.shift();
  map.set(busId, buf);
  return buf;
}

function computeTrustWeighted(busId, gpsSpeed, calculatedSpeed) {
  const speedBuf = pushBounded(speedBuffers, busId, gpsSpeed ?? 0);
  let trustScore;

  if (calculatedSpeed != null) {
    pushBounded(calcBuffers, busId, calculatedSpeed);
    const gps = gpsSpeed ?? 0;
    const diff = Math.abs(gps - calculatedSpeed);
    const maxSp = Math.max(gps, calculatedSpeed, 1);
    trustScore = Math.max(0.1, Math.min(1, 1 - diff / (maxSp + 10)));
    if (gps > 120) trustScore *= 0.1; // GPS-spike penalty
  } else {
    trustScore = 0.7;
  }
  const trustBuf = pushBounded(trustBuffers, busId, trustScore);

  let num = 0;
  let den = 0;
  for (let i = 0; i < speedBuf.length; i++) {
    num += speedBuf[i] * trustBuf[i];
    den += trustBuf[i];
  }
  const weighted = den > 0 ? num / den : gpsSpeed ?? 0;
  return { weighted, trust: trustScore };
}

// ──────────────────────────────────────────────────────────────────────────
// Day-rollover state clear. Mirrors Python busapp/state.py:62-66 which sets
//   st.session_state.speed_buffers = {}
//   st.session_state.calc_speed_buffers = {}
//   st.session_state.trust_buffers = {}
// at the KL midnight crossover (but does NOT clear kalman_states — those
// persist across days; only divergence inside apply_ekf_filter prunes them).
// ──────────────────────────────────────────────────────────────────────────

function clearTrustBuffers() {
  speedBuffers.clear();
  calcBuffers.clear();
  trustBuffers.clear();
}

function speedStateStats() {
  return {
    kalman_tracked: kalmanStates.size,
    trust_tracked: trustBuffers.size,
  };
}

module.exports = {
  applyEkfFilter,
  computeTrustWeighted,
  clearTrustBuffers,
  speedStateStats,
};
