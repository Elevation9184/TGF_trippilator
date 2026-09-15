/**
 * Garden Edit: the personal fields, and editing several gardens at once.
 *
 * Only what is yours to judge can be edited: rating, must visit, seen and when,
 * how long you mean to stay, and notes. Names, addresses, coordinates, festival
 * listings and opening days come from the festivals and are never editable.
 *
 * With several gardens highlighted, a field shows its value where they agree
 * and "mixed" where they do not. A change is written only to the field that was
 * changed, and only to gardens where it makes a difference, so editing the
 * rating of five gardens leaves their notes exactly as they were. Every change
 * can be undone.
 *
 * Kept free of the page so the rules can be tested in node.
 */

import { MAX_VISIT_MINUTES, MIN_VISIT_MINUTES, parseMinutes } from "./notes.js";

export const FIELDS = ["interest", "mustVisit", "visited", "visitedOn", "minutes", "note"];
export const MUST_VISIT = ["Yes", "Maybe", "No"];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function blank(value) {
  return value === undefined || value === null || value === "";
}

/**
 * What a garden currently shows for a field: your own value if you have set
 * one, otherwise the dataset's.
 */
export function effective(field, place, visit = {}) {
  switch (field) {
    case "interest":
      return visit.interest ?? place.interest ?? null;
    case "mustVisit":
      return visit.mustVisit ?? place.mustVisit ?? null;
    case "visited":
      return Boolean(visit.visited);
    case "visitedOn":
      return visit.visitedOn || null;
    case "minutes":
      return visit.minutes ?? place.minutes ?? null;
    case "note":
      return blank(visit.note) ? null : visit.note;
    default:
      throw new Error(`Not an editable field: ${field}`);
  }
}

/** { mixed: false, value } where every garden agrees, { mixed: true } where not. */
export function common(field, places, visitOf) {
  if (!places.length) return { mixed: false, value: null };
  const values = places.map((place) => effective(field, place, visitOf(place.id)));
  const first = values[0];
  const same = values.every((value) => String(value) === String(first));
  return same ? { mixed: false, value: first } : { mixed: true, value: null };
}

/**
 * Turn what was typed or chosen into a stored value.
 * Returns { ok: true, value } or { ok: false, message }. A blank clears.
 */
export function parse(field, raw) {
  const text = String(raw ?? "").trim();
  switch (field) {
    case "interest": {
      if (!text) return { ok: true, value: null };
      const number = Number(text);
      return Number.isInteger(number) && number >= 1 && number <= 10
        ? { ok: true, value: number }
        : { ok: false, message: "A rating is a whole number from 1 to 10." };
    }
    case "mustVisit":
      if (!text) return { ok: true, value: null };
      return MUST_VISIT.includes(text)
        ? { ok: true, value: text }
        : { ok: false, message: "Must visit is Yes, Maybe or No." };
    case "visited":
      if (text === "Yes") return { ok: true, value: true };
      if (text === "No") return { ok: true, value: false };
      return { ok: false, message: "Seen is Yes or No." };
    case "visitedOn": {
      if (!text) return { ok: true, value: null };
      const parts = ISO_DATE.exec(text);
      const probe = parts && new Date(Date.UTC(+parts[1], +parts[2] - 1, +parts[3]));
      return probe && probe.getUTCDate() === +parts[3] && probe.getUTCMonth() === +parts[2] - 1
        ? { ok: true, value: text }
        : { ok: false, message: "That is not a date." };
    }
    case "minutes": {
      if (!text) return { ok: true, value: null };
      const minutes = parseMinutes(text);
      return minutes === null
        ? { ok: false, message: `Minutes are a whole number from ${MIN_VISIT_MINUTES} to ${MAX_VISIT_MINUTES}.` }
        : { ok: true, value: minutes };
    }
    case "note":
      return { ok: true, value: text || null };
    default:
      return { ok: false, message: `Not an editable field: ${field}` };
  }
}

/**
 * The patch that sets one field on one garden, or null where it would change
 * nothing. Seen gardens only carry a date; unseeing one clears it.
 */
export function patchFor(field, value, place, visit = {}, today = null) {
  if (field === "visited") {
    if (Boolean(visit.visited) === value) return null;
    return value ? { visited: true, visitedOn: visit.visitedOn || today } : { visited: false, visitedOn: null };
  }
  if (field === "visitedOn" && !visit.visited) return null;
  if (String(effective(field, place, visit)) === String(value ?? null)) {
    // Already showing that value. Clearing a personal value that happens to
    // equal the dataset's still changes nothing anyone can see.
    return null;
  }
  return { [field]: value };
}

/** Undo, most recent first, bounded so a long day cannot grow it without limit. */
export class History {
  constructor(limit = 30) {
    this.limit = limit;
    this.entries = [];
  }

  push(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
  }

  pop() {
    return this.entries.pop() || null;
  }

  get last() {
    return this.entries[this.entries.length - 1] || null;
  }

  get size() {
    return this.entries.length;
  }
}

/** "rating", for the undo label. */
export const FIELD_LABELS = {
  interest: "rating",
  mustVisit: "must visit",
  visited: "seen",
  visitedOn: "date seen",
  minutes: "visit minutes",
  note: "notes",
};
