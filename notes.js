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

export const COLUMNS = [
  "Place ID",
  "Name",
  "Festival",
  "Region",
  "Interest",
  "Must Visit",
  "Visited",
  "Visit Date",
  "Notes",
];

// Only these come back in. Name and region are context for the human editing
// the file; changing them there must not silently rewrite the dataset.
const EDITABLE = new Set(["Interest", "Must Visit", "Visited", "Visit Date", "Notes"]);

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

export function toCsv(places, visits) {
  const lines = [COLUMNS.join(",")];
  for (const place of [...places].sort((a, b) => a.name.localeCompare(b.name))) {
    const visit = visits.get(place.id) || {};
    lines.push(
      [
        place.id,
        place.name,
        place.festivals.join(" + "),
        place.region,
        visit.interest ?? place.interest ?? "",
        visit.mustVisit ?? place.mustVisit ?? "",
        visit.visited ? "Yes" : "",
        visit.visitedOn ?? "",
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

  const header = rows[0].map((cell) => cleanValue(cell));
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
    for (const column of COLUMNS) {
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
      } else if (column === "Visit Date") entry.visitedOn = value;
      else if (column === "Must Visit") entry.mustVisit = value;
      else if (column === "Notes") entry.note = value;
    }
    if (Object.keys(entry).length) notes[id] = entry;
  }
  return { notes, unknown, rejected };
}
