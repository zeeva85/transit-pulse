// feed-sources.js — feed source registry, boot-time selection, and monitoring.
//
// WHY THIS MODULE EXISTS
// ----------------------
// On 2026-08-06 at 13:59 KL the upstream `rapid-bus-kl` vehicle-position feed
// stopped returning vehicles. Critically it did NOT start erroring: it kept
// answering HTTP 200 with a structurally valid, entity-less FeedMessage whose
// header timestamp still ticked forward. Every failure detector in the app was
// watching for HTTP errors, so nothing fired and the pipeline quietly collected
// zero rows for over a week. Two other developers independently hit the same
// wall on 2026-08-13 (data-gov-my/datagovmy-front#659); an identical outage
// reported on 2026-03-29 (#638) is still unanswered by data.gov.my.
//
// THE FIX IS MONITORING, NOT AUTOMATIC SUBSTITUTION
// -------------------------------------------------
// The first attempt at this made the process swap its active source at runtime
// when the primary went cold. That was wrong, in a way worth recording so it is
// not rebuilt later:
//
//   - This app is Kuala Lumpur specific. Its map, its static GTFS, its speed
//     baselines and every analytic in it are KL. Penang buses are not a
//     substitute for KL buses; they are a different dataset.
//   - `bus_id` is only unique WITHIN an agency, so mixing two agencies into one
//     process corrupted the per-bus EKF/trust state, the cross-day position
//     model (which then rewrote positions to another city and persisted them),
//     and the learned-shapes pipeline (which promoted a foreign route into KL's
//     own extended_shapes.txt).
//   - Swapping a global mid-flight raced with the in-flight tick, mislabelled
//     rows, and could wedge the process with no path back.
//
// So: ONE SOURCE PER PROCESS, chosen at boot and never changed. Node module
// state is already per-process and every history scanner reads a single
// directory, so process-per-source gives full isolation with no refactor at
// all. To collect another city, run another process:
//
//   FEED_SOURCE=mybas-johor DATA_DIR=./data-johor GTFS_DIR=./gtfs-johor node server.js
//
// (Note the 512 MB Railway container fits exactly one collector — the cross-day
// scan alone has been measured at 500+ MB peak RSS, see store.js. Multiple
// collectors are for the larger migration target.)
//
// What this module still does is watch every source continuously and report,
// so a silent feed is loud within minutes instead of two months.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const fetch = require("node-fetch");
const { transit_realtime } = require("gtfs-realtime-bindings");
const config = require("./config");

const RT_BASE = "https://api.data.gov.my/gtfs-realtime/vehicle-position";
const STATIC_BASE = "https://api.data.gov.my/gtfs-static";

// Every known feed. Swept by the monitor so a dead source can be compared
// against its siblings — that comparison is the only reliable way to tell a
// broken feed from a legitimately quiet night.
const SOURCES = config.FEED_SOURCES;

// The subset this app is allowed to COLLECT. Kuala Lumpur only: the map, the
// static GTFS, the speed baselines and the cross-day position model are all KL,
// so collecting another state would pollute them rather than substitute for
// them. `rapid-bus-kl` is the trunk network; `rapid-bus-mrtfeeder` is the same
// operator's T-prefixed feeder network over the same Klang Valley area.
const COLLECTABLE = SOURCES.filter((s) => s.kl);

const PROBE_TIMEOUT_MS = config.FEED_PROBE_TIMEOUT_MS;
const MONITOR_INTERVAL_MS = config.FEED_MONITOR_INTERVAL_MS;

// Only these files are extracted from a source's static ZIP. The feeds ship the
// full GTFS set, but stop_times.txt alone is ~5 MB for KL and nothing in the
// live path reads it.
const WANTED_FILES = new Set(["routes.txt", "trips.txt", "shapes.txt"]);

// The realtime endpoints 301-redirect any path without a trailing slash
// (`/prasarana?category=x` → `/prasarana/?category=x`). node-fetch follows it
// so nothing broke, but that is a wasted round trip on every single poll —
// ~2,900 per day at the 30 s cadence. Insert the slash before the query string
// so we hit 200 directly. Verified 2026-08-15: with the slash both the
// `prasarana?category=` and bare `mybas-*` forms return 200 with no redirect.
function rtUrl(src) {
  const [base, query] = src.path.split("?");
  return `${RT_BASE}/${base}/${query ? `?${query}` : ""}`;
}

// NOTE: the static endpoints behave the OPPOSITE way — a trailing slash there
// returns 302, so staticUrl deliberately does not add one.
function staticUrl(src) {
  return `${STATIC_BASE}/${src.path}`;
}

function byId(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

// ── Boot-time source selection ──────────────────────────────────────────────
// Resolved ONCE at module load. There is deliberately no setter: the whole
// point of the design is that a process never changes source under itself.
const PRIMARY = COLLECTABLE[0];

function resolveSource() {
  const requested = (process.env.FEED_SOURCE || "").trim();
  if (!requested) return PRIMARY;
  const found = COLLECTABLE.find((s) => s.id === requested);
  if (found) return found;

  // Fail loudly rather than silently collecting the wrong city into a
  // directory named for a different one. Distinguish "not a feed at all" from
  // "a real feed, but not a KL one" — the second is the likely mistake, and
  // the message needs to explain why it is refused rather than look like a typo.
  const ids = COLLECTABLE.map((s) => s.id).join(", ");
  if (byId(requested)) {
    throw new Error(
      `FEED_SOURCE="${requested}" is a known feed but is not a Kuala Lumpur bus ` +
        `service, so this app will not collect it: its map, static GTFS and speed ` +
        `baselines are all KL, and mixing another state's buses into them corrupts ` +
        `the cross-day position model and the learned-shapes pipeline. ` +
        `Collectable ids: ${ids}. (All feeds are still monitored — see /api/health.)`
    );
  }
  throw new Error(
    `FEED_SOURCE="${requested}" is not a known feed source. Collectable ids: ${ids}`
  );
}

const ACTIVE = resolveSource();

function activeSource() {
  return ACTIVE;
}

function isPrimary() {
  return ACTIVE.id === PRIMARY.id;
}

// ── Probing / monitoring ────────────────────────────────────────────────────

// Vehicle count for a source, or -1 if the probe itself failed. -1 is
// deliberately distinct from 0: zero means "reachable but no buses right now",
// which is the normal overnight state (verified 2026-08-15, every Malaysian
// feed drains to 0-6 vehicles around 02:00 KL) and must never be read as an
// outage on its own.
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

// Last full sweep, exposed via /api/health. Purely observational — nothing in
// the collection path reads this, so a slow or failed sweep can never affect
// data collection.
let lastSweep = { at: null, results: [] };
let sweepInFlight = false;

async function runMonitorSweep() {
  if (sweepInFlight) return lastSweep;
  sweepInFlight = true;
  try {
    const results = [];
    // Series, not parallel: probes are cheap (an empty feed is 15 bytes) and we
    // would rather take a few extra seconds than open 14 simultaneous
    // connections to a government API we do not control.
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

    // The one line worth reading. A source at zero proves nothing on its own —
    // every Malaysian feed drains overnight — but a source at zero WHILE its
    // siblings are busy is an upstream outage, which is exactly the state that
    // went unnoticed from 2026-08-06 to 2026-08-15. Only warn about feeds this
    // process could actually collect; the rest are context, not our problem.
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

function startMonitor() {
  // Kick one off shortly after boot so /api/health has data early, then repeat.
  const first = setTimeout(() => runMonitorSweep().catch(() => {}), 20_000);
  const timer = setInterval(() => runMonitorSweep().catch(() => {}), MONITOR_INTERVAL_MS);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return timer;
}

function monitorStatus() {
  return {
    last_sweep_ms: lastSweep.at,
    sources: lastSweep.results,
  };
}

// ── Minimal ZIP reader ──────────────────────────────────────────────────────
// The static GTFS feeds are ZIP archives and the project has no unzip
// dependency (and deliberately does not add one — see the npm-install policy in
// CLAUDE.md). Everything below uses only built-in zlib. It walks the central
// directory rather than scanning for local-header signatures, because entries
// written with a data descriptor carry zeroed sizes in the local header.
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
