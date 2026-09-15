/**
 * Handing a run to Google Maps. The app plans; the phone navigates.
 *
 * Two rules, both learned from what Maps does with the link:
 *
 *   No start point.  The phone is the start. Given one, Maps routes from it even
 *                    after you left it three gardens ago, and because it is not
 *                    where the phone is, shows a preview instead of navigating.
 *   Ten at a time.   The directions link takes nine stops between start and
 *                    destination. A longer run is sent in batches, the tenth stop
 *                    standing in as the destination, rather than cut short.
 *
 * Kept free of the page so the rules can be tested in node.
 */

export const MAX_WAYPOINTS = 9;

const point = (place) => `${place.lat},${place.lon}`;

/**
 * The next batch of an ordered run.
 *
 * `stops` are the places still to go, in order; `finish`, if any, is where the
 * run ends after them, such as the base. `from` skips that many already sent.
 * Positions are 1-based over stops then finish, for labels. Null when nothing
 * is left to send.
 */
export function nextBatch(stops, finish = null, from = 0, max = MAX_WAYPOINTS) {
  const run = finish ? [...stops, finish] : [...stops];
  const batch = run.slice(from, from + max + 1);
  if (!batch.length) return null;
  return {
    waypoints: batch.slice(0, -1),
    destination: batch[batch.length - 1],
    first: from + 1,
    last: from + batch.length,
    total: run.length,
    more: from + batch.length < run.length,
  };
}

/** A Google Maps directions link from wherever the phone is. */
export function directionsUrl({ destination, waypoints = [], navigate = true }) {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", point(destination));
  if (waypoints.length) url.searchParams.set("waypoints", waypoints.map(point).join("|"));
  url.searchParams.set("travelmode", "driving");
  // Straight into turn-by-turn, which Maps only does when it starts from the phone.
  if (navigate) url.searchParams.set("dir_action", "navigate");
  return url.toString();
}
