/**
 * Where you are, against the gardens still to visit.
 *
 * My day watches the fixes it gets and ticks gardens off by itself: heading to
 * a garden, at it, and — once you have been there long enough and driven away —
 * seen. The rules are here, apart from the page and from where fixes come from,
 * so they can be tested a hundred fixes at a time in node rather than by
 * driving to Ōpunake.
 *
 * Three things this must not do, each of which is a rule below:
 *
 *   Tick off a garden you drove past. Hence the dwell: ten minutes inside the
 *   ring before leaving counts as a visit, and anything shorter is passing
 *   through.
 *
 *   Tick off the wrong one of two neighbours. Tītoki is 16A Kinross Drive and
 *   Te Rongohua is 16B; no GPS separates those. Where two candidates are within
 *   a margin of each other, it asks rather than guesses.
 *
 *   Trust a poor fix. A 500 m accuracy circle says nothing about which garden
 *   you are in, so those fixes only move the "heading to" highlight.
 *
 * All of it is arithmetic on coordinates already in the bundle: no network, and
 * nothing beyond a garden's single published point, because that is all we have.
 * There are no garden boundaries in the data, so "inside" is a ring around the pin.
 */

import { haversineKm } from "./engine.js";

/** Within this of the pin is "at the garden". A ring, since we have no boundary. */
export const ARRIVE_METRES = 150;
/** Further than this and you have left. Wider than arriving, so a fix wobbling
 *  on the boundary does not flicker between states. */
export const LEAVE_METRES = 300;
/** Closer than this to the next stop, it is worth saying you are heading there. */
export const APPROACH_KM = 1.5;
/** Inside the ring this long, and leaving counts as having visited. */
export const DWELL_MINUTES = 10;
/** A fix vaguer than this cannot tell one garden from another. */
export const ACCURACY_LIMIT_METRES = 100;
/** Two candidates closer together than this cannot be told apart by GPS. */
export const AMBIGUOUS_MARGIN_METRES = 100;

export const metresBetween = (a, b) => haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;

/** The empty state: nowhere, nothing pending. */
export const start = () => ({ atId: null, since: null, headingId: null });

function ranked(fix, stops) {
  return stops
    .filter((place) => place && place.lat != null && place.lon != null)
    .map((place) => ({ place, metres: metresBetween(fix, place) }))
    .sort((a, b) => a.metres - b.metres || a.place.id.localeCompare(b.place.id));
}

/**
 * One fix against the stops still to go, in route order.
 *
 * Returns the state to keep, and what happened:
 *   { kind: "arrived" }   you are at a garden
 *   { kind: "seen" }      you were there long enough and have left
 *   { kind: "passed" }    you left again too soon to count as a visit
 *   { kind: "unsure" }    two gardens too close together to tell apart
 *
 * `autoSeen: false` still tracks and highlights, but never reports "seen":
 * undoing an automatic tick turns it off until the plan or the day changes.
 */
export function track(state, { fix, stops, now = new Date(), autoSeen = true }) {
  const next = { ...state };
  const events = [];
  const order = ranked(fix, stops);
  const known = new Set(order.map((row) => row.place.id));
  const crisp = (fix.accuracy ?? 0) <= ACCURACY_LIMIT_METRES;

  // A garden left the plan while you were standing in it.
  if (next.atId && !known.has(next.atId)) {
    next.atId = null;
    next.since = null;
  }

  if (next.atId) {
    const here = order.find((row) => row.place.id === next.atId);
    if (here && here.metres > LEAVE_METRES) {
      const minutes = (now - new Date(next.since)) / 60000;
      events.push({
        kind: minutes >= DWELL_MINUTES && autoSeen ? "seen" : "passed",
        place: here.place,
        minutes: Math.round(minutes),
      });
      next.atId = null;
      next.since = null;
    }
  }

  if (!next.atId && crisp && order.length) {
    const [first, second] = order;
    if (first.metres <= ARRIVE_METRES) {
      if (second && second.metres - first.metres < AMBIGUOUS_MARGIN_METRES) {
        // Next door to each other: which one you are in is not ours to decide.
        events.push({ kind: "unsure", places: [first.place, second.place] });
      } else {
        next.atId = first.place.id;
        next.since = now.toISOString();
        events.push({ kind: "arrived", place: first.place, metres: Math.round(first.metres) });
      }
    }
  }

  // Heading to: the nearest stop within range, unless you are already at one.
  const nearest = order[0];
  next.headingId =
    !next.atId && nearest && nearest.metres <= APPROACH_KM * 1000 ? nearest.place.id : null;
  next.metres = nearest ? Math.round(nearest.metres) : null;
  return { state: next, events };
}

/** How the stop should look: a light border while you are heading to or at it. */
export function highlightOf(state, id) {
  if (state.atId === id) return "here";
  if (state.headingId === id) return "heading";
  return "";
}

/** How long you have been at the garden, for the line under the stop. */
export function minutesHere(state, now = new Date()) {
  return state.since ? Math.floor((now - new Date(state.since)) / 60000) : 0;
}

/**
 * How often to ask for a fix, in seconds. Close to the next garden it is worth
 * asking often; an hour down the coast it is not, and a phone in a car has a
 * day to last. Only ever while the app is on screen: a web app gets nothing
 * while Google Maps is in front.
 */
export function pollSeconds(metresToNearest) {
  if (metresToNearest == null) return 300;
  if (metresToNearest <= 1000) return 45;
  if (metresToNearest <= 5000) return 120;
  return 300;
}

/**
 * How old a fix may be. Maps, navigating in front of us, keeps the phone's fused
 * position warm, so accepting a recent one costs nothing and returns at once —
 * but not when we are close enough for 100 m to matter.
 */
export function maximumAgeMs(metresToNearest) {
  return metresToNearest != null && metresToNearest <= 1000 ? 30_000 : 120_000;
}

/** What "until My day is repopulated" means: this plan, on this day. */
export function planSignature(ids, day) {
  return `${day}:${[...ids].sort().join(",")}`;
}
