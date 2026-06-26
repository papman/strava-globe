/**
 * geocode.js
 *
 * Reverse-geocodes activity start points to country + city.
 * Uses Nominatim (OpenStreetMap) — no API key needed.
 * Results are cached in localStorage keyed by 0.5° grid cell,
 * so most users only hit the API once.
 */

const CACHE_KEY = "strava-globe-geocache-v2";
const GRID_DEG = 0.5; // ~55km cells — coarse enough to avoid re-geocoding the same area

/**
 * Decode only the first [lat, lng] point of a Google-encoded polyline.
 * Avoids loading the full geometry library for this use case.
 */
export function decodePolylineStart(encoded) {
  let index = 0, lat = 0, lng = 0;
  let b, shift, result;

  shift = 0; result = 0;
  do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
  lat += result & 1 ? ~(result >> 1) : result >> 1;

  shift = 0; result = 0;
  do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
  lng += result & 1 ? ~(result >> 1) : result >> 1;

  return [lat / 1e5, lng / 1e5];
}

function gridKey(lat, lng) {
  return `${Math.round(lat / GRID_DEG)},${Math.round(lng / GRID_DEG)}`;
}

/**
 * countryCodeToFlag — converts ISO 3166-1 alpha-2 to emoji flag.
 * e.g. "US" → "🇺🇸"
 */
export function countryCodeToFlag(code) {
  if (!code || code.length !== 2) return "🏳";
  return Array.from(code.toUpperCase())
    .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
    .join("");
}

/**
 * geocodeActivities
 *
 * Takes an array of activities (each with a `polyline` field),
 * determines country + city for each using Nominatim,
 * and returns sorted lists of countries and cities with activity counts.
 *
 * @param {Array} activities
 * @param {Function} onProgress - called with (done, total) as geocoding proceeds
 * @returns {Promise<{ countries: Array, cities: Array }>}
 */
export async function geocodeActivities(activities, onProgress) {
  // Load cache
  let cache = {};
  try {
    cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch {
    cache = {};
  }

  // Cluster activities into 0.5° grid cells, track representative lat/lng
  const gridGroups = {};
  for (const act of activities) {
    if (!act.polyline) continue;
    try {
      const [lat, lng] = decodePolylineStart(act.polyline);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const key = gridKey(lat, lng);
      if (!gridGroups[key]) gridGroups[key] = { lat, lng, count: 0 };
      gridGroups[key].count++;
    } catch {
      // skip malformed polylines
    }
  }

  // Find cells not in cache
  const uncached = Object.entries(gridGroups).filter(([key]) => !cache[key]);

  // Geocode missing cells (rate-limited to 1 req/sec per Nominatim ToS)
  for (let i = 0; i < uncached.length; i++) {
    const [key, { lat, lng }] = uncached[i];
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&accept-language=en`;
      const r = await fetch(url, {
        headers: { "User-Agent": "StravaGlobe/1.0 (strava-globe.vercel.app)" },
      });
      const data = await r.json();
      const addr = data.address || {};

      const country = addr.country || null;
      const countryCode = (addr.country_code || "").toUpperCase() || null;
      const city =
        addr.city ||
        addr.town ||
        addr.village ||
        addr.municipality ||
        addr.county ||
        addr.state ||
        null;

      cache[key] = { country, countryCode, city };
    } catch {
      cache[key] = { country: null, countryCode: null, city: null };
    }

    if (onProgress) onProgress(i + 1, uncached.length);

    // 1.1 second delay to respect Nominatim's 1 req/sec limit
    if (i < uncached.length - 1) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  // Persist cache
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full — skip
  }

  // Tally countries and cities from grid groups
  const countriesMap = {};
  const citiesMap = {};

  for (const [key, { count }] of Object.entries(gridGroups)) {
    const geo = cache[key];
    if (!geo) continue;

    if (geo.country) {
      if (!countriesMap[geo.country]) {
        countriesMap[geo.country] = { name: geo.country, code: geo.countryCode, count: 0 };
      }
      countriesMap[geo.country].count += count;
    }

    if (geo.city && geo.country) {
      const cityKey = `${geo.city}||${geo.country}`;
      if (!citiesMap[cityKey]) {
        citiesMap[cityKey] = {
          name: geo.city,
          country: geo.country,
          countryCode: geo.countryCode,
          count: 0,
        };
      }
      citiesMap[cityKey].count += count;
    }
  }

  return {
    countries: Object.values(countriesMap).sort((a, b) => b.count - a.count),
    cities: Object.values(citiesMap).sort((a, b) => b.count - a.count),
  };
}
