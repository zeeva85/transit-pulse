// status.js — renders /status from the monitor sweep in /api/health.
//
// External file rather than inline because the CSP has no 'unsafe-inline' in
// scriptSrc (same reason theme-toggle.js exists).

(function () {
  "use strict";

  var KL_ROWS = document.getElementById("kl-rows");
  var OTHER_ROWS = document.getElementById("other-rows");
  var VERDICT = document.getElementById("verdict");
  var SWEPT = document.getElementById("swept-note");

  function statusPill(vehicles) {
    if (vehicles < 0) return '<span class="pill down">unreachable</span>';
    if (vehicles === 0) return '<span class="pill zero">no vehicles</span>';
    return '<span class="pill live">live</span>';
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function row(src, isOurs, secondCol) {
    return (
      '<tr class="' + (isOurs ? "is-ours" : "") + '">' +
      "<td>" + esc(src.id) + (isOurs ? '<span class="pill ours">collecting</span>' : "") + "</td>" +
      "<td>" + esc(secondCol) + "</td>" +
      "<td>" + statusPill(src.vehicles) + "</td>" +
      '<td class="num">' + (src.vehicles < 0 ? "&mdash;" : src.vehicles) + "</td>" +
      "</tr>"
    );
  }

  function setVerdict(cls, title, body) {
    VERDICT.className = "verdict " + cls;
    VERDICT.innerHTML = "<strong>" + esc(title) + "</strong>" + body;
  }

  // The whole point of the page: is the feed WE COLLECT dead, or is the country
  // quiet? Judged on the collecting feed specifically — a healthy sibling does
  // not mean the map has buses on it.
  function renderVerdict(kl, others, activeId) {
    var othersLive = others.filter(function (s) { return s.vehicles > 0; });
    var active = kl.filter(function (s) { return s.id === activeId; })[0];
    var klDown = kl.filter(function (s) { return s.vehicles === 0; });

    if (active && active.vehicles > 0) {
      var extra = klDown.length
        ? " Note that " +
          klDown.map(function (s) { return esc(s.id); }).join(" and ") +
          " is still reporting nothing."
        : "";
      setVerdict(
        "ok",
        "Collecting normally",
        "This site is collecting <strong>" + esc(active.id) + "</strong>, currently carrying " +
          active.vehicles + " buses." + extra
      );
      return;
    }

    var sibling = kl.filter(function (s) { return s.id !== activeId && s.vehicles > 0; })[0];
    if (othersLive.length > others.length / 2) {
      setVerdict(
        "error",
        "Upstream outage — the feed this site collects is down",
        "<strong>" + esc(activeId) + "</strong> is reporting <strong>0 vehicles</strong>, while " +
          othersLive.length + " of " + others.length +
          " feeds elsewhere in Malaysia are carrying buses" +
          (sibling
            ? ", including " + esc(sibling.id) + " in the same city (" + sibling.vehicles + " buses)"
            : "") +
          ". That rules out a quiet period &mdash; the problem is upstream at " +
          "data.gov.my, not with this site. The live map will stay empty until it returns."
      );
      return;
    }
    setVerdict(
      "warn",
      "Quiet period — most feeds are empty",
      esc(activeId) + " reports no vehicles, but so do most feeds across Malaysia. " +
        "Services wind down overnight, so this is probably normal rather than an outage."
    );
  }

  function render(health) {
    var fs = health && health.feed_source;
    var monitor = (fs && fs.monitor) || {};
    var sources = monitor.sources || [];

    if (!sources.length) {
      setVerdict("load", "No sweep yet", "The server sweeps every feed shortly after start-up. Try again in a minute.");
      return;
    }

    // A feed is "ours" if this process could collect it. The server exposes the
    // one it IS collecting; the KL table below shows both KL feeds regardless.
    var klIds = sources
      .filter(function (s) { return /^rapid-bus-(kl|mrtfeeder)$/.test(s.id); })
      .map(function (s) { return s.id; });

    var kl = sources.filter(function (s) { return klIds.indexOf(s.id) !== -1; });
    var others = sources.filter(function (s) { return klIds.indexOf(s.id) === -1; });

    KL_ROWS.innerHTML = kl
      .map(function (s) { return row(s, fs && s.id === fs.id, s.label || ""); })
      .join("");
    OTHER_ROWS.innerHTML = others
      .map(function (s) { return row(s, false, s.region || ""); })
      .join("");

    renderVerdict(kl, others, (fs && fs.id) || "");

    if (monitor.last_sweep_ms) {
      var mins = Math.round((Date.now() - monitor.last_sweep_ms) / 60000);
      SWEPT.textContent =
        "Last checked " + (mins < 1 ? "less than a minute" : mins + " minute" + (mins === 1 ? "" : "s")) + " ago.";
    }
  }

  function load() {
    fetch("/api/health")
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {
        setVerdict("error", "Could not reach the server", "The status endpoint did not respond.");
      });
  }

  load();
  setInterval(load, 60000);
})();
