/**
 * Preselect: which gardens are in play, and which are locked into the plan.
 *
 * Three kinds of garden make up the pool that every tab draws from:
 *
 *   matches    meet the current filters
 *   locked     ticked by hand; this is the plan, and no filter removes them
 *   lingering  released by hand but no longer matching; they stay in view,
 *              unticked, until the next filter change, so a slip of the finger
 *              is easy to undo without disturbing everything else
 *
 * Typing in the search box is not a filter change. It narrows what the list
 * shows, and nothing else.
 *
 * Kept free of the page so the rules can be tested in node.
 */

import { fold, gardenNr } from "./engine.js";

export const MIN_SEARCH = 2;

/** The folded search term, or "" while it is too short to mean anything. */
export function searchTerm(text) {
  const term = fold(text);
  return term.length >= MIN_SEARCH ? term : "";
}

/**
 * Name, street address, area or garden number. Numbers match whole, so "C1"
 * finds C1 and not C10 to C19.
 */
export function matchesSearch(place, text) {
  const term = searchTerm(text);
  if (!term) return true;
  const numbers = gardenNr(place).split(", ").map(fold);
  return (
    fold(place.name).includes(term) ||
    fold(place.address).includes(term) ||
    fold(place.area).includes(term) ||
    numbers.includes(term.replace(/\s+/g, ""))
  );
}

export class Preselection {
  constructor({ locked = [], lingering = [] } = {}) {
    // An array, so the plan keeps the order gardens were added in.
    this.locked = [...new Set(locked)];
    this.lingering = new Set(lingering.filter((id) => !this.locked.includes(id)));
  }

  isLocked(id) {
    return this.locked.includes(id);
  }

  isLingering(id) {
    return this.lingering.has(id);
  }

  lock(ids) {
    for (const id of ids) {
      this.lingering.delete(id);
      if (!this.locked.includes(id)) this.locked.push(id);
    }
  }

  /** Released gardens that no longer match stay in view until filters change. */
  release(ids, matches) {
    const leaving = new Set(ids);
    this.locked = this.locked.filter((id) => !leaving.has(id));
    for (const id of leaving) {
      if (!matches.has(id)) this.lingering.add(id);
    }
  }

  toggle(id, matches) {
    if (this.isLocked(id)) this.release([id], matches);
    else this.lock([id]);
  }

  /** Set several the same way, as a map area selection does. */
  setMany(ids, locked, matches) {
    if (locked) this.lock(ids);
    else this.release(ids, matches);
  }

  /** A filter changed: the fail-safe space is no longer needed. */
  criteriaChanged() {
    this.lingering.clear();
  }

  /** Out of the plan and out of view, as when a garden is marked seen. */
  forget(id) {
    this.locked = this.locked.filter((other) => other !== id);
    this.lingering.delete(id);
  }

  /** Drop anything no longer in the dataset. */
  retain(known) {
    this.locked = this.locked.filter((id) => known.has(id));
    this.lingering = new Set([...this.lingering].filter((id) => known.has(id)));
  }

  inPool(id, matches) {
    return matches.has(id) || this.isLocked(id) || this.lingering.has(id);
  }

  pool(places, matches) {
    return places.filter((place) => this.inPool(place.id, matches));
  }

  toJSON() {
    return { locked: [...this.locked], lingering: [...this.lingering] };
  }
}

/**
 * What the map should draw, and how.
 *
 *   in the plan                       selected
 *   in the pool                       available
 *   not seen, outside the pool        greyed out
 *   seen, outside the pool            not drawn at all
 *
 * A seen garden is in the pool only when "Hide ones I've seen" is off or it
 * was locked in by hand, and either way it was asked for.
 */
export function mapStates(places, pre, matches, isVisited) {
  const out = [];
  for (const place of places) {
    if (place.lat == null || place.lon == null) continue;
    if (pre.inPool(place.id, matches)) {
      out.push({ place, state: pre.isLocked(place.id) ? "locked" : "available" });
    } else if (!isVisited(place.id)) {
      out.push({ place, state: "greyed" });
    }
  }
  return out;
}

/** Gardens marked seen today while they were in the plan. */
export function doneToday(stored, today) {
  return stored && stored.date === today && Array.isArray(stored.ids) ? stored.ids : [];
}
