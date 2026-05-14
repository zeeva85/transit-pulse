// ECharts heatmap module — single-mode OR 5-mode stacked, with optional
// cluster stripe under the x-axis and pooled-median anchor.

(function () {
  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const HOUR_LABELS = HOURS.map((h) => String(h).padStart(2, "0"));
  // Order matches Python timeline.py:_STACKED_MODES exactly so the
  // top-to-bottom facet order is RAW → CORRECTED → KALMAN → WEIGHTED →
  // CALCULATED.
  const STACK_MODES = ["raw", "corrected", "kalman", "trust", "calc"];
  const STACK_LABELS = {
    raw: "Raw GPS Speed",
    corrected: "Corrected GPS Speed",
    kalman: "Kalman Filtered Speed",
    trust: "Trust-Weighted Speed",
    calc: "Calculated Displacement Speed",
  };

  // Fixed cell dimensions — byte parity with Python busapp/ui/timeline.py:
  //   cell_w, cell_h = 9, 6
  //   facet_width  = n_routes * cell_w
  //   facet_height = 24 * cell_h
  //   use_container_width=False  → no horizontal stretching
  // The chart container is resized programmatically on every refresh so
  // each rectangle is exactly 9×6 px regardless of viewport width; the
  // parent #heatmap-section scrolls horizontally when n_routes overflows.
  const CELL_W = 9;
  const CELL_H = 6;
  const FACET_H = 24 * CELL_H;  // 144 px — one mode's worth of hour rows
  const FACET_GAP = 14;         // px between stacked facets
  const STRIPE_H = 18;          // cluster-stripe height
  const MARGIN_LEFT = 60;       // hour labels + facet name (stacked)
  const MARGIN_RIGHT = 30;
  const MARGIN_TOP = 50;        // visualMap legend lives here
  // Bottom margin must clear rotated x-axis labels. Longest KL route labels
  // are ~22 chars; rotated -90° at fontSize 10 needs ~150 px of room.
  const MARGIN_BOTTOM = 180;

  function chartWidth(nRoutes) {
    return MARGIN_LEFT + nRoutes * CELL_W + MARGIN_RIGHT;
  }
  function chartHeightSingle(hasStripe) {
    return (
      MARGIN_TOP +
      FACET_H +
      (hasStripe ? FACET_GAP + STRIPE_H : 0) +
      MARGIN_BOTTOM
    );
  }
  function chartHeightStacked(nFacets, hasStripe) {
    return (
      MARGIN_TOP +
      nFacets * FACET_H +
      (nFacets - 1) * FACET_GAP +
      (hasStripe ? FACET_GAP + STRIPE_H : 0) +
      MARGIN_BOTTOM
    );
  }
  function applyContainerSize(w, h) {
    if (!chart) return;
    const dom = chart.getDom();
    dom.style.width = `${w}px`;
    dom.style.height = `${h}px`;
    chart.resize();
  }

  let chart = null;
  let modeEl, anchorEl, stackEl, statusEl, dateEl;
  let currentMode = "trust";
  let currentAnchor = "physical";
  let currentStack = false;
  let currentDate = "today"; // "today" or YYYY-MM-DD

  // Set by main.js whenever clustering changes; passed in via the
  // `clusters` arg to refresh() rather than imported globally.
  let lastClusterByRoute = {};
  // Optional [0..23] in clustered order. When null/length 0, y-axis stays
  // temporal. Mirrors Python settings.cluster_hours.
  let hourOrder = null;

  function mount(containerEl) {
    if (chart) return;
    chart = echarts.init(containerEl, null, { renderer: "canvas" });
    modeEl = document.getElementById("heatmap-mode");
    anchorEl = document.getElementById("heatmap-anchor");
    stackEl = document.getElementById("heatmap-stack");
    statusEl = document.getElementById("heatmap-status");
    dateEl = document.getElementById("heatmap-date-picker");

    modeEl.addEventListener("change", (e) => {
      currentMode = e.target.value;
      modeEl.disabled = currentStack;
      refresh();
    });
    anchorEl.addEventListener("change", (e) => {
      currentAnchor = e.target.value;
      refresh();
    });
    stackEl.addEventListener("change", (e) => {
      currentStack = e.target.checked;
      modeEl.disabled = currentStack;
      document.body.classList.toggle("heatmap-stacked", currentStack);
      // Container size is recomputed inside refresh() (single vs stacked
      // height differs), so no explicit chart.resize() needed here.
      refresh();
    });
    dateEl.addEventListener("change", (e) => {
      currentDate = e.target.value;
      refresh();
    });
    // No window-resize listener — chart dimensions are computed from
    // n_routes (CELL_W/CELL_H × counts) and don't depend on viewport size.
    // The parent #heatmap-section scrolls horizontally when needed.

    populateDatePicker();
  }

  // Fetch /api/dates and populate the picker. Polled every minute so newly
  // accumulated days show up without a page refresh.
  async function populateDatePicker() {
    try {
      const res = await fetch("/api/dates");
      if (!res.ok) return;
      const { dates } = await res.json();
      const existing = new Set([...dateEl.options].map((o) => o.value));
      for (const d of dates) {
        if (existing.has(d.date)) continue;
        const opt = document.createElement("option");
        opt.value = d.date;
        const mb = (d.size_bytes / 1024 / 1024).toFixed(1);
        const tag = d.source === "parquet" ? "📁 parquet" : "📝 jsonl";
        opt.textContent = `${d.date}  (${mb} MB · ${tag})`;
        dateEl.appendChild(opt);
      }
    } catch (err) {
      console.error("dates fetch failed", err);
    }
    setTimeout(populateDatePicker, 60_000);
  }

  function isHistorical() {
    return currentDate && currentDate !== "today";
  }

  // main.js calls this with the current cluster map so the heatmap stripe
  // stays in sync with the map's cluster colors.
  function setClusters(clusterByRoute) {
    lastClusterByRoute = clusterByRoute || {};
    if (chart) refresh();
  }

  function setHourOrder(order) {
    // `order` is an array of 24 ints in clustered order, or null/undefined
    // to revert to temporal 0..23. We refresh on any change so the y-axis
    // reorders immediately without waiting for the next polling tick.
    hourOrder = Array.isArray(order) && order.length === 24 ? order : null;
    if (chart) refresh();
  }

  // Hour labels driven by the current order (clustered or temporal).
  function currentHourLabels() {
    const order = hourOrder || HOURS;
    return order.map((h) => String(h).padStart(2, "0"));
  }

  // Remap a cell's `.h` (raw hour 0..23) to its index in the active y-axis
  // order. Returns null when the hour isn't in the order array (shouldn't
  // happen but defensive against partial cluster results).
  function hourYIndex(hour) {
    if (!hourOrder) return hour;
    const idx = hourOrder.indexOf(hour);
    return idx >= 0 ? idx : null;
  }

  async function refresh() {
    if (!chart) return;
    try {
      const params = new URLSearchParams();
      params.set("mode", currentStack ? "all" : currentMode);
      params.set("anchor", currentAnchor);
      if (isHistorical()) params.set("date", currentDate);
      const url = `/api/heatmap?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (currentStack) renderStacked(data);
      else renderSingle(data);

      const ref = currentStack ? data.per_mode[currentMode] || data.per_mode[STACK_MODES[0]] : data;
      const s = (ref && ref.stats) || {};
      const anchorTag = (ref && ref.anchor_mode) || currentAnchor;
      statusEl.textContent =
        s.cells_populated && s.cells_populated > 0
          ? `${s.cells_populated} cells · ${s.samples_total} samples · ${s.buses_tracked} buses · anchor=${anchorTag}`
          : "accumulating samples…";
    } catch (err) {
      console.error("heatmap refresh failed", err);
      if (statusEl) statusEl.textContent = `refresh failed: ${err.message}`;
    }
  }

  // Visible message when the accumulator (or a historical day's parquet)
  // has zero data for the requested mode/date. Previously this fell
  // through to chart.clear() and the user just saw a blank rectangle.
  function renderEmptyMessage(data) {
    const isHist = isHistorical();
    const label = isHist
      ? `No data in ${currentDate} for "${currentMode}"`
      : "Accumulating samples — wait ~1 minute of bus activity";
    // The data-driven renderers size the container based on n_routes; the
    // empty state has no routes, so give it a sensible fallback so the
    // title doesn't render inside a zero-height box.
    applyContainerSize(800, 280);
    chart.setOption(
      {
        animation: false,
        title: {
          text: label,
          subtext: isHist
            ? "Try a different mode or date."
            : "The map will populate as soon as buses report.",
          left: "center",
          top: "middle",
          textStyle: { color: "#cdd0d4", fontSize: 16, fontWeight: 400 },
          subtextStyle: { color: "#79b8ff", fontSize: 12 },
        },
        series: [],
      },
      true
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Shared bits — visualMap pieces, cluster stripe, axis config
  // ────────────────────────────────────────────────────────────────────

  function makeVisualMap(bins) {
    return {
      type: "piecewise",
      dimension: 2,
      orient: "horizontal",
      top: 6,
      left: "center",
      pieces: bins.LEGEND_DOMAIN.map((label, i) => ({
        value: i,
        label,
        color: bins.LABEL_TO_COLOR[label],
      })),
      itemSymbol: "rect",
      itemWidth: 14,
      itemHeight: 12,
      textStyle: { color: "#cdd0d4", fontSize: 11 },
      backgroundColor: "transparent",
    };
  }

  // Build a "cluster stripe" data series — one heatmap cell per route at a
  // synthetic y-row labelled "cluster". Color comes from the per-route
  // cluster id. Returns null when clustering is off / no data.
  function buildClusterStripe(routes) {
    const ids = routes.map((r) => lastClusterByRoute[r]);
    if (!ids.some((c) => c != null)) return null;
    const data = ids.map((id, i) => (id != null ? [i, 0, "c" + id] : null)).filter(Boolean);
    const pieces = [];
    const seen = new Set();
    for (const id of ids) {
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      pieces.push({
        value: "c" + id,
        label: "Cluster " + id,
        color: window.CLUSTER_PALETTE.clusterCssColor(id),
      });
    }
    return { data, pieces };
  }

  // ────────────────────────────────────────────────────────────────────
  // Single-mode rendering
  // ────────────────────────────────────────────────────────────────────

  function renderSingle(data) {
    const bins = window.HEATMAP_BINS;
    const routes = data.routes || [];
    if (routes.length === 0) {
      renderEmptyMessage(data);
      return;
    }
    const cells = data.cells || [];
    // Only show hours that actually have data, in visual order (temporal or
    // clustered). This avoids 20 empty rows when the server starts mid-day.
    const activeHoursSet = new Set(cells.map((c) => c.h));
    const orderedHours = (hourOrder || HOURS).filter((h) => activeHoursSet.has(h));
    const yLabels = orderedHours.map((h) => String(h).padStart(2, "0"));
    const hourToYIndex = Object.fromEntries(orderedHours.map((h, i) => [h, i]));
    const activeH = orderedHours.length || 1;

    const seriesData = cells
      .map((c) => {
        const yi = hourToYIndex[c.h];
        if (yi == null) return null;
        return [c.r, yi, bins.LEGEND_DOMAIN.indexOf(c.bin), c.bin, c.v, c.n, c.h];
      })
      .filter(Boolean);
    const cluster = buildClusterStripe(routes);

    const facetH = activeH * CELL_H;
    // Size the container so the cells render at exactly CELL_W × CELL_H px.
    applyContainerSize(
      chartWidth(routes.length),
      MARGIN_TOP + facetH + (cluster ? FACET_GAP + STRIPE_H : 0) + MARGIN_BOTTOM
    );

    const facetWidth = routes.length * CELL_W;
    const grids = [
      {
        top: MARGIN_TOP,
        left: MARGIN_LEFT,
        width: facetWidth,
        height: facetH,
      },
    ];
    const xAxes = [
      {
        gridIndex: 0,
        type: "category",
        data: routes,
        axisLabel: {
          rotate: -90,
          color: "#a0a0a0",
          fontSize: 10,
          interval: 0,
          formatter: (v) => (v.length > 22 ? v.slice(0, 20) + "…" : v),
        },
        axisTick: { show: false },
      },
    ];
    const yAxes = [
      {
        gridIndex: 0,
        type: "category",
        data: yLabels,
        axisLabel: { color: "#a0a0a0", fontSize: 11 },
        axisTick: { show: false },
      },
    ];
    const series = [
      {
        name: "median speed",
        type: "heatmap",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: seriesData,
        progressive: 0,
        label: { show: false },
        itemStyle: { borderWidth: 0 },
      },
    ];
    const visualMap = [makeVisualMap(bins)];
    visualMap[0].seriesIndex = 0;

    // Cluster stripe — second grid pinned under the main one, same width.
    if (cluster) {
      grids.push({
        left: MARGIN_LEFT,
        width: facetWidth,
        top: MARGIN_TOP + facetH + FACET_GAP,
        height: STRIPE_H,
      });
      xAxes.push({
        gridIndex: 1,
        type: "category",
        data: routes,
        show: false,
      });
      yAxes.push({
        gridIndex: 1,
        type: "category",
        data: ["cluster"],
        axisLabel: { color: "#a0a0a0", fontSize: 10 },
        axisTick: { show: false },
      });
      series.push({
        name: "cluster",
        type: "heatmap",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: cluster.data,
        label: { show: false },
        itemStyle: { borderWidth: 0 },
      });
      visualMap.push({
        type: "piecewise",
        show: false,
        seriesIndex: 1,
        pieces: cluster.pieces,
      });
    }

    chart.setOption(
      {
        animation: false,
        tooltip: {
          position: "top",
          backgroundColor: "#161b22",
          borderColor: "#2a2f3a",
          textStyle: { color: "#e6e6e6", fontSize: 12 },
          formatter: (params) => {
            if (params.seriesName === "cluster") {
              return `<b>${routes[params.value[0]]}</b><br/>${params.value[2]}`;
            }
            // Tuple: [r, yIndex, binIndex, bin, v, n, rawHour]. Show raw
            // hour in the tooltip so the value stays readable when the
            // y-axis has been reordered by hour clustering.
            const [r, , , bin, v, n, rawHour] = params.value;
            return (
              `<b>${routes[r]}</b><br/>Hour ${String(rawHour).padStart(2, "0")}:00 · ` +
              `${data.mode}<br/>Median ${v != null ? v.toFixed(1) : "—"} km/h<br/>` +
              `<small>${n} bus${n === 1 ? "" : "es"} · ${bin}</small>`
            );
          },
        },
        grid: grids,
        xAxis: xAxes,
        yAxis: yAxes,
        visualMap,
        series,
      },
      true
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // 5-mode stacked rendering
  // ────────────────────────────────────────────────────────────────────

  function renderStacked(data) {
    const bins = window.HEATMAP_BINS;
    // Union of all routes across modes — gives a consistent x-axis across
    // every facet, matching Python's behavior.
    const routeSet = new Set();
    for (const m of STACK_MODES) {
      for (const r of (data.per_mode[m].routes || [])) routeSet.add(r);
    }
    const routes = [...routeSet].sort();
    if (routes.length === 0) {
      renderEmptyMessage(data);
      return;
    }

    // Per-mode lookup so we can remap each cell's `r` index to the union order.
    const routeIndex = Object.fromEntries(routes.map((r, i) => [r, i]));

    // Active hours: union across all modes, then filter the visual order.
    const activeHoursSet = new Set();
    for (const m of STACK_MODES) {
      for (const c of (data.per_mode[m].cells || [])) activeHoursSet.add(c.h);
    }
    const orderedHours = (hourOrder || HOURS).filter((h) => activeHoursSet.has(h));
    const yLabels = orderedHours.map((h) => String(h).padStart(2, "0"));
    const hourToYIndex = Object.fromEntries(orderedHours.map((h, i) => [h, i]));
    const activeH = orderedHours.length || 1;
    const facetH = activeH * CELL_H;

    const seriesByMode = {};
    for (const m of STACK_MODES) {
      const md = data.per_mode[m];
      seriesByMode[m] = (md.cells || [])
        .map((c) => {
          const remapped = routeIndex[md.routes[c.r]];
          const yi = hourToYIndex[c.h];
          if (yi == null) return null;
          // Tuple: [r, yIndex, binIndex, bin, v, n, mode, rawHour].
          return [remapped, yi, bins.LEGEND_DOMAIN.indexOf(c.bin), c.bin, c.v, c.n, m, c.h];
        })
        .filter(Boolean);
    }

    const cluster = buildClusterStripe(routes);
    const facets = STACK_MODES.length;

    // Size container so each cell is exactly CELL_W × CELL_H px.
    applyContainerSize(
      chartWidth(routes.length),
      MARGIN_TOP + facets * facetH + (facets - 1) * FACET_GAP +
        (cluster ? FACET_GAP + STRIPE_H : 0) + MARGIN_BOTTOM
    );

    const grids = [];
    const xAxes = [];
    const yAxes = [];
    const series = [];
    const visualMap = [makeVisualMap(bins)];
    visualMap[0].seriesIndex = STACK_MODES.map((_, i) => i);

    // Each facet sits at a fixed pixel offset from the top, with the same
    // facetH × (routes.length * CELL_W) footprint. Mirrors Python's
    // Altair `row` facet stack (busapp/ui/timeline.py:641-651).
    const facetWidth = routes.length * CELL_W;
    STACK_MODES.forEach((mode, i) => {
      const topPx = MARGIN_TOP + i * (facetH + FACET_GAP);
      grids.push({
        left: MARGIN_LEFT,
        width: facetWidth,
        top: topPx,
        height: facetH,
      });
      xAxes.push({
        gridIndex: i,
        type: "category",
        data: routes,
        axisLabel:
          i === facets - 1 && !cluster
            ? {
                rotate: -90,
                color: "#a0a0a0",
                fontSize: 9,
                interval: 0,
                formatter: (v) => (v.length > 22 ? v.slice(0, 20) + "…" : v),
              }
            : { show: false },
        axisTick: { show: false },
      });
      yAxes.push({
        gridIndex: i,
        type: "category",
        data: yLabels,
        name: STACK_LABELS[mode],
        nameLocation: "middle",
        nameGap: 35,
        nameTextStyle: { color: "#79b8ff", fontSize: 11, fontWeight: 600 },
        axisLabel: { color: "#a0a0a0", fontSize: 9 },
        axisTick: { show: false },
      });
      series.push({
        name: STACK_LABELS[mode],
        type: "heatmap",
        xAxisIndex: i,
        yAxisIndex: i,
        data: seriesByMode[mode],
        label: { show: false },
        itemStyle: { borderWidth: 0 },
      });
    });

    if (cluster) {
      const stripeIdx = facets;
      grids.push({
        left: MARGIN_LEFT,
        width: facetWidth,
        top: MARGIN_TOP + facets * (facetH + FACET_GAP),
        height: STRIPE_H,
      });
      xAxes.push({
        gridIndex: stripeIdx,
        type: "category",
        data: routes,
        axisLabel: {
          rotate: -90,
          color: "#a0a0a0",
          fontSize: 9,
          interval: 0,
          formatter: (v) => (v.length > 22 ? v.slice(0, 20) + "…" : v),
        },
        axisTick: { show: false },
      });
      yAxes.push({
        gridIndex: stripeIdx,
        type: "category",
        data: ["cluster"],
        axisLabel: { color: "#a0a0a0", fontSize: 9 },
        axisTick: { show: false },
      });
      series.push({
        name: "cluster",
        type: "heatmap",
        xAxisIndex: stripeIdx,
        yAxisIndex: stripeIdx,
        data: cluster.data,
        label: { show: false },
        itemStyle: { borderWidth: 0 },
      });
      visualMap.push({
        type: "piecewise",
        show: false,
        seriesIndex: stripeIdx,
        pieces: cluster.pieces,
      });
    }

    chart.setOption(
      {
        animation: false,
        tooltip: {
          position: "top",
          backgroundColor: "#161b22",
          borderColor: "#2a2f3a",
          textStyle: { color: "#e6e6e6", fontSize: 12 },
          formatter: (params) => {
            if (params.seriesName === "cluster") {
              return `<b>${routes[params.value[0]]}</b><br/>${params.value[2]}`;
            }
            // Stacked tuple: [r, yIndex, binIndex, bin, v, n, mode, rawHour].
            // Show raw hour in the tooltip — y-axis may be reordered.
            const [r, , , bin, v, n, mode, rawHour] = params.value;
            return (
              `<b>${routes[r]}</b><br/>` +
              `${STACK_LABELS[mode]} · Hour ${String(rawHour).padStart(2, "0")}:00<br/>` +
              `Median ${v != null ? v.toFixed(1) : "—"} km/h<br/>` +
              `<small>${n} bus${n === 1 ? "" : "es"} · ${bin}</small>`
            );
          },
        },
        grid: grids,
        xAxis: xAxes,
        yAxis: yAxes,
        visualMap,
        series,
      },
      true
    );
  }

  function setMode(mode) {
    currentMode = mode;
    if (modeEl) modeEl.value = mode;
  }

  function setDate(date) {
    currentDate = date || "today";
    if (dateEl) dateEl.value = currentDate;
    if (chart) refresh();
  }

  window.busHeatmap = { mount, refresh, setMode, setClusters, setHourOrder, setDate };
})();
