/**
 * Test mode: ?tm=y
 *
 * Trying the app out from Auckland is misleading, because every answer starts
 * from the real GPS fix: Here is 300 km away, and Google Maps plans the drive
 * south rather than the day itself.
 *
 * With ?tm=y on the address, the app pretends to be in Taranaki instead. It
 * starts at the base and moves to each garden as it is marked Seen, so a whole
 * day can be walked through against the live data. Google Maps is given that
 * pretend position as the start, and shows a route rather than navigating.
 *
 * Nothing about it is remembered: it lasts as long as the address has ?tm=y,
 * and the page says so while it is on. Real GPS is never asked for.
 */

export function isOn(search) {
  return new URLSearchParams(search || "").get("tm") === "y";
}

/**
 * Where a test run is pretending to be: the last garden marked seen today, or
 * the base before any. Null until there is a base, since a day has to start
 * somewhere real.
 */
export function pretendPlace(doneIds, byId, base = null) {
  for (let index = doneIds.length - 1; index >= 0; index -= 1) {
    const place = byId.get(doneIds[index]);
    if (place && place.lat != null && place.lon != null) return place;
  }
  return base;
}

/** What the banner says, so nobody mistakes a test run for the real thing. */
export function bannerText(place) {
  return place
    ? `Test mode: pretending to be at ${place.name}. Here and Google Maps use this, not your GPS.`
    : "Test mode: set your base, and the app will pretend to be there.";
}
