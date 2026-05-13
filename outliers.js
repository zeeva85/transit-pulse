// Outlier-correction methods for GPS speed readings. Port of
// busapp/speeds/outliers.py — same 5 algorithms with the same default
// parameters. Pure functions over a number array, no per-bus state.

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function clipArr(arr, lo, hi) {
  return arr.map((v) => (v < lo ? lo : v > hi ? hi : v));
}

function mean(arr) {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function stdev(arr, mu) {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += (v - mu) ** 2;
  return Math.sqrt(s / arr.length);
}

// Returns a new array of corrected speeds. Mirrors Python's
// correct_outliers_vectorized; returns the input as-is when n < 4 because
// the quantile/std stats aren't meaningful below that.
function correctOutliers(speeds, method = "iqr") {
  if (!speeds || speeds.length < 4) return speeds.slice();
  const sorted = speeds.slice().sort((a, b) => a - b);

  if (method === "iqr") {
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    return clipArr(speeds, q1 - 1.5 * iqr, q3 + 1.5 * iqr);
  }
  if (method === "robust") {
    const med = quantile(sorted, 0.5);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    return clipArr(speeds, med - 1.5 * iqr, med + 1.5 * iqr);
  }
  if (method === "percentile" || method === "minmax") {
    return clipArr(speeds, quantile(sorted, 0.05), quantile(sorted, 0.95));
  }
  if (method === "zscore") {
    const mu = mean(speeds);
    const sigma = stdev(speeds, mu);
    if (sigma === 0) return speeds.slice();
    const cleaned = speeds.filter((v) => Math.abs((v - mu) / sigma) <= 2.5);
    if (cleaned.length < 2) return speeds.slice();
    const mu2 = mean(cleaned);
    const sigma2 = stdev(cleaned, mu2);
    if (sigma2 === 0) return cleaned;
    return clipArr(speeds, mu2 - 3 * sigma2, mu2 + 3 * sigma2);
  }
  return speeds.slice();
}

const CORRECTION_METHODS = ["iqr", "robust", "percentile", "zscore", "minmax"];

module.exports = {
  correctOutliers,
  CORRECTION_METHODS,
};
