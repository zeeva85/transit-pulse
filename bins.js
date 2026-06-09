// Heatmap binning constants + helpers. Port of busapp/ui/timeline.py:24–95
// and the _bin_edges / _categorize helpers around line 290.
//
// This is the SERVER copy (CommonJS). A nearly-identical browser copy lives
// at public/heatmap-bins.js — both should be edited together. Single source
// of truth for the values is the Python timeline.py palette block.

// 7-step PiYG ramp + carve-outs (currently the active Python palette).
const RAMP_7 = [
  "#c51b7d", // bin 1 — deep pink (very slow)
  "#e9a3c9", // bin 2 — pink
  "#fde0ef", // bin 3 — pale pink
  "#f7f7f7", // bin 4 — WHITE (normal band)
  "#e6f5d0", // bin 5 — pale yellow-green
  "#a1d76a", // bin 6 — green
  "#4d9221", // bin 7 — deep green (fast)
];
const ZERO_COLOR = "#000000"; // stopped
const SPIKE_COLOR = "#d73027"; // spike

// Mode → physical anchor in km/h. White (bin 4) straddles this value.
const PHYSICAL_ANCHOR = {
  raw: 40,
  corrected: 40,
  kalman: 40,
  trust: 40,
  calc: 8,
};

// 8 offsets from anchor that define 7 bin edges. Asymmetric on purpose
// (slow side gets tighter widths because KL buses cluster slow).
const BIN_OFFSETS = {
  raw: [-40, -25, -15, -5, 15, 30, 50, 80],
  corrected: [-40, -25, -15, -5, 15, 30, 50, 80],
  kalman: [-40, -30, -22, -15, 5, 25, 50, 80],
  trust: [-40, -30, -20, -10, 5, 20, 35, 60],
  calc: [-2, -1.5, -1, -0.5, 1, 3, 6, 13],
};

// Above this is implausible — GPS noise / EKF runaway. Rendered as SPIKE.
const SPIKE_THRESHOLD = {
  raw: 120,
  corrected: 120,
  kalman: 120,
  trust: 100,
  calc: 80,
};

// Abstract bin labels — same across modes so the legend can be shared.
const ABSTRACT_LABELS = [
  "very slow",
  "slow",
  "below normal",
  "normal",
  "above normal",
  "fast",
  "very fast",
];
const STOPPED_LABEL = "stopped";
const SPIKE_LABEL = "spike";

// Order matches Python busapp/ui/timeline.py:_STACKED_MODES exactly so any
// consumer that iterates in array order gets RAW → CORRECTED → KALMAN →
// WEIGHTED (=trust) → CALCULATED, matching the heatmap's top-to-bottom facet
// order.
const STACKED_MODES = ["raw", "corrected", "kalman", "trust", "calc"];

// Bin edges scaled around `anchor`. Same algorithm as the Python _bin_edges:
// scale each offset by anchor / physical_anchor so widths stay proportional,
// clip to [0, spike_threshold], force strictly increasing.
function binEdges(mode, anchor) {
  const physical = PHYSICAL_ANCHOR[mode];
  const scale = physical > 0 ? anchor / physical : 1;
  const spike = SPIKE_THRESHOLD[mode];
  const raw = BIN_OFFSETS[mode].map((o) =>
    Math.max(0, Math.min(spike, anchor + o * scale))
  );
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] <= raw[i - 1]) raw[i] = raw[i - 1] + 1e-3;
  }
  return raw;
}

// Map a numeric value to its abstract label. Mirrors pd.cut with right=True,
// include_lowest=False, plus the two carve-outs.
function categorize(value, edges, spike) {
  if (value == null) return null;
  if (value === 0) return STOPPED_LABEL;
  if (value > spike) return SPIKE_LABEL;
  for (let i = 0; i < edges.length - 1; i++) {
    if (value > edges[i] && value <= edges[i + 1]) return ABSTRACT_LABELS[i];
  }
  return null;
}

const LABEL_TO_COLOR = (() => {
  const out = { [STOPPED_LABEL]: ZERO_COLOR, [SPIKE_LABEL]: SPIKE_COLOR };
  for (let i = 0; i < ABSTRACT_LABELS.length; i++) out[ABSTRACT_LABELS[i]] = RAMP_7[i];
  return out;
})();

module.exports = {
  RAMP_7,
  ZERO_COLOR,
  SPIKE_COLOR,
  PHYSICAL_ANCHOR,
  BIN_OFFSETS,
  SPIKE_THRESHOLD,
  ABSTRACT_LABELS,
  STOPPED_LABEL,
  SPIKE_LABEL,
  STACKED_MODES,
  LABEL_TO_COLOR,
  binEdges,
  categorize,
};
