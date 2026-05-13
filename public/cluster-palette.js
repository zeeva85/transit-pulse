// Per-cluster polyline colors — ColorBrewer Set1 + cyan, matches the
// Python CLUSTER_COLORS in busapp/ui/routes.py. Cluster N (1-indexed) uses
// palette[N-1]; wraps past 10.

(function () {
  const CLUSTER_COLORS = [
    [228, 26, 28, 220], // 1 — red
    [55, 126, 184, 220], // 2 — blue
    [77, 175, 74, 220], // 3 — green
    [152, 78, 163, 220], // 4 — purple
    [255, 127, 0, 220], // 5 — orange
    [255, 215, 0, 220], // 6 — yellow
    [166, 86, 40, 220], // 7 — brown
    [247, 129, 191, 220], // 8 — pink
    [120, 120, 120, 220], // 9 — grey
    [0, 200, 200, 220], // 10 — cyan
  ];

  function clusterColor(id) {
    if (id == null || id < 1) return [120, 120, 200, 140];
    return CLUSTER_COLORS[(id - 1) % CLUSTER_COLORS.length];
  }

  function clusterCssColor(id) {
    const [r, g, b] = clusterColor(id);
    return `rgb(${r}, ${g}, ${b})`;
  }

  window.CLUSTER_PALETTE = { CLUSTER_COLORS, clusterColor, clusterCssColor };
})();
