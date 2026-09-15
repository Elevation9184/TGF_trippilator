/**
 * Base and here: finding places that are not gardens, and measuring roads to them.
 *
 *   B, the base     where you are staying. Found by address, confirmed on the
 *                   map, measured to and from every garden once when saved.
 *   here            where you are now. A GPS fix taken when asked for, measured
 *                   to every garden and the base when online.
 *
 * Both live only on this device. Finding and measuring them asks OpenStreetMap's
 * free services from the phone: Nominatim for addresses, the OSRM demo router
 * for road distances, which is the same router the garden matrix was baked with.
 * The published site never contains either.
 *
 * Kept free of the page so the rules can be tested in node.
 */

export const NOMINATIM = "https://nominatim.openstreetmap.org/search";
export const OSRM_TABLE = "https://router.project-osrm.org/table/v1/driving/";

export const BASE_ID = "@base";
export const HERE_ID = "@here";

// Prefer, but do not insist on, matches in and around Taranaki.
const VIEWBOX = "173.6,-38.8,174.7,-39.8";

export function addressSearchUrl(address) {
  const url = new URL(NOMINATIM);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", address.trim());
  url.searchParams.set("countrycodes", "nz");
  url.searchParams.set("viewbox", VIEWBOX);
  url.searchParams.set("limit", "5");
  return url.toString();
}

/** Nominatim results as { label, name, lat, lon }, most relevant first. */
export function addressCandidates(results) {
  return (Array.isArray(results) ? results : [])
    .map((result) => ({
      label: result.display_name,
      name: shortAddress(result.display_name),
      lat: Number(result.lat),
      lon: Number(result.lon),
    }))
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
}

/** "38, Example Street, Suburb, New Plymouth, ..." becomes "38 Example Street". */
export function shortAddress(displayName) {
  const parts = String(displayName || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return "Base";
  if (/^\d+[A-Za-z]?$/.test(parts[0]) && parts[1]) return `${parts[0]} ${parts[1]}`;
  return parts[0];
}

/**
 * One OSRM table request between a point and every garden (plus any extra
 * points, such as the base from here). "to" measures point -> each target;
 * "from" measures each target -> point.
 */
export function roadTableUrl(point, targets, direction) {
  const coords = [point, ...targets].map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const url = new URL(OSRM_TABLE + coords);
  url.searchParams.set(direction === "to" ? "sources" : "destinations", "0");
  url.searchParams.set("annotations", "distance,duration");
  // Without it the reply describes every point it snapped to: 17.7 KB instead of 1.1.
  url.searchParams.set("skip_waypoints", "true");
  return url.toString();
}

/** The table response as { targetId: { km, minutes } }, skipping anything unroutable. */
export function roadTableRows(json, targets, direction) {
  if (!json || json.code !== "Ok") return {};
  const rows = {};
  targets.forEach((target, index) => {
    const column = index + 1;
    const metres = direction === "to" ? json.distances?.[0]?.[column] : json.distances?.[column]?.[0];
    const seconds = direction === "to" ? json.durations?.[0]?.[column] : json.durations?.[column]?.[0];
    if (Number.isFinite(metres) && Number.isFinite(seconds)) {
      rows[target.id] = { km: metres / 1000, minutes: seconds / 60 };
    }
  });
  return rows;
}

/** "just now", "4 min ago", "2 h ago", for a fix that goes stale as you drive. */
export function ageText(iso, now = new Date()) {
  const minutes = Math.max(0, Math.round((now - new Date(iso)) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : "over a day ago";
}

/** Old enough to refresh when the app is opened again. */
export function isStale(here, now = new Date(), minutes = 3) {
  return !here || now - new Date(here.at) > minutes * 60000;
}

/** Coordinates typed or pasted in one go: "-39.06, 174.07" or two fields. */
export function parseCoordinates(latText, lonText = "") {
  const numbers = `${latText} ${lonText}`.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  if (numbers.length < 2) return null;
  let [lat, lon] = numbers;
  // New Zealand latitudes are negative; accept a pasted pair either way round.
  if (lat > 0 && lon < 0) [lat, lon] = [lon, lat];
  const ok = lat >= -48 && lat <= -34 && lon >= 165 && lon <= 179;
  return ok ? { lat, lon } : null;
}
