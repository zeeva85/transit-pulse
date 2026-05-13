# Transit Pulse .MY

A live map and historical analytics view for Kuala Lumpur's RapidKL bus network, built on Malaysia's open GTFS-Realtime feed.

GTFS-Realtime is the open standard for transit feeds. The RapidKL data is published by Malaysia's open data portal at [data.gov.my](https://data.gov.my).

## Features

- Live tracking of every RapidKL bus, with trails snapped to GTFS route polylines
- Historical playback by date, time period, or hour-of-day range
- Density visualization with absolute thresholds (distinct buses per cell)
- Hierarchical route clustering by speed pattern
- Light / dark mode

## Tech stack

**Backend** — Node.js, Express, `gtfs-realtime-bindings`, `hyparquet`, `@dsnp/parquetjs`

**Frontend** — vanilla JavaScript, MapLibre GL, deck.gl, ECharts

**Storage** — JSONL append-only for live ingest, Parquet for daily archives

## Experimental features

- **Four-state Extended Kalman Filter** for position and velocity, with divergence reset and GPS-jump gating
- **Five outlier-correction methods** (IQR, robust, percentile, z-score, min-max) selectable at runtime
- **Hierarchical clustering** (Ward + Euclidean, average + correlation, Lance-Williams updates) — hand-rolled
- **Trail snapping** with perpendicular projection and 30 m shape-variant stickiness
- **Cross-day position model** — three-tier fallback with fractional bucket interpolation; cleans bad GPS without modifying raw lat/lon
- **Learned-route pipeline** — buses with unknown routes accumulate observations and graduate to supplementary GTFS shapes after three days and 100+ positions
- 5-mode speed heatmap across routes × hours-of-day — currently broken.
- - Hour-of-day clustering across routes.


## Running locally

```bash
git clone https://github.com/zeeva85/transit-pulse.git
cd transit-pulse
npm install
cp .env.example .env
node server.js
# http://localhost:3000
```

No build step. The frontend uses CDN-hosted libraries.

## Known issues

- Learned-route deduplication is incomplete. Two buses covering the same unknown route can produce near-identical learned shapes.
- Live trails ignore learned shapes until next-day augmentation.
- Short connector lines may appear at terminus turnarounds where buses transition between shape variants. Capped at 3 km.

## License

MIT
