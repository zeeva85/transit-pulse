// Detailed-bus timeline chart — mirrors busapp/ui/timeline.py:render_detailed_timeline.
// ECharts line chart of the selected bus's speed over time across the
// current data source (live trail or historical full-day trail).

(function () {
  let chart = null;
  let chartBottom = null;
  let dropdownEl = null;
  let dropdownBottomEl = null;
  let statsEl = null;
  let statsElBottom = null;
  let emptyEl = null;
  let emptyElBottom = null;
  let chartEl = null;
  let chartElBottom = null;
  let onSelectBus = null;
  let onSelectBusBottom = null;

  function mount({ onSelect, onSelectBottom }) {
    chartEl = document.getElementById("timeline-chart");
    statsEl = document.getElementById("timeline-stats");
    emptyEl = document.getElementById("timeline-empty");
    dropdownEl = document.getElementById("bus-dropdown");

    chartElBottom = document.getElementById("timeline-chart-bottom");
    statsElBottom = document.getElementById("timeline-stats-bottom");
    emptyElBottom = document.getElementById("timeline-empty-bottom");
    dropdownBottomEl = document.getElementById("bus-dropdown-bottom");

    onSelectBus = onSelect;
    onSelectBusBottom = onSelectBottom || onSelect;

    // echarts.init deferred to ensureCharts() — the library is lazy-loaded.
    ensureCharts();
    window.addEventListener("resize", () => {
      if (chart) chart.resize();
      if (chartBottom) chartBottom.resize();
    });

    if (dropdownEl) dropdownEl.addEventListener("change", (e) => {
      if (onSelectBus) onSelectBus(e.target.value || null);
    });
    if (dropdownBottomEl) dropdownBottomEl.addEventListener("change", (e) => {
      if (onSelectBusBottom) onSelectBusBottom(e.target.value || null);
    });
    chartEl.style.display = "none";
    chartElBottom.style.display = "none";
  }

  // Populate the dropdown options from the current bus list. Sorted by
  // route then bus_id so navigation is predictable.
  function populateDropdown(buses, selectedBusId) {
    const sorted = buses
      .slice()
      .sort((a, b) =>
        (a.route || "").localeCompare(b.route || "") || a.bus_id.localeCompare(b.bus_id)
      );
    function buildFrag() {
      const frag = document.createDocumentFragment();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— Select a bus —";
      frag.appendChild(placeholder);
      for (const b of sorted) {
        const opt = document.createElement("option");
        opt.value = b.bus_id;
        opt.textContent =
          b.route && b.route !== "Unknown" ? `${b.route} | ${b.bus_id}` : b.bus_id;
        frag.appendChild(opt);
      }
      return frag;
    }
    if (dropdownEl) {
      dropdownEl.replaceChildren(buildFrag());
      dropdownEl.value = selectedBusId || "";
    }
    if (dropdownBottomEl) {
      dropdownBottomEl.replaceChildren(buildFrag());
      dropdownBottomEl.value = selectedBusId || "";
    }
  }

  function setSelected(busId) {
    if (dropdownEl) dropdownEl.value = busId || "";
    if (dropdownBottomEl) dropdownBottomEl.value = busId || "";
  }

  // Bin trail points into 13-min KL-anchored buckets, matching Python's
  // make_time_bins (pandas `resample("13min")` with default
  // `origin="start_day"`). Same anchor logic as the sparkline in bus-table.js.
  // KL is UTC+8 with no DST.
  const KL_OFFSET_MS = 8 * 3600 * 1000;
  const BIN_MS = 13 * 60_000;
  function klMidnightMs(tMs) {
    const klDayIndex = Math.floor((tMs + KL_OFFSET_MS) / 86_400_000);
    return klDayIndex * 86_400_000 - KL_OFFSET_MS;
  }
  function binTrail(trail, getSpeed) {
    if (trail.length === 0) return [];
    // Trail points carry `time` (ms epoch) matching the Python parquet
    // schema column.
    const anchorMs = klMidnightMs(trail[0].time);
    const buckets = new Map();
    for (const p of trail) {
      const v = getSpeed(p);
      if (v == null) continue;
      const bin = Math.floor((p.time - anchorMs) / BIN_MS);
      const arr = buckets.get(bin) || [];
      arr.push(v);
      buckets.set(bin, arr);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bin, vals]) => {
        const midMs = anchorMs + bin * BIN_MS + BIN_MS / 2;
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        return [new Date(midMs).toISOString(), mean];
      });
  }

  function buildChartOption(bus, modeLabel, points) {
    return {
      animation: false,
      title: {
        text: `Bus ${bus.bus_id} · ${bus.route || "Unknown"}`,
        textStyle: { color: "#cdd0d4", fontSize: 12, fontWeight: 400 },
        top: 6,
        left: 14,
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#161b22",
        borderColor: "#2a2f3a",
        textStyle: { color: "#e6e6e6", fontSize: 12 },
        formatter: (params) => {
          const p = params[0];
          const t = new Date(p.value[0]);
          return (
            `${t.toLocaleTimeString([], { timeZone: "Asia/Kuala_Lumpur" })}<br/>` +
            `<b>${p.value[1] != null ? p.value[1].toFixed(1) + " km/h" : "—"}</b>`
          );
        },
      },
      grid: { left: 50, right: 20, top: 40, bottom: 30 },
      xAxis: {
        type: "time",
        axisLabel: {
          color: "#a0a0a0",
          fontSize: 10,
          formatter: (val) =>
            new Date(val).toLocaleTimeString([], {
              timeZone: "Asia/Kuala_Lumpur",
              hour: "2-digit",
              minute: "2-digit",
            }),
        },
        axisLine: { lineStyle: { color: "#2a2f3a" } },
      },
      yAxis: {
        type: "value",
        name: `${modeLabel} (km/h)`,
        nameLocation: "middle",
        nameGap: 35,
        nameTextStyle: { color: "#79b8ff", fontSize: 11 },
        min: 0,
        axisLabel: { color: "#a0a0a0", fontSize: 10 },
        splitLine: { lineStyle: { color: "#21262d" } },
      },
      series: [
        {
          type: "line",
          data: points,
          showSymbol: points.length < 60,
          symbolSize: 4,
          lineStyle: { color: "#79b8ff", width: 2 },
          itemStyle: { color: "#79b8ff" },
          areaStyle: { color: "rgba(121, 184, 255, 0.12)" },
        },
      ],
    };
  }

  // Init the two chart instances once the lazily-loaded echarts library is
  // available. Safe to call repeatedly.
  function ensureCharts() {
    if (chart) return true;
    if (!window.echarts || !chartEl || !chartElBottom) return false;
    chart = echarts.init(chartEl, null, { renderer: "canvas" });
    chartBottom = echarts.init(chartElBottom, null, { renderer: "canvas" });
    return true;
  }

  // Server-binned live path: same 13-min bins, computed server-side.
  // `corrected` is a real per-bin history — an upgrade over the old client
  // path, where speedFromTrailPoint (main.js) had no "corrected" case and
  // silently plotted trust-weighted values in corrected mode.
  const COL_BY_MODE = { raw: 1, calc: 2, kalman: 3, trust: 4, corrected: 5 };
  function pointsFromBins(sb, mode) {
    const col = COL_BY_MODE[mode] || 4;
    const out = [];
    for (const r of sb.bins) {
      const v = r[col];
      if (v == null) continue;
      const midMs = sb.anchor_ms + r[0] * sb.bin_ms + sb.bin_ms / 2;
      out.push([new Date(midMs).toISOString(), v]);
    }
    return out;
  }

  // Render the speed-vs-time chart for a single bus. `getSpeed(point)`
  // returns the speed value to plot for one trail entry — keyed to the
  // active speed-source setting in the parent app. `mode` is the active
  // speed-source key (raw/corrected/calc/kalman/trust) for the
  // server-binned path.
  function render(bus, modeLabel, getSpeed, mode) {
    const sb = bus && bus.sparkline_bins && bus.sparkline_bins.bins && bus.sparkline_bins.bins.length > 0
      ? bus.sparkline_bins
      : null;
    const fullTrail = bus && (
      (bus.sparkline_trail && bus.sparkline_trail.length > 0) ? bus.sparkline_trail : bus.trail
    );
    const noTrail = !sb && (!fullTrail || fullTrail.length === 0);
    if (noTrail) {
      const msg = bus
        ? `Bus ${bus.bus_id} has no trail data yet — wait a couple of ticks.`
        : "Select a bus from the dropdown above to view its detailed timeline.";
      chartEl.style.display = "none";
      statsEl.hidden = true;
      emptyEl.style.display = "block";
      emptyEl.textContent = msg;
      chartElBottom.style.display = "none";
      statsElBottom.hidden = true;
      emptyElBottom.style.display = "block";
      emptyElBottom.textContent = msg;
      return;
    }

    // A real render with data IS user intent (a bus is selected) — load
    // echarts now if it isn't in yet, then re-render with the same args.
    // The empty-state paths above are pure DOM and never need the library.
    if (!ensureCharts()) {
      if (window.__loadECharts) {
        window.__loadECharts().then(() => render(bus, modeLabel, getSpeed, mode)).catch(() => {});
      }
      return;
    }

    const points = sb ? pointsFromBins(sb, mode) : binTrail(fullTrail, getSpeed);

    if (points.length === 0) {
      const msg = `Bus ${bus.bus_id} has no ${modeLabel} readings yet.`;
      statsEl.hidden = true;
      chartEl.style.display = "none";
      emptyEl.style.display = "block";
      emptyEl.textContent = msg;
      statsElBottom.hidden = true;
      chartElBottom.style.display = "none";
      emptyElBottom.style.display = "block";
      emptyElBottom.textContent = msg;
      return;
    }

    const values = points.map((p) => p[1]);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const max = Math.max(...values);
    const min = Math.min(...values);

    // Modal stats
    document.getElementById("stat-avg").textContent = `${avg.toFixed(1)} km/h`;
    document.getElementById("stat-max").textContent = `${max.toFixed(1)} km/h`;
    document.getElementById("stat-min").textContent = `${min.toFixed(1)} km/h`;
    document.getElementById("stat-n").textContent = points.length;

    // Bottom stats
    document.getElementById("stat-avg-bottom").textContent = `${avg.toFixed(1)} km/h`;
    document.getElementById("stat-max-bottom").textContent = `${max.toFixed(1)} km/h`;
    document.getElementById("stat-min-bottom").textContent = `${min.toFixed(1)} km/h`;
    document.getElementById("stat-n-bottom").textContent = points.length;

    chartEl.style.display = "block";
    emptyEl.style.display = "none";
    statsEl.hidden = false;

    chartElBottom.style.display = "block";
    emptyElBottom.style.display = "none";
    statsElBottom.hidden = false;

    const option = buildChartOption(bus, modeLabel, points);
    chart.setOption(option, true);
    chartBottom.setOption(option, true);
  }

  function resize() {
    if (chart) chart.resize();
    if (chartBottom) chartBottom.resize();
  }
  window.busTimeline = { mount, render, populateDropdown, setSelected, resize };
})();
