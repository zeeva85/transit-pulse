// weather.js — Open-Meteo integration for KL hourly weather data.
//
// Fetches temperature, precipitation, windspeed, and weathercode for
// Kuala Lumpur. Results are cached to data/weather-<YYYY-MM-DD>.json
// so repeated calls (heatmap renders, correlation queries) hit disk
// instead of the network.
//
// Public API:
//   getWeatherForDate(date)         → Promise<HourlyWeather>
//   getWeatherForDates(dates)       → Promise<Map<date, HourlyWeather>>
//   weatherCodeLabel(code)          → string  (e.g. "Light rain")
//   isRainy(hourData)               → boolean
//
// HourlyWeather shape: { [hour: 0..23]: { temp, precip, wind, code } }
//   temp   — °C
//   precip — mm (last hour)
//   wind   — km/h
//   code   — WMO weather interpretation code

const fetch = require("node-fetch");
const fs    = require("fs");
const path  = require("path");
const config = require("./config");

const DATA_DIR = path.join(__dirname, "data");

// Open-Meteo archive endpoint (historical, no API key needed).
// For the current day we fall back to the forecast endpoint.
const ARCHIVE_URL  = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const VARIABLES    = "temperature_2m,precipitation,windspeed_10m,weathercode";

// KL coordinates — matches config.KL_CENTER exactly.
const LAT = config.KL_CENTER.lat;
const LON = config.KL_CENTER.lon;

// In-memory LRU cache (capped at WEATHER_CACHE_LIMIT dates).
// Avoids re-reading disk on rapid sequential renders.
const memCache = new Map();

function cacheFile(date) {
  return path.join(DATA_DIR, `weather-${date}.json`);
}

function klDateToday() {
  // Current date in KL timezone (UTC+8).
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

// Parse the Open-Meteo hourly arrays into { [hour]: { temp, precip, wind, code } }.
function parseResponse(data) {
  const h = data.hourly;
  if (!h || !h.time) return {};
  const result = {};
  h.time.forEach((t, i) => {
    // time strings are "YYYY-MM-DDTHH:00" in the requested timezone.
    const hour = parseInt(t.slice(11, 13), 10);
    result[hour] = {
      temp:   h.temperature_2m   ? h.temperature_2m[i]   : null,
      precip: h.precipitation    ? h.precipitation[i]    : null,
      wind:   h.windspeed_10m    ? h.windspeed_10m[i]    : null,
      code:   h.weathercode      ? h.weathercode[i]      : null,
    };
  });
  return result;
}

async function fetchFromNetwork(date) {
  const today = klDateToday();
  // Archive API covers up to yesterday; today's data uses forecast endpoint.
  const isToday = date === today;
  const base = isToday ? FORECAST_URL : ARCHIVE_URL;
  const url = `${base}?latitude=${LAT}&longitude=${LON}` +
              `&start_date=${date}&end_date=${date}` +
              `&hourly=${VARIABLES}` +
              `&timezone=Asia%2FKuala_Lumpur`;

  const res = await fetch(url, { timeout: 15_000 });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} for ${date}`);
  const json = await res.json();
  return parseResponse(json);
}

// Main entry point — returns HourlyWeather for a single date string "YYYY-MM-DD".
// Reads from mem cache → disk cache → network, in that order.
async function getWeatherForDate(date) {
  // 1. Memory cache.
  if (memCache.has(date)) return memCache.get(date);

  // 2. Disk cache (skip for today — data still accumulating).
  const today = klDateToday();
  const file = cacheFile(date);
  if (date !== today && fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      _memSet(date, parsed);
      return parsed;
    } catch (_) { /* corrupt cache — fall through to network */ }
  }

  // 3. Network fetch.
  const hourly = await fetchFromNetwork(date);

  // Persist to disk for past dates (today keeps updating so we don't cache it).
  if (date !== today) {
    try { fs.writeFileSync(file, JSON.stringify(hourly)); } catch (_) {}
  }

  _memSet(date, hourly);
  return hourly;
}

// Batch fetch for multiple dates — parallelises network requests.
async function getWeatherForDates(dates) {
  const results = new Map();
  await Promise.all(dates.map(async (d) => {
    try { results.set(d, await getWeatherForDate(d)); }
    catch (e) { results.set(d, {}); } // graceful degradation per date
  }));
  return results;
}

// Evict oldest entry when mem cache grows beyond limit.
function _memSet(date, data) {
  if (memCache.size >= config.WEATHER_CACHE_LIMIT) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(date, data);
}

// WMO weather interpretation code → human label.
// Source: https://open-meteo.com/en/docs (WMO Weather Code table).
const WMO_LABELS = {
  0:  "Clear sky",
  1:  "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Icy fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow",
  77: "Snow grains",
  80: "Light showers", 81: "Showers", 82: "Heavy showers",
  85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm + hail", 99: "Thunderstorm + heavy hail",
};

function weatherCodeLabel(code) {
  if (code == null) return "Unknown";
  return WMO_LABELS[code] || `Code ${code}`;
}

// Convenience — true when precipitation > 0 or code indicates rain/storm.
function isRainy(hourData) {
  if (!hourData) return false;
  if (hourData.precip > 0) return true;
  const c = hourData.code;
  return c != null && (c >= 51 && c <= 99);
}

module.exports = { getWeatherForDate, getWeatherForDates, weatherCodeLabel, isRainy };
