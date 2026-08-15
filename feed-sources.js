// feed-sources.js — feed registry, boot-time source selection, and monitoring.
//
// Exists because on 2026-08-06 the rapid-bus-kl feed stopped returning vehicles
// without erroring — HTTP 200 with an entity-less FeedMessage — so every
// error-based detector missed it and collection sat at zero for two months.
// The fix is monitoring, not automatic substitution.
//
// ONE CITY PER PROCESS. Auto-switching is allowed ONLY between the two Kuala
// Lumpur feeds (rapid-bus-kl <-> rapid-bus-mrtfeeder), which is safe because
// they share no bus ids and no route labels — see the note above
// switchCandidate. Switching across cities was built and removed; CLAUDE.md
// lists what it broke. To collect another city, run another process:
//
//   FEED_SOURCE=mybas-johor DATA_DIR=./data-johor GTFS_DIR=./gtfs-johor node server.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const fetch = require("node-fetch");
const { transit_realtime } = require("gtfs-realtime-bindings");
const config = require("./config");

const RT_BASE = "https://api.data.gov.my/gtfs-realtime/vehicle-position";
const STATIC_BASE = "https://api.data.gov.my/gtfs-static";

// Every known feed. The monitor sweeps all of them, because a source reading
// zero only means something compared against its siblings.
const SOURCES = config.FEED_SOURCES;

// Collectable = Kuala Lumpur only. Everything in this app (map, static GTFS,
// speed baselines, cross-day model) is KL, so another state would pollute it.
const COLLECTABLE = SOURCES.filter((s) => s.kl);

// A candidate must be properly busy before auto-switch commits to it. Both KL
// feeds drain to zero overnight, so "more than zero" would flap nightly.
const MIN_VEHICLES = config.FEED_MIN_VEHICLES_TO_SWITCH;
const PROBE_TIMEOUT_MS = config.FEED_PROBE_TIMEOUT_MS;
const MONITOR_INTERVAL_MS = config.FEED_MONITOR_INTERVAL_MS;

// Extracted from a source's static ZIP. The rest of the GTFS set is unused here
// and stop_times.txt alone is ~5 MB.
const WANTED_FILES = new Set(["routes.txt", "trips.txt", "shapes.txt"]);

// Trailing slash before the query string skips data.gov.my's 301, saving a
// round trip on every poll. The static endpoints do the opposite (302 WITH a
// slash), so staticUrl below deliberately omits it.
function rtUrl(src) {
  const [base, query] = src.path.split("?");
  return `${RT_BASE}/${base}/${query ? `?${query}` : ""}`;
}

function staticUrl(src) {
  return `${STATIC_BASE}/${src.path}`;
}

function byId(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

// ── Boot-time source selection ──────────────────────────────────────────────
// Resolved once at module load. Deliberately no setter.
const PRIMARY = COLLECTABLE[0];

function resolveSource() {
  const requested = (process.env.FEED_SOURCE || "").trim();
  if (!requested) return PRIMARY;
  const found = COLLECTABLE.find((s) => s.id === requested);
  if (found) return found;

  // Fail loudly rather than collect the wrong city into a directory named for
  // another. A known-but-non-KL id is the likely mistake, so say why.
  const ids = COLLECTABLE.map((s) => s.id).join(", ");
  const why = byId(requested)
    ? "is a known feed but is not a KL bus service, which this app cannot collect"
    : "is not a known feed source";
  throw new Error(`FEED_SOURCE="${requested}" ${why}. Options: ${ids}`);
}

// The source picked at boot. Auto-switch may move ACTIVE off this, but PINNED
// is what an explicit FEED_SOURCE asked for, and auto-switch never overrides an
// explicit choice.
const PINNED = resolveSource();
const PINNED_EXPLICIT = !!(process.env.FEED_SOURCE || "").trim();
let ACTIVE = PINNED;

function activeSource() {
  return ACTIVE;
}

function isPrimary() {
  return ACTIVE.id === PRIMARY.id;
}

// ── Auto-switch between the two KL feeds ────────────────────────────────────
// Scoped deliberately to rapid-bus-kl <-> rapid-bus-mrtfeeder and nothing else.
// Measured 2026-08-15 across 324 KL trunk bus ids and 145 live feeder ids:
// ZERO bus_id overlap and ZERO route-label overlap (trunk uses "151 – …",
// feeder uses "T100"). Same operator, same Klang Valley, so the map centre,
// weather and speed baselines all stay correct too. That is what makes
// switching safe here when the 14-city version was not.
//
// Switching is still a real event: the caller must clear per-bus state and
// reload the GTFS bundle. server.js:applySourceSwitch does both.
let switchCount = 0;
let lastSwitchMs = null;

function switchCandidate(sweepResults) {
  // Never override an operator's explicit FEED_SOURCE.
  if (PINNED_EXPLICIT) return null;
  if (!sweepResults || !sweepResults.length) return null;

  const countOf = (id) => {
    const row = sweepResults.filter((r) => r.id === id)[0];
    return row ? row.vehicles : -1;
  };
  const activeCount = countOf(ACTIVE.id);
  if (activeCount > 0) {
    // Healthy. Return home if we are on the fallback and the preferred feed
    // has recovered.
    if (ACTIVE.id !== PINNED.id && countOf(PINNED.id) >= MIN_VEHICLES) return PINNED;
    return null;
  }

  // Active is empty or unreachable. Move only to a KL sibling that is properly
  // busy — a lone straggler at 2 a.m. must not trigger a switch, since both
  // feeds legitimately drain overnight.
  const sibling = COLLECTABLE.filter(
    (s) => s.id !== ACTIVE.id && countOf(s.id) >= MIN_VEHICLES
  )[0];
  return sibling || null;
}

function setActive(src) {
  if (!src || src.id === ACTIVE.id) return null;
  const from = ACTIVE.id;
  ACTIVE = src;
  switchCount += 1;
  lastSwitchMs = Date.now();
  console.warn(`[feed] switching source ${from} -> ${src.id} (${src.label})`);
  return src;
}

// ── Probing / monitoring ────────────────────────────────────────────────────

// Vehicle count, or -1 if the probe failed. -1 must stay distinct from 0: zero
// means "reachable but no buses", the normal overnight state for every
// Malaysian feed, and is not an outage on its own.
async function probe(src) {
  try {
    const res = await fetch(rtUrl(src), { timeout: PROBE_TIMEOUT_MS });
    if (!res.ok) return -1;
    const buf = Buffer.from(await res.arrayBuffer());
    const msg = transit_realtime.FeedMessage.decode(buf);
    return msg.entity ? msg.entity.length : 0;
  } catch {
    return -1;
  }
}

// Last sweep, exposed via /api/health. Observational only — nothing in the
// collection path reads it, so a slow sweep can never affect data.
let lastSweep = { at: null, results: [] };
let sweepInFlight = false;

async function runMonitorSweep() {
  if (sweepInFlight) return lastSweep;
  sweepInFlight = true;
  try {
    const results = [];
    // Series, not parallel — cheap probes, and no reason to open 14 concurrent
    // connections to a government API.
    for (const src of SOURCES) {
      const vehicles = await probe(src);
      results.push({ id: src.id, label: src.label, region: src.region, vehicles });
    }
    lastSweep = { at: Date.now(), results };
    const alive = results.filter((r) => r.vehicles > 0);
    const empty = results.filter((r) => r.vehicles === 0);
    const unreachable = results.filter((r) => r.vehicles < 0);
    console.log(
      `[monitor] swept ${results.length} sources — ${alive.length} carrying vehicles, ` +
        `${empty.length} empty, ${unreachable.length} unreachable`
    );
    if (unreachable.length) {
      console.warn(`[monitor] unreachable: ${unreachable.map((r) => r.id).join(", ")}`);
    }

    // Zero proves nothing alone (every feed drains overnight), but zero WHILE
    // the siblings are busy is an outage. This is the alert that was missing.
    const others = results.filter((r) => !COLLECTABLE.some((c) => c.id === r.id));
    const othersAlive = others.filter((r) => r.vehicles > 0).length;
    for (const src of COLLECTABLE) {
      const row = results.find((r) => r.id === src.id);
      if (row && row.vehicles === 0 && othersAlive > others.length / 2) {
        console.warn(
          `[monitor] ⚠ ${src.id} reports 0 vehicles while ${othersAlive}/${others.length} ` +
            `other Malaysian feeds are carrying buses — this looks like an upstream ` +
            `outage of ${src.id}, not a quiet period.`
        );
      }
    }
    return lastSweep;
  } finally {
    sweepInFlight = false;
  }
}

// onCandidate(src) is invoked after each sweep when auto-switch wants to move.
// It is NOT applied here: the caller decides when it is safe to swap (server.js
// stages it and applies it synchronously at the top of the next tick, so a
// switch can never land mid-tick).
function startMonitor(onCandidate) {
  const sweepThenDecide = () =>
    runMonitorSweep()
      .then((sweep) => {
        if (!onCandidate) return;
        const next = switchCandidate(sweep.results);
        if (next) onCandidate(next);
      })
      .catch(() => {});

  // Kick one off shortly after boot so /api/health has data early, then repeat.
  const first = setTimeout(sweepThenDecide, 20_000);
  const timer = setInterval(sweepThenDecide, MONITOR_INTERVAL_MS);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return timer;
}

function monitorStatus() {
  return {
    last_sweep_ms: lastSweep.at,
    sources: lastSweep.results,
    pinned: PINNED.id,
    pinned_explicit: PINNED_EXPLICIT,
    switch_count: switchCount,
    last_switch_ms: lastSwitchMs,
  };
}

// ── Minimal ZIP reader ──────────────────────────────────────────────────────
// Static GTFS feeds are ZIPs and this project adds no unzip dependency, so this
// uses built-in zlib only. Walks the central directory rather than scanning for
// local headers, since data-descriptor entries have zeroed local sizes.
function readZipEntries(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip archive (no EOCD record)");

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = [];

  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break; // central directory header
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString("utf8");

    // Jump to the local header to find where the payload actually starts — its
    // extra field can differ in length from the central directory's.
    if (buf.readUInt32LE(localOffset) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(start, start + compSize);
      out.push({
        name: path.basename(name),
        data: method === 8 ? zlib.inflateRawSync(raw) : raw,
      });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── Static GTFS bootstrap for a non-primary source ──────────────────────────
// Only used when FEED_SOURCE selects something other than rapid-bus-kl AND its
// GTFS_DIR has not been populated yet. The primary keeps using the committed
// gtfs_static/ directory exactly as before.
async function ensureStaticDir(src, dir) {
  const marker = path.join(dir, "routes.txt");
  if (fs.existsSync(marker)) return dir;

  console.log(`[gtfs] ${dir} is empty — downloading static feed for ${src.id} …`);
  const res = await fetch(staticUrl(src), { timeout: 60_000 });
  if (!res.ok) throw new Error(`static feed for ${src.id} returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const entries = readZipEntries(buf).filter((e) => WANTED_FILES.has(e.name));
  if (!entries.length) {
    throw new Error(`static feed for ${src.id} contained none of ${[...WANTED_FILES]}`);
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const e of entries) {
    // Atomic per-file write so a killed process can't leave a half-written
    // routes.txt that the existsSync marker above would treat as complete.
    const dest = path.join(dir, e.name);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, e.data);
    fs.renameSync(tmp, dest);
  }
  console.log(`[gtfs] cached ${entries.map((e) => e.name).join(", ")} for ${src.id}`);
  return dir;
}

module.exports = {
  SOURCES,
  COLLECTABLE,
  PRIMARY,
  PINNED,
  switchCandidate,
  setActive,
  activeSource,
  isPrimary,
  byId,
  probe,
  runMonitorSweep,
  startMonitor,
  monitorStatus,
  ensureStaticDir,
  readZipEntries,
  rtUrl,
  staticUrl,
};
