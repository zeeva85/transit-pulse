// Browser copy of busjs/bins.js — same values, exposed as window.HEATMAP_BINS.
// Edit both files together; single source of truth for the values is the
// Python palette block at busapp/ui/timeline.py:20–95.

(function () {
  const RAMP_7 = [
    "#c51b7d",
    "#e9a3c9",
    "#fde0ef",
    "#f7f7f7",
    "#e6f5d0",
    "#a1d76a",
    "#4d9221",
  ];
  const ZERO_COLOR = "#000000";
  const SPIKE_COLOR = "#d73027";

  const PHYSICAL_ANCHOR = { raw: 40, corrected: 40, kalman: 40, trust: 40, calc: 8 };

  const BIN_OFFSETS = {
    raw: [-40, -25, -15, -5, 15, 30, 50, 80],
    corrected: [-40, -25, -15, -5, 15, 30, 50, 80],
    kalman: [-40, -30, -22, -15, 5, 25, 50, 80],
    trust: [-40, -30, -20, -10, 5, 20, 35, 60],
    calc: [-2, -1.5, -1, -0.5, 1, 3, 6, 13],
  };

  const SPIKE_THRESHOLD = { raw: 120, corrected: 120, kalman: 120, trust: 100, calc: 80 };

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

  // Legend domain (left-to-right or top-to-bottom): stopped → ramp → spike.
  const LEGEND_DOMAIN = [STOPPED_LABEL, ...ABSTRACT_LABELS, SPIKE_LABEL];
  const LEGEND_COLORS = [ZERO_COLOR, ...RAMP_7, SPIKE_COLOR];

  const LABEL_TO_COLOR = (() => {
    const out = { [STOPPED_LABEL]: ZERO_COLOR, [SPIKE_LABEL]: SPIKE_COLOR };
    for (let i = 0; i < ABSTRACT_LABELS.length; i++) {
      out[ABSTRACT_LABELS[i]] = RAMP_7[i];
    }
    return out;
  })();

  window.HEATMAP_BINS = {
    RAMP_7,
    ZERO_COLOR,
    SPIKE_COLOR,
    PHYSICAL_ANCHOR,
    BIN_OFFSETS,
    SPIKE_THRESHOLD,
    ABSTRACT_LABELS,
    STOPPED_LABEL,
    SPIKE_LABEL,
    LEGEND_DOMAIN,
    LEGEND_COLORS,
    LABEL_TO_COLOR,
  };
})();
