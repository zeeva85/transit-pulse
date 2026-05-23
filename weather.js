// weather.js — WeatherAPI.com integration for KL hourly weather data.
//
// Requires WEATHERAPI_KEY environment variable.
//
// Fetches temperature, precipitation, windspeed, and condition code for
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
//   code   — WeatherAPI condition code (1000=Clear, 1183=Light rain, etc.)

const fetch = require("node-fetch");
const fs    = require("fs");
const path  = require("path");
const config = require("./config");

const DATA_DIR = path.join(__dirname, "data");
const API_KEY  = process.env.WEATHERAPI_KEY || "";
const BASE_URL = "https://api.weatherapi.com/v1";

// KL coordinates — matches config.KL_CENTER exactly.
const LAT = config.KL_CENTER.lat;
const LON = config.KL_CENTER.lon;
const Q   = `${LAT},${LON}`;

// In-memory LRU cache (capped at WEATHER_CACHE_LIMIT dates).
const memCache = new Map();

function cacheFile(date) {
  return path.join(DATA_DIR, `weather-${date}.json`);
}

function klDateToday() {
  // Current date in KL timezone (UTC+8).
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

// Parse WeatherAPI hourly array into { [hour]: { temp, precip, wind, code } }.
// Each element: { time: "YYYY-MM-DD HH:MM", temp_c, precip_mm, wind_kph, condition: { code } }
function parseHourly(hours) {
  const result = {};
  for (const h of hours) {
    const hour = parseInt(h.time.slice(11, 13), 10);
    result[hour] = {
      temp:           h.temp_c                          ?? null,
      precip:         h.precip_mm                       ?? null,
      wind:           h.wind_kph                        ?? null,
      code:           h.condition?.code                 ?? null,
      humidity:       h.humidity                        ?? null,
      uv:             h.uv                              ?? null,
      chance_of_rain: h.chance_of_rain                  ?? null,
      aqi_index:      h.air_quality?.["us-epa-index"]   ?? null,
      aqi_pm25:       h.air_quality?.pm2_5             ?? null,
    };
  }
  return result;
}

async function fetchFromNetwork(date) {
  if (!API_KEY) throw new Error("WEATHERAPI_KEY not set");
  const today   = klDateToday();
  const isToday = date === today;

  let hourly;

  if (isToday) {
    // Forecast endpoint covers today's full hourly breakdown.
    const url = `${BASE_URL}/forecast.json?key=${API_KEY}&q=${Q}&days=1&aqi=yes&alerts=no`;
    const res = await fetch(url, { timeout: 15_000 });
    if (!res.ok) throw new Error(`WeatherAPI forecast ${res.status} for ${date}`);
    const json = await res.json();
    const hours = json.forecast?.forecastday?.[0]?.hour ?? [];
    hourly = parseHourly(hours);

    // Override current hour with real-time reading — no model lag.
    try {
      const curUrl = `${BASE_URL}/current.json?key=${API_KEY}&q=${Q}&aqi=yes`;
      const curRes = await fetch(curUrl, { timeout: 15_000 });
      if (curRes.ok) {
        const cur = await curRes.json();
        console.log("[weather] current air_quality:", JSON.stringify(cur.current?.air_quality));
        const c   = cur.current;
        if (c && cur.location?.localtime) {
          const hour = parseInt(cur.location.localtime.slice(11, 13), 10);
          hourly[hour] = {
            temp:           c.temp_c                        ?? null,
            precip:         c.precip_mm                     ?? null,
            wind:           c.wind_kph                      ?? null,
            code:           c.condition?.code               ?? null,
            humidity:       c.humidity                      ?? null,
            uv:             c.uv                            ?? null,
            chance_of_rain: hourly[hour]?.chance_of_rain    ?? null,
            aqi_index:      c.air_quality?.["us-epa-index"] ?? null,
            aqi_pm25:       c.air_quality?.pm2_5            ?? null,
          };
        }
      }
    } catch (_) { /* current fetch failed — forecast stands */ }
  } else {
    // History endpoint for past dates.
    const url = `${BASE_URL}/history.json?key=${API_KEY}&q=${Q}&dt=${date}&aqi=yes`;
    const res = await fetch(url, { timeout: 15_000 });
    if (!res.ok) throw new Error(`WeatherAPI history ${res.status} for ${date}`);
    const json = await res.json();
    const hours = json.forecast?.forecastday?.[0]?.hour ?? [];
    hourly = parseHourly(hours);
  }

  return hourly;
}

// Main entry point — returns HourlyWeather for a single date string "YYYY-MM-DD".
// Reads from mem cache → disk cache → network, in that order.
// Today's date skips both caches (server.js:getCurrentWeather throttles via weatherHourCache).
async function getWeatherForDate(date) {
  const today = klDateToday();

  // 1. Memory cache (past dates only — today is always fetched fresh).
  if (date !== today && memCache.has(date)) return memCache.get(date);

  // 2. Disk cache (past dates only).
  const file = cacheFile(date);
  if (date !== today && fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      _memSet(date, parsed);
      return parsed;
    } catch (_) {
      try { fs.unlinkSync(file); } catch (_2) {}
    }
  }

  // 3. Network fetch.
  const hourly = await fetchFromNetwork(date);

  // Persist/cache past dates only.
  if (date !== today) {
    try { fs.writeFileSync(file, JSON.stringify(hourly)); } catch (_) {}
    _memSet(date, hourly);
  }

  return hourly;
}

// Batch fetch for multiple dates — parallelises network requests.
async function getWeatherForDates(dates) {
  const results = new Map();
  await Promise.all(dates.map(async (d) => {
    try { results.set(d, await getWeatherForDate(d)); }
    catch (e) { results.set(d, {}); }
  }));
  return results;
}

function _memSet(date, data) {
  if (memCache.size >= config.WEATHER_CACHE_LIMIT) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(date, data);
}

// WeatherAPI condition code → human label.
const CONDITION_LABELS = {
  1000: "Clear",
  1003: "Partly cloudy",
  1006: "Cloudy",
  1009: "Overcast",
  1030: "Mist",
  1063: "Patchy rain",
  1066: "Patchy snow",
  1069: "Patchy sleet",
  1072: "Patchy freezing drizzle",
  1087: "Thundery outbreaks",
  1114: "Blowing snow",
  1117: "Blizzard",
  1135: "Fog",
  1147: "Freezing fog",
  1150: "Light drizzle",
  1153: "Light drizzle",
  1168: "Freezing drizzle",
  1171: "Heavy freezing drizzle",
  1180: "Light rain",
  1183: "Light rain",
  1186: "Moderate rain",
  1189: "Moderate rain",
  1192: "Heavy rain",
  1195: "Heavy rain",
  1198: "Light freezing rain",
  1201: "Freezing rain",
  1204: "Light sleet",
  1207: "Sleet",
  1210: "Light snow",
  1213: "Light snow",
  1216: "Moderate snow",
  1219: "Moderate snow",
  1222: "Heavy snow",
  1225: "Heavy snow",
  1237: "Ice pellets",
  1240: "Light showers",
  1243: "Showers",
  1246: "Torrential rain",
  1249: "Light sleet showers",
  1252: "Sleet showers",
  1255: "Light snow showers",
  1258: "Snow showers",
  1261: "Ice pellet showers",
  1264: "Ice pellet showers",
  1273: "Thunderstorm",
  1276: "Thunderstorm",
  1279: "Snow thunderstorm",
  1282: "Snow thunderstorm",
};

// Condition codes that indicate rain/precipitation — used by isRainy() as a
// fallback when precip_mm is zero but conditions are wet (drizzle, sleet, storms).
const RAINY_CODES = new Set([
  1063, 1069, 1072, 1087,
  1150, 1153, 1168, 1171,
  1180, 1183, 1186, 1189, 1192, 1195, 1198, 1201,
  1204, 1207,
  1240, 1243, 1246, 1249, 1252,
  1273, 1276,
]);

function weatherCodeLabel(code) {
  if (code == null) return "Unknown";
  return CONDITION_LABELS[code] || `Code ${code}`;
}

// True when precipitation > 0 mm or the condition code indicates wet weather.
function isRainy(hourData) {
  if (!hourData) return false;
  if (hourData.precip > 0) return true;
  return hourData.code != null && RAINY_CODES.has(hourData.code);
}

module.exports = { getWeatherForDate, getWeatherForDates, weatherCodeLabel, isRainy };
