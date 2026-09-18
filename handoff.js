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

/**
 * A Google Maps directions link from wherever the phone is.
 *
 * `origin` is only for test mode, where the phone is deliberately somewhere
 * else: a real day never sets it, for the reason at the top of this file.
 */
export function directionsUrl({ destination, waypoints = [], navigate = true, origin = null }) {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  if (origin) url.searchParams.set("origin", point(origin));
  url.searchParams.set("destination", point(destination));
  if (waypoints.length) url.searchParams.set("waypoints", waypoints.map(point).join("|"));
  url.searchParams.set("travelmode", "driving");
  // Straight into turn-by-turn, which Maps only does when it starts from the phone.
  if (navigate) url.searchParams.set("dir_action", "navigate");
  return url.toString();
}

/**
 * What has already gone to Google Maps today.
 *
 * Sending is not visiting, so this never marks anything seen — it only lets the
 * day show that a garden was handed over and has not been ticked off since. The
 * batch is always rebuilt from what is still to do, so a garden you did not
 * reach is sent again; the point of remembering is that you are told, rather
 * than quietly driving the same ten gardens twice.
 */
export function sentToday(store, day) {
  return store && store.date === day ? { ...store.at } : {};
}

/**
 * The record after a link is built: exactly the gardens in that link, since
 * that is now what Google Maps holds. Ones already there keep their time; the
 * rest are stamped now. Anything from an earlier link is dropped — it is not in
 * the route Maps is driving, so a garden brought back later (undo, un-ticking,
 * choosing it again) belongs in the plan, not among what Maps has. Keeping
 * every garden ever sent is how the Sent group once reached seventeen.
 */
export function markSent(store, ids, day, at = new Date(), order = ids) {
  const before = sentToday(store, day);
  const stamped = {};
  for (const id of ids) stamped[id] = before[id] || at.toISOString();
  // `ids` is the order Maps was given; `order` is the batch as the day planned
  // it, gardens already visited included where they fell, so a skip can still
  // be recognised afterwards. The two differ only when something was skipped.
  return { date: day, at: stamped, order: [...order], link: [...ids] };
}

/**
 * The batch as the day planned it: the order the Sent group is shown in, with
 * gardens visited before it was sent still in their places. It is kept, never
 * re-solved: re-solving would reorder the list Maps is actually driving.
 * Records from older builds hold only the stamps, in link order.
 */
export function sentOrder(store, day) {
  if (!store || store.date !== day) return [];
  return store.order ? [...store.order] : Object.keys(store.at);
}

/** The order Google Maps was actually given them in. */
export function linkOrder(store, day) {
  if (!store || store.date !== day) return [];
  return store.link ? [...store.link] : Object.keys(store.at);
}

/**
 * Gardens passed over: still to do, but with a garden later in `order`
 * already visited. Only ever a label and a place in the queue — never taken
 * as seen, never removed; why they were skipped is the driver's business.
 */
export function skippedIn(order, done, remaining) {
  const seen = new Set(done);
  const open = new Set(remaining);
  let furthest = -1;
  order.forEach((id, index) => {
    if (seen.has(id)) furthest = index;
  });
  return order.filter((id, index) => index < furthest && open.has(id) && !seen.has(id));
}

/**
 * The stretch of the day a batch covers, as the day planned it: from its first
 * garden to its last, keeping gardens already visited in between so a skip
 * inside it still shows. `route` is the day's order, visited gardens included.
 */
export function frameFor(route, batch, done) {
  const inBatch = new Set(batch);
  const seen = new Set(done);
  const positions = route.map((id, index) => (inBatch.has(id) ? index : -1)).filter((index) => index >= 0);
  if (!positions.length) return [...batch];
  const slice = route.slice(positions[0], positions[positions.length - 1] + 1);
  return slice.filter((id) => inBatch.has(id) || seen.has(id));
}

/**
 * The link itself. Google Maps cannot be told to start partway through a list:
 * whatever comes first, it drives to first. So a batch goes in the order the
 * driver is actually heading — onward from the furthest garden visited, the
 * skipped ones at the end, where Maps offers them last rather than turning the
 * car round — and home, if it fits, after all of them.
 */
export function orderedLink(batch, frame, done) {
  const byId = new Map(batch.gardens.map((place) => [place.id, place]));
  const ids = aheadInMaps(frame, done, [...byId.keys()]);
  const gardens = ids.map((id) => byId.get(id));
  const stops = batch.home ? [...gardens, batch.finish] : gardens;
  return { ids, waypoints: stops.slice(0, -1), destination: stops[stops.length - 1] };
}

/**
 * The gardens in Maps still to visit, in the order to head for them.
 *
 * Normally that is simply Maps' order. But a driver may jump ahead — skip four
 * because of timing and pull in at the fifth — and then "next" is the sixth,
 * not the first one skipped. So it continues from the furthest garden visited
 * in this batch; the skipped ones follow at the end, never dropped, for the
 * driver to go back to, tick off or remove. Nothing here assumes why they were
 * skipped. `link` is the batch in Maps' order, `done` what has been seen today,
 * and `remaining` the gardens still in the plan and not seen.
 */
export function aheadInMaps(link, done, remaining) {
  const seen = new Set(done);
  const open = new Set(remaining);
  let furthest = -1;
  link.forEach((id, index) => {
    if (seen.has(id)) furthest = index;
  });
  const still = link.map((id, index) => ({ id, index })).filter(({ id }) => open.has(id) && !seen.has(id));
  return [
    ...still.filter(({ index }) => index > furthest).map(({ id }) => id),
    ...still.filter(({ index }) => index < furthest).map(({ id }) => id),
  ];
}

/** The store with these stops forgotten: removed from the day, so never "sent". */
export function forgetSent(store, ids, day) {
  const kept = sentToday(store, day);
  const gone = new Set(ids);
  for (const id of ids) delete kept[id];
  return {
    date: day,
    at: kept,
    order: sentOrder(store, day).filter((id) => !gone.has(id)),
    link: linkOrder(store, day).filter((id) => !gone.has(id)),
  };
}

/** Destinations Google Maps takes in one link: nine stops and where it ends. */
export const MAX_STOPS = MAX_WAYPOINTS + 1;

/**
 * What the Google Maps button does next, and with which gardens.
 *
 * My day holds the gardens still to do in two groups: those already handed to
 * Maps and not yet seen (active), and those not sent yet (waiting). Maps takes
 * ten at a time, so the button tops the active group back up to ten from the
 * waiting ones as gardens are ticked off or removed. With no room, or nothing
 * waiting, it reopens the same route rather than going dead: Maps gets closed,
 * swiped away or killed by a phone call halfway round, and there has to be a
 * way back.
 *
 * `remaining` is in the day's route order and the link keeps that order, so a
 * top-up is one sensible drive rather than an old batch with new stops tacked
 * on. `finish` is the base when the day returns to it; it counts as one of the
 * ten, so it only goes in when nothing is waiting and a place is left for it.
 */
export function planHandoff(remaining, sent, finish = null, cap = MAX_STOPS) {
  if (!remaining.length) return null;
  // What Maps holds, in route order — never more than a link can carry. The
  // record keeps to that by itself now; the cap heals any record kept by an
  // older build, where the group could grow past what Maps actually has.
  const stamped = remaining.filter((place) => Boolean(sent[place.id]));
  const active = stamped.slice(0, cap);
  const held = new Set(active.map((place) => place.id));
  const waiting = remaining.filter((place) => !held.has(place.id));
  const adding = waiting.slice(0, Math.max(0, cap - active.length));
  const chosen = new Set([...active, ...adding].map((place) => place.id));
  const gardens = remaining.filter((place) => chosen.has(place.id));
  const left = waiting.length - adding.length;
  const kind = !active.length ? "first" : adding.length ? "add" : "reopen";

  const home = Boolean(finish) && !left && gardens.length < cap;
  const stops = home ? [...gardens, finish] : gardens;
  return {
    kind,
    active,
    waiting,
    adding,
    gardens,
    left,
    home,
    finish,
    // Ten gardens fill the link, so a drive home has to wait for Head to base.
    homeLeftOut: Boolean(finish) && !left && !home,
    waypoints: stops.slice(0, -1),
    destination: stops[stops.length - 1],
    label: handoffLabel(kind, gardens.length, adding.length, left),
  };
}

/** The button's words, which say exactly what a press will do. */
export function handoffLabel(kind, gardens, adding, left) {
  if (kind === "reopen") return "Open again in Google Maps";
  if (kind === "first") {
    if (left) return `Send first ${gardens} to Google Maps`;
    return gardens === 1 ? "Send to Google Maps" : `Send all ${gardens} to Google Maps`;
  }
  if (!left) return adding === 1 ? "Add the last garden to Google Maps" : "Add remaining gardens to Google Maps";
  return adding === 1 ? "Add next garden to Google Maps" : `Add next ${adding} gardens to Google Maps`;
}
