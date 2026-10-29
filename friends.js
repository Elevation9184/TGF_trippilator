/**
 * Friends' houses: places of your own to visit on the day.
 *
 * Added on this phone and kept only here, like the base — never in the
 * published bundle, the notes export or the workbook. A friend joins a day the
 * way a garden does: tapped on the map or ticked in Preselect, routed in My day,
 * handed to Google Maps, ticked off by visiting. What a friend never does is
 * appear among the gardens: Nearest, On the way and the filters are for finding
 * gardens, and a friend's house would only push them down.
 *
 * Identified by initials, shown as a circle on the map: GK beside F33 and C21.
 * Letters only, so they can never be mistaken for a festival map number.
 *
 * Kept free of the page so the rules can be tested in node.
 */

export const FRIEND_PREFIX = "@friend-";
export const DEFAULT_MINUTES = 60;
export const VISIT_CHOICES = [30, 45, 60, 90, 120, 180];

export function isFriendId(id) {
  return typeof id === "string" && id.startsWith(FRIEND_PREFIX);
}

/** " g.k. " becomes "GK": capitals only, nothing else. */
export function cleanInitials(text) {
  return String(text || "").toUpperCase().replace(/[^A-Z]/g, "");
}

/** Why these initials cannot be used, or "" when they can. */
export function initialsProblem(initials, friends, selfId = null) {
  if (initials.length < 2 || initials.length > 3) return "Initials: two or three letters, such as GK.";
  if (friends.some((friend) => friend.id !== selfId && friend.initials === initials)) {
    return `${initials} is already one of your friends here.`;
  }
  return "";
}

/** A lasting id, made once from the initials and kept if they change later. */
export function newFriendId(initials, friends) {
  const stem = FRIEND_PREFIX + initials.toLowerCase();
  const taken = new Set(friends.map((friend) => friend.id));
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
  }
}

/** A friend as the rest of the app sees a place: routable, labelled by initials. */
export function asPlace(friend) {
  return {
    id: friend.id,
    kind: "friend",
    initials: friend.initials,
    // Shown after the initials, so "GK Graham", or "GK GK's house" without a name.
    name: friend.name || `${friend.initials}'s house`,
    address: friend.address || "",
    lat: friend.lat,
    lon: friend.lon,
    minutes: friend.minutes ?? DEFAULT_MINUTES,
    area: "Friend",
  };
}

/** "GK · Graham", or just the initials when there is no name. */
export function displayName(friend) {
  return friend.name ? `${friend.initials} · ${friend.name}` : friend.initials;
}

/**
 * The order to put measured road tables back on opening the app: earliest
 * measured first. Each table also holds the legs to the base and friends that
 * were measured before it, so a later one restores the legs between the two.
 * Works for the base as well, given its id.
 */
export function measuredOrder(points) {
  return points
    .filter((point) => point.travel)
    .sort((a, b) => String(a.measuredAt || "").localeCompare(String(b.measuredAt || "")));
}

/** Stored friends that still make sense: initials and a position. */
export function valid(list) {
  return (Array.isArray(list) ? list : []).filter(
    (friend) =>
      friend && isFriendId(friend.id) && cleanInitials(friend.initials).length >= 2 &&
      Number.isFinite(friend.lat) && Number.isFinite(friend.lon)
  );
}
