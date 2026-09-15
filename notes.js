/**
 * Reading and writing personal notes as CSV, for editing in a spreadsheet.
 *
 * Exported as a full worksheet rather than only what has been touched: all 81
 * destinations with their names, so it can be filled in at a desk. Rating a
 * list of identifiers would be impossible; rating a list of garden names is an
 * evening's work.
 *
 * Kept apart from engine.js because it is file handling, not query logic, and
 * apart from app.js because it is worth testing on its own.
 */

import { gardenNr } from "./engine.js";

export const COLUMNS = [
  "Place ID",
  // For the person editing: matches the numbers on the printed maps. Exported
  // only, never read back, never a key; Place ID does the looking up.
  "Garden Nr",
  "Name",
  "Festival",
  "Region",
  "Interest (1 low - 10 best)",
  "Must Visit",
  "Visited",
  "Visit Date",
  // Personal: how long you expect to stay, overriding the listing's estimate.
  "Visit Minutes (blank = listing estimate)",
  "Notes",
];

// Only these come back in. Name and region are context for the human editing
// the file; changing them there must not silently rewrite the dataset.
const EDITABLE = new Set(["Interest", "Must Visit", "Visited", "Visit Date", "Visit Minutes", "Notes"]);

/** "Interest (1-10, 10 = best)" and "Interest" are the same column. */
function headingKey(name) {
  return String(name ?? "").split("(")[0].trim();
}

const RISKY_PREFIX = /^[=+\-@\t\r]/;

/** Stop a spreadsheet treating a note as a formula. */
function safeCell(value) {
  const text = value == null ? "" : String(value);
  return RISKY_PREFIX.test(text) ? `'${text}` : text;
}

function quote(value) {
  const text = safeCell(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}


// The workbook validates this column to exactly these three, so a typo must be
// refused rather than written through. The engine tests for "Yes", which means
// an unnoticed "Yess" would otherwise silently mean "no".
const MUST_VISIT = new Map([
  ["yes", "Yes"], ["y", "Yes"],
  ["maybe", "Maybe"], ["m", "Maybe"],
  ["no", "No"], ["n", "No"],
]);

// Excel rewrites an ISO date into local format on save, so day-first forms have
// to be accepted coming back. New Zealand writes the day first: 03/04 is 3 April.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_FIRST = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/;

function isRealDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function normaliseDate(value) {
  const iso = ISO_DATE.exec(value);
  if (iso) return isRealDate(+iso[1], +iso[2], +iso[3]) ? value : null;
  const parts = DAY_FIRST.exec(value.split(" ")[0]);
  if (!parts) return null;
  const day = Number(parts[1]);
  const month = Number(parts[2]);
  const year = Number(parts[3]);
  if (!isRealDate(year, month, day)) return null;
  return year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

// A stay shorter than five minutes is a typo; longer than eight hours is a day.
export const MIN_VISIT_MINUTES = 5;
export const MAX_VISIT_MINUTES = 480;

/** Whole minutes within range, or null. */
export function parseMinutes(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return number >= MIN_VISIT_MINUTES && number <= MAX_VISIT_MINUTES ? number : null;
}

export function toCsv(places, visits) {
  const lines = [COLUMNS.map(quote).join(",")];
  for (const place of [...places].sort((a, b) => a.name.localeCompare(b.name))) {
    const visit = visits.get(place.id) || {};
    lines.push(
      [
        place.id,
        gardenNr(place),
        place.name,
        place.festivals.join(" + "),
        place.region,
        visit.interest ?? place.interest ?? "",
        visit.mustVisit ?? place.mustVisit ?? "",
        visit.visited ? "Yes" : "",
        visit.visitedOn ?? "",
        // Only your own, so importing the sheet never records a listing estimate as a decision.
        visit.minutes ?? "",
        visit.note ?? "",
      ]
        .map(quote)
        .join(",")
    );
  }
  // CRLF and a byte order mark are what Excel expects; without the mark it
  // mangles every macron in the dataset.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** A small RFC 4180 reader: quoted fields, escaped quotes, either line ending. */
export function parseCsv(text) {
  const clean = text.replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (quoted) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && clean[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

function cleanValue(value) {
  const text = String(value ?? "").trim();
  return text.startsWith("'") ? text.slice(1) : text;
}

/**
 * Turn an edited sheet back into per-place notes.
 *
 * Returns what it understood and what it could not, because a silent partial
 * import of an evening's work would be worse than a refusal.
 */
export function fromCsv(text, knownIds) {
  const rows = parseCsv(text);
  if (!rows.length) return { notes: {}, unknown: [], rejected: [] };

  const header = rows[0].map((cell) => headingKey(cleanValue(cell)));
  const index = Object.fromEntries(header.map((name, position) => [name, position]));
  if (index["Place ID"] === undefined) {
    return { notes: {}, unknown: [], rejected: ["no 'Place ID' column"] };
  }

  const notes = {};
  const unknown = [];
  const rejected = [];

  for (const row of rows.slice(1)) {
    const id = cleanValue(row[index["Place ID"]]);
    if (!id) continue;
    if (knownIds && !knownIds.has(id)) {
      unknown.push(id);
      continue;
    }

    const entry = {};
    for (const heading of COLUMNS) {
      const column = headingKey(heading);
      if (!EDITABLE.has(column) || index[column] === undefined) continue;
      const value = cleanValue(row[index[column]]);
      if (value === "") continue;

      if (column === "Interest") {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > 10) {
          rejected.push(`${id}: interest ${value}`);
          continue;
        }
        entry.interest = number;
      } else if (column === "Visited") {
        entry.visited = /^y(es)?$|^true$|^1$/i.test(value);
      } else if (column === "Visit Date") {
        const date = normaliseDate(value);
        if (date === null) {
          rejected.push(`${id}: visit date ${value}`);
          continue;
        }
        entry.visitedOn = date;
      } else if (column === "Must Visit") {
        const setting = MUST_VISIT.get(value.toLowerCase());
        if (!setting) {
          rejected.push(`${id}: must visit ${value}`);
          continue;
        }
        entry.mustVisit = setting;
      } else if (column === "Visit Minutes") {
        const minutes = parseMinutes(value);
        if (minutes === null) {
          rejected.push(`${id}: visit minutes ${value}`);
          continue;
        }
        entry.minutes = minutes;
      } else if (column === "Notes") entry.note = value;
    }
    if (Object.keys(entry).length) notes[id] = entry;
  }
  return { notes, unknown, rejected };
}
