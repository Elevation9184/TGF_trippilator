/**
 * Opening days: whether a garden is open on a festival day, and saying so briefly.
 *
 * Days come from the festivals' own listings, read by src/opening_days.py. A
 * garden whose days were not published has none, and that means unknown: it is
 * never treated as closed, and is shown with a "?".
 *
 * Read-only. Nothing here is editable, by design.
 */

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** "Sat 31 Oct". */
export function dayLabel(iso) {
  const { month, day, weekday } = parts(iso);
  return `${WEEKDAY[weekday]} ${day} ${MONTH[month - 1]}`;
}

/** true, false, or null when the garden's days are not known. */
export function openOn(place, iso) {
  const days = place.open?.days;
  if (!Array.isArray(days)) return null;
  return days.includes(iso);
}

function nextDay(iso) {
  const { year, month, day } = parts(iso);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

/** Consecutive days as runs: "Fri 30 Oct – Sun 1 Nov, Fri 6 – Sun 8 Nov". */
export function describeRuns(days) {
  const sorted = [...days].sort();
  const runs = [];
  for (const iso of sorted) {
    const last = runs[runs.length - 1];
    if (last && nextDay(last[1]) === iso) last[1] = iso;
    else runs.push([iso, iso]);
  }
  return runs
    .map(([first, last]) => {
      if (first === last) return dayLabel(first);
      const a = parts(first);
      const b = parts(last);
      const start = a.month === b.month ? `${WEEKDAY[a.weekday]} ${a.day}` : dayLabel(first);
      return `${start} – ${dayLabel(last)}`;
    })
    .join(", ");
}

/**
 * A short description against the festival's days: "every day", "closed Tue 3 –
 * Wed 4 Nov", "Fri 30 Oct – Sun 1 Nov", or "days not published".
 */
export function describeDays(place, festivalDays) {
  const days = place.open?.days;
  if (!Array.isArray(days)) return "days not published";
  const open = festivalDays.filter((iso) => days.includes(iso));
  if (!open.length) return "not open during the festival";
  if (open.length === festivalDays.length) return "every day";
  const closed = festivalDays.filter((iso) => !days.includes(iso));
  // Whichever is shorter to read.
  return closed.length < open.length ? `closed ${describeRuns(closed)}` : describeRuns(open);
}

/** The festival day that today is, or null outside the festival. */
export function festivalToday(festivalDays, todayIso) {
  return festivalDays.includes(todayIso) ? todayIso : null;
}
