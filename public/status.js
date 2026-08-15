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

  // Lead with the human name; the machine id goes underneath in small mono type.
  // Leading with the id was both ugly and made the "collecting" pill run
  // straight into it ("rapid-bus-mrtfeedercollecting").
  function row(src, isOurs, regionCol) {
    var name = src.label || src.id;
    return (
      '<tr class="' + (isOurs ? "is-ours" : "") + '">' +
      "<td>" +
        '<div class="svc">' + esc(name) +
          (isOurs ? ' <span class="pill ours">on the map</span>' : "") +
        "</div>" +
        '<div class="fid">' + esc(src.id) + "</div>" +
      "</td>" +
      (regionCol === null ? "" : "<td>" + esc(regionCol) + "</td>") +
      "<td>" + statusPill(src.vehicles) + "</td>" +
      '<td class="num">' + (src.vehicles < 0 ? "&mdash;" : src.vehicles) + "</td>" +
      "</tr>"
    );
  }

  function setVerdict(cls, title, body) {
    VERDICT.className = "verdict " + cls;
    VERDICT.innerHTML = '<span class="v-title">' + esc(title) + "</span>" + body;
  }

  // The whole point of the page: is the feed WE COLLECT dead, or is the country
  // quiet? Judged on the collecting feed specifically — a healthy sibling does
  // not mean the map has buses on it.
  function renderVerdict(kl, others, activeId) {
    var othersLive = others.filter(function (s) { return s.vehicles > 0; });
    var active = kl.filter(function (s) { return s.id === activeId; })[0];
    var klDown = kl.filter(function (s) { return s.vehicles === 0; });

    var nameOf = function (s) { return esc(s.label || s.id); };

    if (active && active.vehicles > 0) {
      var extra = klDown.length
        ? " " + klDown.map(nameOf).join(" and ") + " is still down."
        : "";
      setVerdict(
        "ok",
        "The map is live",
        "Showing <strong>" + nameOf(active) + "</strong>, which is reporting " +
          active.vehicles + " buses right now." + extra
      );
      return;
    }

    var sibling = kl.filter(function (s) { return s.id !== activeId && s.vehicles > 0; })[0];
    var activeName = active ? nameOf(active) : esc(activeId);

    if (othersLive.length > others.length / 2) {
      setVerdict(
        "error",
        activeName + " has stopped reporting",
        "It is showing no buses at all, while " + othersLive.length + " of " +
          others.length + " other feeds around Malaysia are running normally" +
          (sibling ? ", including " + nameOf(sibling) + " here in Kuala Lumpur" : "") +
          ". So this is not just a quiet time of day. The problem is at " +
          "data.gov.my, not with this site, and the map will stay empty until " +
          "they fix it."
      );
      return;
    }
    setVerdict(
      "warn",
      "All quiet",
      activeName + " is showing no buses, but so are most other feeds around " +
        "Malaysia. Services stop overnight, so this is normal."
    );
  }

  function render(health) {
    var fs = health && health.feed_source;
    var monitor = (fs && fs.monitor) || {};
    var sources = monitor.sources || [];

    if (!sources.length) {
      setVerdict("load", "Not checked yet", "The server checks every feed shortly after starting up. Try again in a minute.");
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
      .map(function (s) { return row(s, !!(fs && s.id === fs.id), null); })
      .join("");
    OTHER_ROWS.innerHTML = others
      .map(function (s) { return row(s, false, s.region || "—"); })
      .join("");

    renderVerdict(kl, others, (fs && fs.id) || "");

    if (monitor.last_sweep_ms) {
      var mins = Math.round((Date.now() - monitor.last_sweep_ms) / 60000);
      SWEPT.textContent =
        mins < 1 ? "Checked just now." : "Checked " + mins + " minute" + (mins === 1 ? "" : "s") + " ago.";
    }
  }

  function load() {
    fetch("/api/health")
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {
        setVerdict("error", "Could not reach the server", "This page could not load the latest counts.");
      });
  }

  load();
  setInterval(load, 60000);
})();
