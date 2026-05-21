// Bus table — mirrors busapp/ui/timeline.py:render_bus_table.
// Columns (both modes): Route (bus_id · Moving/Stationary subtitle), Speed Trend.
// Each row is clickable → selects the bus (same as clicking a dot on the map).

(function () {
  let tbody = null;
  let searchInput = null;
  let searchCount = null;
  let onSelectBus = null;
  let onGetSpeed = null;
  let selectedBusId = null;
  let lastBuses = [];
  let historicalMode = false;

  function mount({ onSelect, getSpeed, onFilterChange }) {
    tbody = document.getElementById("bus-table-body");
    onSelectBus = onSelect;
    onGetSpeed = getSpeed;
    searchInput = document.getElementById("route-search");
    searchCount = document.getElementById("route-search-count");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        render(lastBuses);
        if (onFilterChange) onFilterChange();
      });
    }
  }

  function getFilterText() {
    return searchInput ? searchInput.value.trim().toLowerCase() : "";
  }

  function setHistorical(flag) {
    historicalMode = !!flag;
    const table = tbody ? tbody.closest("table") : null;
    if (table) table.classList.toggle("bus-table--historical", historicalMode);
    render(lastBuses);
  }

  function setSelected(busId) {
    selectedBusId = busId;
    if (!tbody) return;
    for (const tr of tbody.querySelectorAll("tr")) {
      tr.classList.toggle("selected", tr.dataset.busId === busId);
    }
  }

  // Compute a 13-min-binned speed trend from a bus's trail. Mirrors the
  // BIN_MINUTES=13 sparkline binning the Python app uses.
  //
  // Bin boundaries are anchored to KL midnight of the first trail point's
  // day — same as Python `df["speed"].resample("13min").mean()` with default
  // `origin="start_day"`. The earlier `Math.floor(p.t / binMs)` was epoch-
  // anchored, which drifted bin boundaries off clock-time markers by up to
  // 12 min (verified empirically: for 14:23:45 input, pandas places the bin
  // at 14:18:00 while epoch-aligned puts it at 14:07:00).
  // KL is UTC+8 with no DST; convert via fixed offset.
  const KL_OFFSET_MS = 8 * 3600 * 1000;

  function klMidnightMs(tMs) {
    const klDayIndex = Math.floor((tMs + KL_OFFSET_MS) / 86_400_000);
    return klDayIndex * 86_400_000 - KL_OFFSET_MS;
  }

  function speedTrendBins(bus) {
    // Prefer full-day sparkline_trail; fall back to 20-point map trail.
    const trail = (bus.sparkline_trail && bus.sparkline_trail.length > 0)
      ? bus.sparkline_trail
      : (bus.trail || []);
    if (trail.length === 0) return [];
    const binMs = 13 * 60_000;
    const anchorMs = klMidnightMs(trail[0].time);
    const buckets = new Map();
    for (const p of trail) {
      // Default fallback chain uses the Python-matching column names:
      // `calculated_speed` (preferred when present) → `speed` (raw GTFS).
      const speed =
        onGetSpeed != null
          ? onGetSpeed({ ...bus, ...p })
          : p.calculated_speed != null
          ? p.calculated_speed
          : p.speed;
      if (speed == null) continue;
      const bin = Math.floor((p.time - anchorMs) / binMs);
      const arr = buckets.get(bin) || [];
      arr.push(speed);
      buckets.set(bin, arr);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, vals]) => vals.reduce((s, v) => s + v, 0) / vals.length);
  }

  // Tiny inline-SVG sparkline so we don't spin up an ECharts instance per row.
  function sparklineSvg(values, width = 96, height = 18) {
    if (values.length < 2) {
      return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"></svg>`;
    }
    const yMin = 0;
    const yMax = 100; // Python uses y_max=100 for the bar column
    const stepX = width / (values.length - 1 || 1);
    const points = values
      .map((v, i) => {
        const y = height - ((Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin)) * height;
        return `${(i * stepX).toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return (
      `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
      `<polyline fill="none" stroke="#79b8ff" stroke-width="1.4" points="${points}" />` +
      `</svg>`
    );
  }

  function formatLastSeen(timestamp) {
    if (!timestamp) return "—";
    const d = new Date(timestamp * 1000);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function render(buses) {
    if (!tbody) return;
    lastBuses = buses || [];

    const query = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const filtered = query
      ? lastBuses.filter(
          (b) =>
            (b.route || "Unknown").toLowerCase().includes(query) ||
            (b.bus_id || "").toLowerCase().includes(query)
        )
      : lastBuses;

    if (searchCount) {
      searchCount.textContent = query
        ? `${filtered.length} / ${lastBuses.length}`
        : lastBuses.length > 0 ? `${lastBuses.length} buses` : "";
    }

    if (filtered.length === 0) {
      const msg = query ? "No routes match “" + escapeHtml(query) + "”." : "No buses available.";
      const cols = 2;
      tbody.innerHTML =
        `<tr><td colspan=”${cols}” style=”padding: 20px; text-align: center; opacity: 0.6;”>${msg}</td></tr>`;
      return;
    }

    const sorted = filtered.slice().sort((a, b) => (a.route || "").localeCompare(b.route || ""));
    const frag = document.createDocumentFragment();
    for (const bus of sorted) {
      const speedNum = onGetSpeed ? onGetSpeed(bus) : bus.weighted_speed ?? bus.speed;
      // Prefer the server's status field (Python parity: displacement > 20 m
      // OR speed > 1 km/h). Fall back to speed-only for historical replays
      // where the server doesn't compute status.
      const moving =
        bus.status != null
          ? bus.status === "Moving"
          : speedNum != null && speedNum > 1;
      const trend = speedTrendBins(bus);

      const tr = document.createElement("tr");
      tr.dataset.busId = bus.bus_id;
      if (selectedBusId === bus.bus_id) tr.classList.add("selected");
      const staleSuffix = bus.is_stale ? " ⚠️" : "";
      const statusClass = moving ? "status-moving" : "status-stationary";
      const statusLabel = moving ? "Moving" : "Stationary";
      const routeCell =
        `<td>${escapeHtml(bus.route || "Unknown")}` +
        `<span class="route-meta">${escapeHtml(bus.bus_id)} · ` +
        `<span class="${statusClass}">${statusLabel}${staleSuffix}</span>` +
        (bus.timestamp ? ` · ${formatLastSeen(bus.timestamp)}` : "") +
        `</span></td>`;
      tr.innerHTML =
        routeCell +
        `<td>${sparklineSvg(trend)}</td>`;
      tr.addEventListener("click", () => {
        if (onSelectBus) onSelectBus(selectedBusId === bus.bus_id ? null : bus.bus_id);
      });
      frag.appendChild(tr);
    }
    tbody.replaceChildren(frag);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  window.busTable = { mount, render, setSelected, setHistorical, getFilterText };
})();
