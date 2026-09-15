/**
 * Interface for the Taranaki Garden Optimiser.
 *
 * All query logic lives in engine.js, which is a port of the Python and is held
 * to it by tests/test_parity.py. The preselection rules live in preselect.js.
 * This file reads controls, calls those, and draws the answer.
 *
 * Two things are deliberately kept out of the published bundle and held only in
 * this browser: the start point, and what the user has visited, rated or
 * planned. The bundle is read-only reference data that everyone shares;
 * personal state is nobody else's business and never leaves the device.
 */

import * as engine from "./engine.js";
import { toCsv, fromCsv } from "./notes.js";
import { createMap } from "./map.js";
import { Preselection, doneToday, mapStates, matchesSearch, searchTerm } from "./preselect.js";
import * as edit from "./editor.js";
import * as opening from "./opening.js";
import * as position from "./position.js";

const STORE_BASE = "tgo.base.v1";
// Where you were at the last GPS fix. Kept so a reopened app still knows.
const STORE_HERE = "tgo.here.v1";
const STORE_VISITS = "tgo.visits.v1";
// Holds the locked-in gardens. The name predates Preselect; the plan and the
// locked-in set are one thing, so an existing plan carries straight over.
const STORE_PLAN = "tgo.plan.v1";
const STORE_DONE = "tgo.done.v1";
const STORE_VIEW = "tgo.view.v1";

// Every control that shapes what is on screen. A pull-to-refresh on a phone
// is easy to trigger by accident, and losing the whole query to it is worse
// than any amount of tidiness gained by starting fresh.
const VIEW_CONTROLS = [
  "origin", "destination", "order", "count", "detour-cap",
  "area", "open-on", "festival", "entry-type", "anchor", "max-km",
  "rank", "interest-weight", "min-interest",
];
const VIEW_CHECKBOXES = ["hide-visited", "return-home", "must-visit-only"];

// Filters decide which gardens match. Changing one ends any lingering.
// Ranking choices and the search box do not.
const CRITERIA_CONTROLS = ["area", "open-on", "festival", "entry-type", "anchor", "min-interest"];
const CRITERIA_CHECKBOXES = ["hide-visited", "must-visit-only"];

// What "Reset filters" returns to.
const FILTER_DEFAULTS = {
  area: "",
  "open-on": "",
  festival: "Both",
  "entry-type": "All",
  anchor: "",
  "max-km": "0",
  rank: "distance",
  "interest-weight": "35",
  "min-interest": "",
};
const FILTER_CHECK_DEFAULTS = { "hide-visited": true, "must-visit-only": false };

// The pool has already applied every filter, so the engine is told to let
// everything it is given through.
const OPEN_FILTERS = { includeVisited: true, includeExcluded: true };

const el = (id) => document.getElementById(id);
const state = {
  bundle: null,
  model: null,
  byId: new Map(),
  base: null,
  visits: new Map(),
  pre: new Preselection(),
  done: null,
  mode: "nearest",
  map: null,
  mapView: null,
  order: "detour",
  // The last GPS fix, and a counter bumped whenever personal road costs change.
  here: null,
  travelVersion: 0,
  // Garden Edit: which gardens are highlighted, and what can be undone.
  // Neither survives a reload; both are about the editing in hand.
  picked: new Set(),
  history: new edit.History(),
  lastEdit: "",
};

/* Storage can throw in private windows, so never let it break the page. */
function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Ignore: a lost preference is not worth an error message. */
  }
}

/** The local calendar date. toISOString is UTC, which in New Zealand is yesterday until noon. */
function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function load() {
  const response = await fetch("data/bundle.json");
  if (!response.ok) throw new Error(`Could not load data (${response.status})`);
  state.bundle = await response.json();
  state.model = new engine.TravelModel(state.bundle);
  state.byId = new Map(state.bundle.places.map((p) => [p.id, p]));
  state.base = readStore(STORE_BASE, null);
  state.visits = new Map(Object.entries(readStore(STORE_VISITS, {})));
  const view = readStore(STORE_VIEW, {}) || {};
  state.pre = new Preselection({ locked: readStore(STORE_PLAN, []), lingering: view.lingering || [] });
  state.pre.retain(new Set(state.byId.keys()));
  state.done = readStore(STORE_DONE, null);
  state.here = readStore(STORE_HERE, null);
  // Road costs measured for the base or here earlier, back into the model.
  if (state.base?.travel) state.model.setPersonal(position.BASE_ID, state.base.travel);
  if (state.here?.travel) state.model.setPersonal(position.HERE_ID, state.here.travel);
}

function savePlan() {
  writeStore(STORE_PLAN, state.pre.locked);
  saveView();
}

function saveView() {
  const view = { mode: state.mode, amenities: [], map: state.mapView, lingering: [...state.pre.lingering] };
  for (const id of VIEW_CONTROLS) view[id] = el(id).value;
  for (const id of VIEW_CHECKBOXES) view[id] = el(id).checked;
  view.amenities = [...document.querySelectorAll("[data-amenity]")]
    .filter((box) => box.checked)
    .map((box) => box.dataset.amenity);
  writeStore(STORE_VIEW, view);
}

/** Put the controls back as they were, ignoring anything no longer valid. */
function restoreView() {
  const view = readStore(STORE_VIEW, null);
  if (!view) return;
  state.mapView = view.map || null;

  for (const id of VIEW_CONTROLS) {
    const control = el(id);
    if (view[id] == null) continue;
    // A stored garden may have gone from the dataset since; leave the default.
    const allowed =
      control.tagName !== "SELECT" ||
      [...control.options].some((option) => option.value === view[id]);
    if (allowed) control.value = view[id];
  }
  for (const id of VIEW_CHECKBOXES) {
    if (typeof view[id] === "boolean") el(id).checked = view[id];
  }
  for (const box of document.querySelectorAll("[data-amenity]")) {
    box.checked = (view.amenities || []).includes(box.dataset.amenity);
  }
  // Best picks used to be its own tab; it is now a ranking choice in Nearest.
  if (view.mode === "recommend") {
    view.mode = "nearest";
    if (!view.rank) el("rank").value = "blend";
  }
  if (view.mode) {
    const tab = document.querySelector(`[data-mode="${view.mode}"]`);
    if (tab) {
      document.querySelectorAll(".mode").forEach((b) => b.classList.remove("is-active"));
      tab.classList.add("is-active");
      state.mode = view.mode;
    }
  }
  showModeControls();
}

function showModeControls() {
  el("destination-field").hidden = state.mode !== "via";
  el("order-field").hidden = state.mode !== "via";
  el("detour-field").hidden = state.mode !== "via";
  el("count-field").hidden = state.mode === "route";
}

function sortedPlaces() {
  return [...state.bundle.places].sort((a, b) => a.name.localeCompare(b.name));
}

function fillPlaceSelect(select, { includeBase = false, includeHere = false } = {}) {
  const previous = select.value;
  select.innerHTML = "";
  const add = (value, text) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  };
  if (includeBase) add("@base", state.base ? `B · your base (${state.base.name})` : "B · your base (not set yet)");
  if (includeHere) add("@here", state.here ? `Here (${position.ageText(state.here.at)})` : "Here (press Here first)");
  for (const place of sortedPlaces()) add(place.id, place.name);
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

/** One entry per town that has gardens, with how many. */
function fillAreaSelect() {
  const counts = new Map();
  for (const place of state.bundle.places) {
    if (place.area) counts.set(place.area, (counts.get(place.area) || 0) + 1);
  }
  const select = el("area");
  const names = [...counts.keys()].sort((a, b) => engine.fold(a).localeCompare(engine.fold(b)));
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = `${name} (${counts.get(name)})`;
    select.append(option);
  }
}

/** The festival's days, with today marked once the festival is on. */
function fillOpenOnSelect() {
  const select = el("open-on");
  const now = today();
  for (const iso of festivalDays()) {
    const option = document.createElement("option");
    option.value = iso;
    option.textContent = opening.dayLabel(iso) + (iso === now ? " · today" : "");
    select.append(option);
  }
}

function festivalDays() {
  return state.bundle.festival?.days || [];
}

/**
 * The day to check a plan against: the Open on choice, or else today if the
 * festival is on. Null when neither applies, and nothing is flagged.
 */
function checkDay() {
  return el("open-on").value || opening.festivalToday(festivalDays(), today());
}

/** A small marker for a garden on a given day: closed, or days unknown. */
function openingTag(place, day) {
  if (!day) return "";
  const open = opening.openOn(place, day);
  if (open === true) return "";
  if (open === false) {
    return `<span class="open-closed" title="${escapeHtml(opening.describeDays(place, festivalDays()))}">closed ${escapeHtml(opening.dayLabel(day))}</span>`;
  }
  return '<span class="open-unknown" title="Opening days not published; check with the festival">days ?</span>';
}

/** The origin the engine works with: either a known place or the private base. */
function originFrom(select) {
  if (select.value === "@base") return baseOrigin();
  if (select.value === "@here") return hereOrigin();
  return state.byId.get(select.value) || null;
}

function criteriaFilters() {
  return {
    festival: el("festival").value,
    entryType: el("entry-type").value,
    anchorClass: el("anchor").value || null,
    includeVisited: !el("hide-visited").checked,
    mustVisitOnly: el("must-visit-only").checked,
    minInterest: el("min-interest").value === "" ? null : Number(el("min-interest").value),
    requireAmenities: [...document.querySelectorAll("[data-amenity]")]
      .filter((box) => box.checked)
      .map((box) => box.dataset.amenity),
  };
}

/** Ids of the gardens that meet every filter, before anything done by hand. */
function criteriaMatches() {
  const area = el("area").value;
  const openDay = el("open-on").value;
  const maxKm = Number(el("max-km").value);
  const origin = maxKm > 0 ? originFrom(el("origin")) : null;
  const ids = new Set();
  for (const place of engine.eligible(state.bundle.places, criteriaFilters(), state.visits)) {
    if (area && place.area !== area) continue;
    // Unknown days are not closed days: only a published "not that day" excludes.
    if (openDay && opening.openOn(place, openDay) === false) continue;
    if (origin && place.id !== origin.id && state.model.from(origin, place).roadKm > maxKm) continue;
    ids.add(place.id);
  }
  return ids;
}

/** Everything every tab may draw from: matches, locked in, and lingering. */
function poolPlaces(matches = criteriaMatches()) {
  return state.pre.pool(state.bundle.places, matches).filter((place) => place.lat != null && place.lon != null);
}

function visitOf(id) {
  return state.visits.get(id) || {};
}

function setVisit(id, patch) {
  const next = { ...visitOf(id), ...patch };
  state.visits.set(id, next);
  writeStore(STORE_VISITS, Object.fromEntries(state.visits));
}

function doneIds() {
  return doneToday(state.done, today()).filter((id) => state.byId.has(id));
}

function setDone(ids) {
  state.done = { date: today(), ids };
  writeStore(STORE_DONE, state.done);
}

/**
 * Seen, or not. A garden seen while in the plan leaves the plan but stays in
 * today's My day as done, so the rest of the route does not reshuffle halfway
 * through the afternoon. Undoing it puts it back.
 */
function markVisited(id, visited) {
  setVisit(id, { visited, visitedOn: visited ? today() : null });
  planAfterSeen(id, visited);
  savePlan();
  render();
}

function planAfterSeen(id, visited) {
  const done = doneIds();
  if (visited) {
    if (state.pre.isLocked(id) && !done.includes(id)) setDone([...done, id]);
    state.pre.forget(id);
  } else if (done.includes(id)) {
    setDone(done.filter((other) => other !== id));
    state.pre.lock([id]);
  }
}

/** A place as routing should see it: with your own visit minutes, if you set them. */
function personal(place) {
  const minutes = visitOf(place.id).minutes;
  return minutes == null ? place : { ...place, minutes };
}

function amenityBadges(place) {
  const marks = { Refreshments: "☕", Toilets: "🚻", "Plants for Sale": "🌱", Accessibility: "♿" };
  return Object.entries(marks)
    .filter(([field]) => place.amenities?.[field] === "Yes")
    .map(([, mark]) => mark)
    .join(" ");
}

function download(name, text, type) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

// Google's directions URL takes at most nine intermediate stops.
const MAX_WAYPOINTS = 9;

/**
 * Hand an ordered run to Google Maps: start, the chosen stops, destination.
 *
 * "My day" cannot do this job, because it routes from your base and optionally
 * loops home. A journey collected on the way has its own two endpoints, and
 * losing them turns a drive north into a round trip.
 */
function openInMaps(start, stops, finish) {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  // Without a start, Google Maps begins from the phone's live position.
  if (start) url.searchParams.set("origin", `${start.lat},${start.lon}`);
  url.searchParams.set("destination", `${finish.lat},${finish.lon}`);
  if (stops.length) {
    url.searchParams.set("waypoints", stops.map((p) => `${p.lat},${p.lon}`).join("|"));
  }
  window.open(url.toString(), "_blank", "noopener");
}

/** A detour of a few metres is measurement noise, not a cost worth showing. */
function formatDetour(km) {
  if (Math.abs(km) < 0.05) return "free";
  return `${km > 0 ? "+" : "−"}${Math.abs(km).toFixed(1)} km`;
}

function mapsLink(place) {
  return `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lon}`;
}

function festivalClass(place) {
  return place.festivals.length > 1 ? "both" : (place.festivals[0] || "").toLowerCase();
}

function resultRow(row, index) {
  const place = row.place;
  const visit = visitOf(place.id);
  const item = document.createElement("li");
  item.className = "result";
  if (visit.visited) item.classList.add("is-visited");

  const primary =
    row.detourKm != null
      ? `<span class="metric">${formatDetour(row.detourKm)}</span><span class="sub">${row.estimate.roadKm.toFixed(0)} out · ${row.onward.roadKm.toFixed(0)} on</span>`
      : `<span class="metric">${row.estimate.roadKm.toFixed(1)} km</span><span class="sub">${Math.round(row.estimate.minutes)} min</span>`;

  const festival = festivalClass(place);
  const inPlan = state.pre.isLocked(place.id);
  const rating = visit.interest ?? place.interest ?? "";
  // Labelling both ends, because a scale whose direction you have to guess
  // invites a whole set of inverted ratings.
  const SCALE = { "": "rate", 1: "1 low", 5: "5 neutral", 10: "10 top" };
  const options = ["", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    .map((value) => {
      const label = SCALE[value] ?? value;
      return `<option value="${value}"${String(value) === String(rating) ? " selected" : ""}>${label}</option>`;
    })
    .join("");
  const score = row.score != null ? `<span class="score">${row.score.toFixed(2)}</span>` : "";

  item.innerHTML = `
    <div class="rank">${row.detourKm != null && state.order === "route" ? "" : index + 1}</div>
    <div class="figure">${primary}</div>
    <div class="body">
      <div class="name">${escapeHtml(place.name)} ${score}</div>
      <div class="meta">
        <span class="tag tag-${festival}">${festival}</span>
        ${place.anchor === "Daily anchor" ? '<span class="tag tag-anchor">major</span>' : ""}
        <span class="badges">${amenityBadges(place)}</span>
        <span class="region">${escapeHtml(place.area || place.region)}</span>
        ${openingTag(place, el("open-on").value)}
        <select class="rate${rating === "" ? "" : " is-rated"}" data-rate="${place.id}"
          title="How interesting is this garden, 1 to 10?">${options}</select>
      </div>
    </div>
    <div class="actions">
      <button type="button" class="${inPlan ? "is-on" : ""}" data-add="${place.id}"
        title="${inPlan ? "Release from your plan" : "Lock into your plan"}">${inPlan ? "✓ Plan" : "+ Plan"}</button>
      <button type="button" class="${visit.visited ? "is-on" : ""}" data-visited="${place.id}"
        title="${visit.visited ? "Mark as not visited" : "Mark as visited"}">${visit.visited ? "✓ Seen" : "Seen?"}</button>
      <a href="${mapsLink(place)}" target="_blank" rel="noopener"
        title="Open directions in Google Maps">Map ↗</a>
    </div>`;
  return item;
}

function render() {
  const results = el("results");
  const status = el("status");
  results.innerHTML = "";

  const matches = criteriaMatches();
  const pool = poolPlaces(matches);
  updateSummary(pool);
  updateWhere();
  if (el("preselect-dialog").open) renderPreselect(matches, pool);
  if (el("edit-dialog").open) renderEditor(pool);

  const onMap = state.mode === "map";
  document.body.classList.toggle("map-mode", onMap);
  el("map-view").hidden = !onMap;
  if (onMap) {
    renderMap(matches);
    return;
  }
  state.map?.setSelecting(false);
  state.map?.hidePopup();

  const origin = originFrom(el("origin"));
  // My day can still order chosen gardens without a start point.
  if (!origin && state.mode !== "route") {
    status.textContent = "Set your base, or press Here, to begin.";
    el("via-handoff").hidden = true;
    el("plan").hidden = true;
    return;
  }

  // "All" is stored as 0, so the whole pool can be ticked through.
  const count = Number(el("count").value) || state.bundle.places.length;
  state.order = el("order").value;
  let rows = [];

  if (state.mode === "nearest") {
    if (el("rank").value === "blend") {
      const interest = Number(el("interest-weight").value) / 100;
      rows = engine.recommend(pool, origin, count, state.model, OPEN_FILTERS, state.visits, {
        distance: 1 - interest,
        interest,
      });
    } else {
      rows = engine.nearest(pool, origin, count, state.model, OPEN_FILTERS, state.visits);
    }
  } else if (state.mode === "via") {
    const destination = originFrom(el("destination"));
    if (!destination) {
      status.textContent = "Choose where you are heading.";
      return;
    }
    const cap = Number(el("detour-cap").value);
    rows = engine.onTheWay(
      pool, origin, destination, count, state.model,
      OPEN_FILTERS, state.visits, cap > 0 ? cap : null, el("order").value
    );
  }

  if (state.mode !== "route") {
    if (!rows.length) {
      status.textContent = pool.length
        ? "Nothing in your preselection fits here."
        : "Nothing matches your preselection. Open Preselect to widen it.";
    } else {
      const source = rows[0].estimate.source;
      const ranking =
        state.mode === "nearest" && el("rank").value === "blend" ? " · ranked by distance and ratings" : "";
      status.textContent = `${rows.length} shown${ranking} · ${source}`;
    }
    rows.forEach((row, index) => results.append(resultRow(row, index)));
    renderViaHandoff(origin);
  } else {
    el("via-handoff").hidden = true;
    status.textContent =
      state.pre.locked.length || doneIds().length
        ? ""
        : "Nothing in your plan yet. Tick gardens in Preselect, tap them on the map, or use + Plan.";
  }

  renderPlan(origin);
  const build = document.querySelector('meta[name="build"]')?.content || "dev";
  el("provenance").textContent =
    `${state.bundle.places.length} destinations · road costs baked ` +
    `${(state.bundle.generatedAt || "").slice(0, 10)} · build ${build}`;
}

function lockedPlaces() {
  return state.pre.locked.map((id) => state.byId.get(id)).filter((place) => place && place.lat != null);
}

/** Ready to route: personal visit minutes applied. */
function routable(places) {
  return places.map(personal);
}

function renderViaHandoff(origin) {
  const panel = el("via-handoff");
  if (state.mode !== "via") {
    panel.hidden = true;
    return;
  }
  const destination = originFrom(el("destination"));
  const list = el("via-list");
  const summary = el("via-summary");
  panel.hidden = false;
  list.innerHTML = "";

  const chosen = routable(lockedPlaces());
  if (!chosen.length || !destination) {
    summary.textContent = "Tick + Plan on anything below to build a run.";
    el("via-navigate").disabled = true;
    return;
  }

  // Both ends pinned, the middle optimised. Sorting stops by how far along the
  // way they are is optimal only while every stop is a cheap detour; as soon as
  // you add somewhere you simply want to go, it stops being.
  const route = memoRoute(
    "run",
    chosen,
    origin,
    [destination.id, destination.lat, destination.lon],
    () => engine.buildRoute(chosen, origin, state.model, false, destination)
  );
  const direct = state.model.from(origin, destination).roadKm;

  route.legs.forEach((leg, index) => {
    list.append(legItem(leg));
    const place = route.places[index];
    if (place) list.append(stopItem(place, { done: false, seenButton: false }));
  });

  const hours = (route.totalMinutes / 60).toFixed(1);
  summary.textContent =
    `${route.places.length} stops · ${route.totalKm.toFixed(1)} km ` +
    `(${(route.totalKm - direct).toFixed(1)} km more than driving straight there) · ` +
    `${Math.round(route.travelMinutes)} min driving · ${hours} hours all up`;
  el("via-navigate").disabled = false;
  el("via-navigate").onclick = () =>
    openInMaps(origin, route.places.slice(0, MAX_WAYPOINTS), destination);
}

function legItem(leg) {
  const drive = document.createElement("li");
  drive.className = "leg";
  drive.innerHTML = `<span class="drive">${leg.estimate.roadKm.toFixed(1)} km · ${Math.round(leg.estimate.minutes)} min</span> <span class="to">${escapeHtml(leg.to)}</span>`;
  return drive;
}

function stopItem(place, { done, seenButton }) {
  const stop = document.createElement("li");
  stop.className = done ? "stop is-done" : "stop";
  const stay = `${place.minutes ?? engine.DEFAULT_VISIT_MINUTES} min${place.minutes == null ? " (assumed)" : ""}`;
  const buttons = done
    ? `<button type="button" class="link" data-visited="${place.id}" title="Not seen after all: back into the plan">undo</button>`
    : `${seenButton ? `<button type="button" class="seen" data-visited="${place.id}" title="Seen it: tick off, keep the route as it is">Seen</button>` : ""}
       <button type="button" class="link" data-remove="${place.id}">remove</button>`;
  stop.innerHTML = `
    <span class="stay">${done ? "done ✓" : stay}</span>
    <span class="to">${escapeHtml(engine.mapLabel(place))} ${escapeHtml(place.name)} ${done ? "" : openingTag(place, checkDay())}</span>
    ${buttons}`;
  return stop;
}

function renderPlan(origin) {
  const panel = el("plan");
  const list = el("plan-list");
  const summary = el("plan-summary");
  panel.hidden = state.mode !== "route";
  if (state.mode !== "route") return;

  list.innerHTML = "";
  const base = baseOrigin();
  const fromHere = origin?.id === position.HERE_ID;
  const done = new Set(doneIds());
  // Gardens done today stay in the route, so it keeps its shape as the day goes.
  // Re-planned from here, they are behind you: listed as done, not routed.
  const doneToShow = [...done].map((id) => state.byId.get(id)).filter(Boolean);
  const chosen = routable(
    (fromHere ? lockedPlaces() : [...lockedPlaces(), ...doneToShow]).filter(
      (place, index, all) => all.findIndex((other) => other.id === place.id) === index
    )
  );
  el("plan-no-start").hidden = Boolean(origin) || !chosen.length;
  el("return-home").closest("label").hidden = !base;
  el("head-base").hidden = !base;
  if (base) {
    const toBase = state.here ? state.model.from(hereOrigin(), base) : null;
    el("head-base-label").textContent = toBase ? `Head to base · ${toBase.roadKm.toFixed(0)} km` : "Head to base";
  }
  if (fromHere) doneToShow.forEach((place) => list.append(stopItem(place, { done: true, seenButton: false })));
  if (!chosen.length) {
    summary.textContent = "";
    el("navigate").hidden = true;
    return;
  }

  const returnHome = el("return-home").checked && Boolean(base);
  const finish = returnHome ? base : null;
  const route = origin
    ? memoRoute("day", chosen, origin, [returnHome, base?.lat, base?.lon], () =>
        engine.buildRoute(chosen, origin, state.model, false, finish))
    : memoRoute("day-free", chosen, null, null, () => engine.routeFromBestFirstStop(chosen, state.model));

  const addStop = (place) => list.append(stopItem(place, { done: done.has(place.id), seenButton: true }));
  if (route.startsAtFirstStop) {
    // Begins at a garden: stop, then each drive leads to the next stop.
    route.places.forEach((place, index) => {
      if (index > 0) list.append(legItem(route.legs[index - 1]));
      addStop(place);
    });
  } else {
    route.legs.forEach((leg, index) => {
      list.append(legItem(leg));
      if (route.places[index]) addStop(route.places[index]);
    });
  }

  const remaining = route.places.filter((place) => !done.has(place.id));
  const hours = (route.totalMinutes / 60).toFixed(1);
  summary.textContent =
    (fromHere ? "From where you are · " : "") +
    `${route.places.length} stops${done.size && !fromHere ? ` (${done.size} done)` : ""} · ${route.totalKm.toFixed(1)} km · ` +
    `${Math.round(route.travelMinutes)} min driving · ${hours} hours all up` +
    (route.method === "exact" ? "" : " · order approximate above 15 stops") +
    (checkDay() ? ` · opening checked for ${opening.dayLabel(checkDay())}` : "");
  el("navigate").hidden = !remaining.length;
  el("navigate").textContent = done.size ? "Open the rest in Google Maps" : "Open in Google Maps";
  el("navigate").onclick = () => {
    // The app plans; the phone navigates. Only what is left, in route order.
    const stops = [...remaining];
    // From here, let Google start from the live position rather than the last fix.
    const start = fromHere ? null : origin || stops.shift();
    const end = finish || stops.pop() || start;
    openInMaps(start, stops.slice(0, MAX_WAYPOINTS), end);
  };
}

/** The filters in words, for the strip under the tabs. */
function filterWords() {
  const parts = [];
  if (el("area").value) parts.push(el("area").value);
  if (el("open-on").value) parts.push(`open ${opening.dayLabel(el("open-on").value)}`);
  if (el("festival").value !== "Both") parts.push(el("festival").value);
  if (el("entry-type").value !== "All") parts.push(el("entry-type").selectedOptions[0].textContent);
  if (el("anchor").value) parts.push(el("anchor").selectedOptions[0].textContent.toLowerCase());
  const km = Number(el("max-km").value);
  if (km > 0) parts.push(`within ${km} km`);
  if (el("min-interest").value) parts.push(`rated ${el("min-interest").value}+`);
  if (el("must-visit-only").checked) parts.push("must visit");
  for (const box of document.querySelectorAll("[data-amenity]")) {
    if (box.checked) parts.push(box.closest("label").textContent.trim().toLowerCase());
  }
  if (!el("hide-visited").checked) parts.push("showing seen");
  if (el("rank").value === "blend") parts.push(`ratings ${el("interest-weight").value}%`);
  return parts;
}

function updateSummary(pool) {
  const locked = state.pre.locked.length;
  el("plan-count").textContent = String(locked);
  el("plan-count").hidden = locked === 0;
  el("plan-count").title = `${locked} in your plan`;
  const available = pool.filter((place) => !state.pre.isLocked(place.id)).length;
  const words = filterWords();
  el("preselect-summary").textContent =
    `${locked} in plan · ${available} more available` + (words.length ? ` · ${words.join(" · ")}` : "");

  el("weight-field").hidden = el("rank").value !== "blend";
  el("interest-weight-value").textContent = `${el("interest-weight").value}%`;
  el("max-km-value").textContent = km(el("max-km").value);
  el("range-note").hidden = !(Number(el("max-km").value) > 0 && !originFrom(el("origin")));
}

function km(value) {
  return Number(value) > 0 ? `within ${value} km` : "any";
}

function resetFilters() {
  for (const [id, value] of Object.entries(FILTER_DEFAULTS)) el(id).value = value;
  for (const [id, value] of Object.entries(FILTER_CHECK_DEFAULTS)) el(id).checked = value;
  document.querySelectorAll("[data-amenity]").forEach((box) => (box.checked = false));
}

function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (c) => entities[c]);
}

/* ------------------------------------------------------------ preselect -- */

function preselectRow(place, { lingering, outside }) {
  const locked = state.pre.isLocked(place.id);
  const visit = visitOf(place.id);
  const notes = [];
  if (visit.visited) notes.push('<span class="tag tag-anchor">seen</span>');
  const tag = openingTag(place, el("open-on").value);
  if (tag) notes.push(tag);
  if (lingering) notes.push('<span class="ps-released" title="Released. Stays in view until you next change a filter.">released</span>');
  const classes = ["ps-row"];
  if (locked) classes.push("is-locked");
  if (lingering || outside) classes.push("is-faint");
  return `
    <li class="${classes.join(" ")}">
      <label>
        <input type="checkbox" data-lock="${place.id}"${locked ? " checked" : ""} />
        <span class="ps-nr ps-nr-${festivalClass(place)}">${escapeHtml(engine.gardenNr(place)) || "–"}</span>
        <span class="ps-text">
          <span class="ps-name">${escapeHtml(place.name)}</span>
          <span class="ps-meta">${escapeHtml(place.area || place.region)} · ${escapeHtml(place.address)} ${notes.join(" ")}</span>
        </span>
      </label>
    </li>`;
}

/** What the list shows right now: the pool, narrowed by any search. */
function shownPlaces(pool) {
  const search = el("ps-search").value;
  return pool.filter((place) => matchesSearch(place, search)).sort((a, b) => a.name.localeCompare(b.name));
}

function renderPreselect(matches = criteriaMatches(), pool = poolPlaces(matches)) {
  const search = el("ps-search").value;
  const shown = shownPlaces(pool);
  el("ps-list").innerHTML = shown
    .map((place) => preselectRow(place, { lingering: state.pre.isLingering(place.id) && !matches.has(place.id), outside: false }))
    .join("");

  // A search should find a garden even when the filters have hidden it.
  const inPool = new Set(pool.map((place) => place.id));
  const outside = searchTerm(search)
    ? sortedPlaces().filter((place) => place.lat != null && !inPool.has(place.id) && matchesSearch(place, search))
    : [];
  el("ps-outside").hidden = !outside.length;
  el("ps-outside-list").innerHTML = outside.map((place) => preselectRow(place, { lingering: false, outside: true })).join("");

  const lockedShown = shown.filter((place) => state.pre.isLocked(place.id)).length;
  const searching = searchTerm(search) ? ` matching “${escapeHtml(search.trim())}”` : "";
  el("ps-shown").innerHTML = `${shown.length} shown${searching} · ${lockedShown} ticked`;
  el("ps-tab-count").textContent = `(${pool.length})`;
  el("ps-choose-all").disabled = lockedShown === shown.length;
  el("ps-release-all").disabled = lockedShown === 0;
  el("ps-estimate").textContent = planEstimate();
  el("max-km-value").textContent = km(el("max-km").value);
}

/** A guide, not a promise: the shortest loop through everything locked in. */
function planEstimate() {
  const chosen = routable(lockedPlaces());
  if (!chosen.length) return "Nothing locked in yet.";
  const origin = originFrom(el("origin"));
  const route = origin
    ? memoRoute("day", chosen, origin, true, () => engine.buildRoute(chosen, origin, state.model, true))
    : memoRoute("day-free", chosen, null, null, () => engine.routeFromBestFirstStop(chosen, state.model));
  const gardens = `${chosen.length} garden${chosen.length === 1 ? "" : "s"} locked in`;
  const exact = route.method === "exact";
  const distance = `${exact ? "" : "roughly "}${Math.round(route.totalKm)} km`;
  const shape = origin
    ? `${exact ? "shortest loop" : "a loop"} from ${origin.name} and back`
    : `${exact ? "shortest run" : "a run"} from first garden to last`;
  const hours = (route.totalMinutes / 60).toFixed(1);
  return `${gardens} · ${distance}, ${shape} · about ${hours} hours with visits`;
}

function openPreselect() {
  const dialog = el("preselect-dialog");
  if (!dialog.open) dialog.showModal();
  render();
}

function setPane(pane) {
  el("preselect-dialog").dataset.pane = pane;
  document.querySelectorAll("#preselect-dialog .ps-tab").forEach((tab) => {
    const on = tab.dataset.pane === pane;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", String(on));
  });
}

/* ---------------------------------------------------------- garden edit -- */

const SIZE_WORDS = { "Daily anchor": "Major (half-day)", Support: "Worth a stop" };
const MIXED = "__mixed";

function pickedPlaces() {
  return [...state.picked].map((id) => state.byId.get(id)).filter(Boolean);
}

/** The gardens listed for editing: a scope, narrowed by any search. */
function editListPlaces(pool = poolPlaces()) {
  const scope = el("ed-scope").value;
  const base = scope === "all" ? state.bundle.places : scope === "plan" ? lockedPlaces() : pool;
  const search = el("ed-search").value;
  return base.filter((place) => matchesSearch(place, search)).sort((a, b) => a.name.localeCompare(b.name));
}

/** A glance at what has been set, so the list shows what editing did. */
function personalSummary(place) {
  const visit = visitOf(place.id);
  const parts = [];
  const rating = edit.effective("interest", place, visit);
  if (rating != null) parts.push(`rated ${rating}`);
  const must = edit.effective("mustVisit", place, visit);
  if (must === "Yes") parts.push("must visit");
  else if (must === "Maybe") parts.push("maybe");
  if (visit.visited) parts.push(visit.visitedOn ? `seen ${shortDate(visit.visitedOn)}` : "seen");
  if (visit.minutes != null) parts.push(`${visit.minutes} min`);
  if (visit.note) parts.push("note");
  if (state.pre.isLocked(place.id)) parts.push("in plan");
  return parts;
}

function shortDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
}

function editRow(place) {
  const picked = state.picked.has(place.id);
  const summary = personalSummary(place);
  return `
    <li class="ps-row${picked ? " is-picked" : ""}">
      <label>
        <input type="checkbox" data-pick="${place.id}"${picked ? " checked" : ""} />
        <span class="ps-nr ps-nr-${festivalClass(place)}">${escapeHtml(engine.gardenNr(place)) || "–"}</span>
        <span class="ps-text">
          <span class="ps-name">${escapeHtml(place.name)}</span>
          <span class="ps-meta">${escapeHtml(place.area || place.region)}${
            summary.length ? ` · <span class="ed-summary">${escapeHtml(summary.join(" · "))}</span>` : ""
          }</span>
        </span>
      </label>
    </li>`;
}

/** A select showing the shared value, or "mixed" where the gardens differ. */
function setChoice(select, info, toValue = (value) => (value == null ? "" : String(value))) {
  select.querySelector(`option[value="${MIXED}"]`)?.remove();
  if (info.mixed) {
    const option = new Option("mixed", MIXED);
    option.disabled = true;
    select.prepend(option);
    select.value = MIXED;
  } else {
    select.value = toValue(info.value);
  }
}

function setText(input, info, fallback = "") {
  // Never overwrite what someone is in the middle of typing.
  if (document.activeElement === input) return;
  input.value = info.mixed || info.value == null ? "" : String(info.value);
  input.placeholder = info.mixed ? "mixed · type to set them all" : fallback;
}

function renderEditor(pool = poolPlaces()) {
  const shown = editListPlaces(pool);
  const picked = pickedPlaces();

  el("ed-list").innerHTML = shown.length
    ? shown.map(editRow).join("")
    : '<li class="note ed-empty">No gardens here. Try another list or search.</li>';
  const pickedShown = shown.filter((place) => state.picked.has(place.id)).length;
  const hidden = picked.length - pickedShown;
  el("ed-shown").textContent =
    `${shown.length} shown · ${picked.length} highlighted` + (hidden > 0 ? ` (${hidden} not shown)` : "");
  el("ed-tab-shown").textContent = `(${shown.length})`;
  el("ed-tab-picked").textContent = picked.length ? `(${picked.length})` : "";
  el("ed-pick-all").disabled = !shown.length || pickedShown === shown.length;
  el("ed-pick-none").disabled = !picked.length;
  el("ed-go-edit").hidden = !picked.length;
  el("ed-go-edit").textContent = `Edit ${picked.length} highlighted`;

  // Who is being edited, always in view, so a change never lands by surprise.
  if (!picked.length) {
    el("ed-target").innerHTML = '<p class="note">Highlight one or more gardens to edit them.</p>';
  } else if (picked.length === 1) {
    const [place] = picked;
    el("ed-target").innerHTML = `
      <div class="ed-one"><span class="ps-nr ps-nr-${festivalClass(place)}">${escapeHtml(engine.gardenNr(place))}</span>
      <strong>${escapeHtml(place.name)}</strong></div>`;
  } else {
    el("ed-target").innerHTML = `
      <p class="ed-count"><strong>${picked.length} gardens</strong> highlighted</p>
      <div class="ed-chips">${picked
        .map(
          (place) => `<button type="button" class="ed-chip" data-unpick="${place.id}"
            title="Stop editing ${escapeHtml(place.name)}">${escapeHtml(place.name)} ×</button>`
        )
        .join("")}</div>`;
  }

  el("ed-fields").disabled = !picked.length;
  const info = (field) => edit.common(field, picked, visitOf);
  setChoice(el("ed-interest"), info("interest"));
  setChoice(el("ed-mustVisit"), info("mustVisit"));
  const seen = info("visited");
  setChoice(el("ed-visited"), seen, (value) => (value ? "Yes" : "No"));

  const allSeen = !seen.mixed && seen.value === true;
  const dates = info("visitedOn");
  el("ed-visitedOn").disabled = !allSeen;
  setText(el("ed-visitedOn"), allSeen ? dates : { mixed: false, value: null });
  const visitedNote = el("ed-visited-note");
  visitedNote.hidden = true;
  if (picked.length && seen.mixed) {
    visitedNote.hidden = false;
    visitedNote.textContent = "Some are seen and some not. A date can be set once they all are.";
  } else if (allSeen && dates.mixed) {
    visitedNote.hidden = false;
    visitedNote.textContent = "Seen on different days. Pick a date to set them all.";
  }

  const listed = new Set(picked.map((place) => place.minutes ?? null));
  const listingHint =
    listed.size === 1 && [...listed][0] != null
      ? `listing says ${[...listed][0]}`
      : `${engine.DEFAULT_VISIT_MINUTES} assumed`;
  setText(el("ed-minutes"), info("minutes"), listingHint);
  el("ed-clear-minutes").disabled = !picked.some((place) => visitOf(place.id).minutes != null);
  setText(el("ed-note"), info("note"));
  el("ed-clear-note").disabled = !picked.some((place) => visitOf(place.id).note);

  el("ed-undo").disabled = !state.history.size;
  el("ed-undo").textContent = state.history.size ? `Undo: ${state.history.last.label}` : "Undo";
  el("ed-last").textContent = state.lastEdit;

  renderListing(picked);
}

/** Read-only facts from the festival listing, for one garden. */
function renderListing(picked) {
  const box = el("ed-listing");
  box.hidden = picked.length !== 1;
  if (picked.length !== 1) return;
  const [place] = picked;
  const amenities = Object.entries(place.amenities || {})
    .filter(([, value]) => value === "Yes")
    .map(([name]) => name);
  const rows = [
    ["Address", place.address],
    ["Area", place.area || place.region],
    ["Festival", place.festivals.join(" + ")],
    ["Type", place.type],
    ["Size", SIZE_WORDS[place.anchor] || (place.anchor && place.anchor !== "None" ? place.anchor : "not given")],
    ["Open", opening.describeDays(place, festivalDays())],
    ["Hours", place.open?.hours || "not published"],
    ["Listing visit", place.minutes != null ? `${place.minutes} min` : "not given"],
    ["Facilities", amenities.length ? amenities.join(", ") : "not recorded"],
  ];
  box.innerHTML = `
    <p class="ps-subhead">From the festival listing</p>
    <dl>${rows.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}

function describeEdit(field, value) {
  const name = edit.FIELD_LABELS[field];
  if (field === "visited") return value ? "seen" : "not seen";
  if (value == null) return `${name} cleared`;
  if (field === "note") return "notes";
  if (field === "minutes") return `${value} min`;
  if (field === "visitedOn") return `seen on ${shortDate(value)}`;
  return `${name} ${value}`;
}

function snapshot(ids) {
  return {
    visits: ids.map((id) => [id, state.visits.has(id) ? { ...state.visits.get(id) } : null]),
    pre: state.pre.toJSON(),
    done: state.done ? { ...state.done, ids: [...(state.done.ids || [])] } : null,
  };
}

/** One field, to every highlighted garden it would change. Undoable. */
function applyEdit(field, value) {
  const picked = pickedPlaces();
  const before = snapshot(picked.map((place) => place.id));
  let changed = 0;
  for (const place of picked) {
    const patch = edit.patchFor(field, value, place, visitOf(place.id), today());
    if (!patch) continue;
    setVisit(place.id, patch);
    if (field === "visited") planAfterSeen(place.id, value);
    changed += 1;
  }
  el("ed-error").hidden = true;
  if (changed) {
    const label = `${describeEdit(field, value)}, ${changed} garden${changed === 1 ? "" : "s"}`;
    state.history.push({ label, before });
    state.lastEdit = `Saved: ${label}.`;
    savePlan();
  } else {
    state.lastEdit = "Nothing to change: already set that way.";
  }
  render();
}

function undoEdit() {
  const entry = state.history.pop();
  if (!entry) return;
  for (const [id, visit] of entry.before.visits) {
    if (visit) state.visits.set(id, visit);
    else state.visits.delete(id);
  }
  writeStore(STORE_VISITS, Object.fromEntries(state.visits));
  state.pre = new Preselection(entry.before.pre);
  state.done = entry.before.done;
  writeStore(STORE_DONE, state.done);
  state.lastEdit = `Undone: ${entry.label}.`;
  savePlan();
  render();
}

function setEditPane(pane) {
  el("edit-dialog").dataset.pane = pane;
  document.querySelectorAll("#edit-dialog .ps-tab").forEach((tab) => {
    const on = tab.dataset.editPane === pane;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", String(on));
  });
}

function wireEditor() {
  el("edit-button").addEventListener("click", () => {
    setEditPane("gardens");
    state.lastEdit = "";
    el("ed-error").hidden = true;
    if (!el("edit-dialog").open) el("edit-dialog").showModal();
    render();
  });
  el("edit-done").addEventListener("click", () => el("edit-dialog").close());
  el("edit-dialog").addEventListener("close", () => render());
  document
    .querySelectorAll("#edit-dialog .ps-tab")
    .forEach((tab) => tab.addEventListener("click", () => setEditPane(tab.dataset.editPane)));
  el("ed-go-edit").addEventListener("click", () => setEditPane("edit"));

  el("ed-search").addEventListener("input", () => renderEditor());
  el("ed-scope").addEventListener("change", () => renderEditor());

  el("ed-list").addEventListener("change", (event) => {
    const box = event.target.closest("[data-pick]");
    if (!box) return;
    if (box.checked) state.picked.add(box.dataset.pick);
    else state.picked.delete(box.dataset.pick);
    el("ed-error").hidden = true;
    renderEditor();
  });
  el("ed-pick-all").addEventListener("click", () => {
    for (const place of editListPlaces()) state.picked.add(place.id);
    renderEditor();
  });
  el("ed-pick-none").addEventListener("click", () => {
    state.picked.clear();
    renderEditor();
  });
  el("ed-target").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-unpick]");
    if (!chip) return;
    state.picked.delete(chip.dataset.unpick);
    renderEditor();
  });

  // Choices save as they are made; typed text saves when you leave the field.
  el("ed-fields").addEventListener("change", (event) => {
    const control = event.target.closest("[data-field]");
    if (!control || control.value === MIXED) return;
    const field = control.dataset.field;
    const parsed = edit.parse(field, control.value);
    if (!parsed.ok) {
      el("ed-error").textContent = parsed.message;
      el("ed-error").hidden = false;
      return;
    }
    applyEdit(field, parsed.value);
  });
  // The one way to empty a field for gardens that differ: a blank box means "leave alone".
  el("ed-clear-minutes").addEventListener("click", () => applyEdit("minutes", null));
  el("ed-clear-note").addEventListener("click", () => applyEdit("note", null));
  el("ed-undo").addEventListener("click", undoEdit);
}

/* ------------------------------------------------------------------ map -- */

/** What a press-and-hold on a pin shows: enough to confirm it is the right one. */
function describePlace(place) {
  if (place.kind === "base" || place.kind === "here") return describeMarker(place);
  const locked = state.pre.isLocked(place.id);
  const what = locked
    ? "in your plan · tap to release"
    : place.greyed
      ? "outside your preselection · tap to lock in"
      : "available · tap to lock in";
  return `
    <div class="map-popup-nr">${escapeHtml(engine.gardenNr(place))}</div>
    <div class="map-popup-name">${escapeHtml(place.name)}</div>
    <div class="map-popup-address">${escapeHtml(place.address)}</div>
    <div class="map-popup-open">Open ${escapeHtml(opening.describeDays(place, festivalDays()))}${
      place.open?.hours ? ` · ${escapeHtml(place.open.hours)}` : ""
    } ${openingTag(place, el("open-on").value)}</div>
    <div class="map-popup-meta">${escapeHtml(place.festivals.join(" + "))} · ${what}</div>`;
}

const routeMemo = new Map();

/** Solve a route once per distinct question, however often the screen redraws. */
function memoRoute(kind, chosen, origin, extra, solve) {
  const key = JSON.stringify([
    kind,
    // Minutes too: how long a visit takes changes the day, if not the order.
    chosen.map((place) => `${place.id}:${place.minutes ?? ""}`).sort(),
    origin ? [origin.id, origin.lat, origin.lon] : null,
    extra,
    state.travelVersion,
  ]);
  if (!routeMemo.has(key)) {
    routeMemo.set(key, solve());
    // A handful is plenty: the estimate, My day and a run at most.
    while (routeMemo.size > 6) routeMemo.delete(routeMemo.keys().next().value);
  }
  return routeMemo.get(key);
}

function positionMap() {
  // The map sits under the preselect strip, so its summary stays readable.
  const strip = document.querySelector(".filter-strip").getBoundingClientRect();
  document.documentElement.style.setProperty("--map-top", `${Math.round(strip.bottom)}px`);
}

function renderMap(matches) {
  // Measure from the top of the page, or a scrolled list would push the map up.
  window.scrollTo(0, 0);
  positionMap();
  if (!state.map) {
    state.map = createMap({
      container: el("map-canvas"),
      isPlanned: (id) => state.pre.isLocked(id),
      onToggle: (id) => togglePlan(id),
      onSetMany: (ids, locked) => {
        state.pre.setMany(ids, locked, criteriaMatches());
        savePlan();
        render();
      },
      describe: describePlace,
      onViewChange: (view) => {
        state.mapView = view;
        saveView();
      },
    });
    state.map.setGeography(state.bundle.geography);
    state.map.onSelectingChange((on) => {
      el("map-select").classList.toggle("is-on", on);
      el("map-select").setAttribute("aria-pressed", String(on));
      el("map-hint").hidden = !on;
    });
    // The size is only known once the view has been laid out.
    setTimeout(() => {
      if (state.mapView) state.map.restore(state.mapView);
      else state.map.fit();
    }, 0);
  }

  const drawn = mapStates(state.bundle.places, state.pre, matches, (id) => Boolean(visitOf(id).visited));
  const visible = drawn.map(({ place, state: pinState }) => ({
    ...place,
    label: engine.mapLabel(place),
    festivalClass: festivalClass(place),
    greyed: pinState === "greyed",
  }));
  state.map.setPlaces(visible, state.bundle.places);
  state.map.setMarkers(mapMarkers());
  const count = (wanted) => drawn.filter((entry) => entry.state === wanted).length;
  el("map-count").textContent =
    `${count("locked")} in plan · ${count("available")} available · ${count("greyed")} greyed`;
}

function togglePlan(id) {
  state.pre.toggle(id, criteriaMatches());
  savePlan();
  render();
}

/* ---------------------------------------------------------------- wiring -- */

function wire() {
  document.querySelectorAll(".mode").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".mode").forEach((b) => b.classList.remove("is-active"));
      button.classList.add("is-active");
      if (state.mode === "map" && button.dataset.mode !== "map") finishPlacingBase();
      state.mode = button.dataset.mode;
      showModeControls();
      saveView();
      render();
    });
  });

  ["origin", "destination", "order", "count", "detour-cap", "return-home", "rank"].forEach((id) =>
    el(id).addEventListener("change", () => { saveView(); render(); })
  );
  el("interest-weight").addEventListener("input", () => { saveView(); render(); });

  // A filter change ends lingering: released gardens now stay or go on their merits.
  const criteriaChanged = () => {
    state.pre.criteriaChanged();
    saveView();
    render();
  };
  [...CRITERIA_CONTROLS, ...CRITERIA_CHECKBOXES].forEach((id) => el(id).addEventListener("change", criteriaChanged));
  document.querySelectorAll("[data-amenity]").forEach((box) => box.addEventListener("change", criteriaChanged));
  // The slider reports while dragging; only the value it is let go at is a change.
  el("max-km").addEventListener("input", () => { el("max-km-value").textContent = km(el("max-km").value); });
  el("max-km").addEventListener("change", criteriaChanged);
  el("filters-reset").addEventListener("click", () => {
    resetFilters();
    criteriaChanged();
  });

  el("preselect-button").addEventListener("click", () => {
    // On a phone, open where the work is: the list if there is a plan, else filters.
    if (window.matchMedia("(max-width: 759px)").matches) {
      setPane(state.pre.locked.length ? "gardens" : "filters");
    }
    openPreselect();
  });
  el("preselect-done").addEventListener("click", () => el("preselect-dialog").close());
  el("preselect-dialog").addEventListener("close", () => render());
  document
    .querySelectorAll("#preselect-dialog .ps-tab")
    .forEach((tab) => tab.addEventListener("click", () => setPane(tab.dataset.pane)));

  wireEditor();

  // Searching narrows the list only, so nothing else needs redrawing.
  el("ps-search").addEventListener("input", () => {
    if (searchTerm(el("ps-search").value)) setPane("gardens");
    renderPreselect();
  });

  el("preselect-dialog").addEventListener("change", (event) => {
    const box = event.target.closest("[data-lock]");
    if (!box) return;
    if (box.checked) state.pre.lock([box.dataset.lock]);
    else state.pre.release([box.dataset.lock], criteriaMatches());
    savePlan();
    render();
  });
  el("ps-choose-all").addEventListener("click", () => {
    state.pre.lock(shownPlaces(poolPlaces()).map((place) => place.id));
    savePlan();
    render();
  });
  el("ps-release-all").addEventListener("click", () => {
    const matches = criteriaMatches();
    state.pre.release(shownPlaces(poolPlaces(matches)).map((place) => place.id), matches);
    savePlan();
    render();
  });

  document.body.addEventListener("change", (event) => {
    const select = event.target.closest("[data-rate]");
    if (!select) return;
    const value = select.value === "" ? null : Number(select.value);
    setVisit(select.dataset.rate, { interest: value });
    render();
  });

  document.body.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.add) togglePlan(target.dataset.add);
    else if (target.dataset.remove) togglePlan(target.dataset.remove);
    else if (target.dataset.visited) markVisited(target.dataset.visited, !visitOf(target.dataset.visited).visited);
  });

  el("export").addEventListener("click", () => {
    // A worksheet of every destination, not only the ones already touched, so
    // it can be filled in at a desk in a spreadsheet.
    download("garden-notes.csv", toCsv(state.bundle.places, state.visits), "text/csv");
  });

  el("import").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const known = new Set(state.byId.keys());
      const { notes, unknown, rejected } = text.trimStart().startsWith("{")
        ? { notes: JSON.parse(text).places || {}, unknown: [], rejected: [] }
        : fromCsv(text, known);

      let applied = 0;
      for (const [id, entry] of Object.entries(notes)) {
        if (!known.has(id)) continue;
        setVisit(id, entry);
        applied += 1;
      }
      render();
      const notes_ = [`Imported ${applied} place(s).`];
      if (unknown.length) notes_.push(`${unknown.length} unknown id(s) skipped.`);
      if (rejected.length) notes_.push(`${rejected.length} value(s) rejected: ${rejected[0]}`);
      el("status").textContent = notes_.join(" ");
    } catch (error) {
      el("status").textContent = `That file could not be read: ${error.message}`;
    }
    event.target.value = "";
  });


  el("map-select").addEventListener("click", () => {
    if (state.map) state.map.setSelecting(!state.map.selecting);
  });
  el("map-fit").addEventListener("click", () => state.map?.fit());
  window.addEventListener("resize", () => {
    if (state.mode === "map") positionMap();
  });

  const clearPlan = () => {
    state.pre.release([...state.pre.locked], criteriaMatches());
    savePlan();
    render();
  };
  el("via-clear").addEventListener("click", clearPlan);
  el("clear-plan").addEventListener("click", clearPlan);

  wireWhere();
}

/* ------------------------------------------------------- base and here -- */

/** The base as the engine sees it, or null. */
function baseOrigin() {
  const base = state.base;
  return base ? { id: position.BASE_ID, name: `base (${base.name})`, lat: base.lat, lon: base.lon } : null;
}

/** Where you were at the last fix, or null. */
function hereOrigin() {
  const here = state.here;
  return here ? { id: position.HERE_ID, name: "where you are", lat: here.lat, lon: here.lon } : null;
}

/** Road costs changed: routes solved before are no longer right. */
function travelChanged() {
  state.travelVersion += 1;
}

function gardensWithCoordinates() {
  return state.bundle.places.filter((place) => place.lat != null && place.lon != null);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Measure road distances between the base and every garden, both ways, once.
 * Kept with the base on this device; without them, estimates stand in.
 */
async function measureBase() {
  const base = state.base;
  if (!base) return false;
  const gardens = gardensWithCoordinates();
  const point = { lat: base.lat, lon: base.lon };
  try {
    const [out, back] = await Promise.all([
      fetchJson(position.roadTableUrl(point, gardens, "to")),
      fetchJson(position.roadTableUrl(point, gardens, "from")),
    ]);
    const to = position.roadTableRows(out, gardens, "to");
    const from = position.roadTableRows(back, gardens, "from");
    if (!Object.keys(to).length || state.base !== base) return false;
    base.travel = { to, from };
    base.measuredAt = new Date().toISOString();
    writeStore(STORE_BASE, base);
    state.model.setPersonal(position.BASE_ID, base.travel);
    travelChanged();
    // Here's costs to the base were measured against the old one, if any.
    if (state.here) measureHere();
    render();
    return true;
  } catch {
    return false;
  }
}

/** Measure from where you are to every garden and the base. Online only; estimates otherwise. */
async function measureHere() {
  const here = state.here;
  if (!here) return false;
  const targets = gardensWithCoordinates();
  const base = baseOrigin();
  if (base) targets.push(base);
  try {
    const json = await fetchJson(position.roadTableUrl({ lat: here.lat, lon: here.lon }, targets, "to"));
    const to = position.roadTableRows(json, targets, "to");
    if (!Object.keys(to).length || state.here !== here) return false;
    here.travel = { to };
    writeStore(STORE_HERE, here);
    state.model.setPersonal(position.HERE_ID, here.travel);
    travelChanged();
    render();
    return true;
  } catch {
    return false;
  }
}

/** One GPS fix. Not tracking: taken when asked, or when the app is opened again. */
function refreshHere({ quiet = false } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      if (!quiet) el("status").textContent = "This browser has no location support.";
      return resolve(false);
    }
    el("here-label").textContent = "Finding…";
    navigator.geolocation.getCurrentPosition(
      (fix) => {
        state.here = {
          lat: fix.coords.latitude,
          lon: fix.coords.longitude,
          accuracy: Math.round(fix.coords.accuracy),
          at: new Date().toISOString(),
        };
        writeStore(STORE_HERE, state.here);
        state.model.setPersonal(position.HERE_ID, {});
        travelChanged();
        render();
        measureHere();
        resolve(true);
      },
      () => {
        updateWhere();
        if (!quiet) {
          el("status").textContent = "Location refused or unavailable. It needs permission and a secure (https) connection.";
        }
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  });
}

/** On opening the app again, a stale fix is refreshed if location is already allowed. */
async function refreshHereIfAllowed() {
  if (!state.here || !position.isStale(state.here)) return;
  try {
    const permission = await navigator.permissions?.query({ name: "geolocation" });
    if (permission?.state === "granted") refreshHere({ quiet: true });
  } catch {
    /* No permissions API: wait to be asked. */
  }
}

/** The two header buttons say what they hold. */
function updateWhere() {
  el("base-label").textContent = state.base ? state.base.name : "Set base";
  el("here-label").textContent = state.here ? position.ageText(state.here.at) : "Here";
  el("here-button").classList.toggle("is-set", Boolean(state.here));
  el("base-button").classList.toggle("is-set", Boolean(state.base));
  // "Here (4 min ago)" in the Starting from list ages too.
  const hereOption = el("origin").querySelector('option[value="@here"]');
  if (hereOption) {
    hereOption.textContent = state.here ? `Here (${position.ageText(state.here.at)})` : "Here (press Here first)";
  }
}

function mapMarkers() {
  const markers = [];
  if (state.base) markers.push({ kind: "base", ...state.base });
  if (state.here) markers.push({ kind: "here", ...state.here });
  return markers;
}

function describeMarker(marker) {
  if (marker.kind === "base") {
    const measured = marker.travel ? "road distances measured" : "road distances estimated";
    return `
      <div class="map-popup-nr">B · your base</div>
      <div class="map-popup-name">${escapeHtml(marker.name)}</div>
      ${marker.address ? `<div class="map-popup-address">${escapeHtml(marker.address)}</div>` : ""}
      <div class="map-popup-meta">${measured}</div>`;
  }
  const km = state.base ? state.model.from(hereOrigin(), baseOrigin()) : null;
  return `
    <div class="map-popup-nr">You were here</div>
    <div class="map-popup-name">${escapeHtml(position.ageText(marker.at))}</div>
    <div class="map-popup-meta">to within about ${marker.accuracy ?? "?"} m${
      km ? ` · ${km.roadKm.toFixed(1)} km to base` : ""
    }</div>`;
}

/* The base dialog: an address, a GPS fix at the base, or coordinates. */

let pendingBase = null;

function setPendingBase(candidate, message) {
  pendingBase = candidate;
  el("base-save").disabled = !candidate;
  el("base-status").textContent = message || "";
}

function openBaseDialog() {
  const base = state.base;
  el("base-current").hidden = !base;
  if (base) {
    el("base-current").innerHTML = `Current base: <strong>${escapeHtml(base.name)}</strong> · ${
      base.travel
        ? "road distances measured"
        : 'road distances estimated <button type="button" id="base-measure" class="link">Measure now</button>'
    }`;
  }
  el("base-address").value = base?.address || "";
  el("base-results").innerHTML = "";
  el("base-lat").value = "";
  el("base-lon").value = "";
  el("base-clear").hidden = !base;
  setPendingBase(null);
  el("base-dialog").showModal();
}

async function lookUpAddress() {
  const address = el("base-address").value.trim();
  if (address.length < 4) {
    setPendingBase(null, "Type a little more of the address.");
    return;
  }
  setPendingBase(null, "Looking it up…");
  el("base-results").innerHTML = "";
  try {
    const candidates = position.addressCandidates(await fetchJson(position.addressSearchUrl(address)));
    if (!candidates.length) {
      setPendingBase(null, "No match. Try the street and town only, or use your location when you are there.");
      return;
    }
    el("base-results").innerHTML = candidates
      .map((c, i) => `<li><button type="button" data-candidate="${i}">${escapeHtml(c.label)}</button></li>`)
      .join("");
    el("base-results")._candidates = candidates;
    setPendingBase(null, candidates.length === 1 ? "One match. Tap it to choose it." : "Tap the right one.");
  } catch {
    setPendingBase(null, "The address service could not be reached. Try again, or use your location when you are there.");
  }
}

/** Save the chosen base, then show it on the map to confirm, and measure it. */
function saveBase() {
  if (!pendingBase) return;
  state.base = {
    name: pendingBase.name,
    address: pendingBase.label || null,
    lat: pendingBase.lat,
    lon: pendingBase.lon,
    source: pendingBase.source,
    savedAt: new Date().toISOString(),
  };
  writeStore(STORE_BASE, state.base);
  state.model.setPersonal(position.BASE_ID, {});
  travelChanged();
  el("base-dialog").close();
  fillPlaceSelect(el("origin"), { includeBase: true, includeHere: true });
  fillPlaceSelect(el("destination"), { includeBase: true });
  el("origin").value = "@base";
  saveView();
  startPlacingBase();
}

/** On the map, B where the lookup put it; a tap moves it. Measured when done. */
function startPlacingBase() {
  document.querySelector('[data-mode="map"]').click();
  el("map-base-hint").hidden = false;
  el("map-base-text").innerHTML = "Is <strong>B</strong> in the right place? Tap where your base is to move it.";
  state.map.setPicking((lat, lon) => {
    state.base.lat = lat;
    state.base.lon = lon;
    state.base.source = "map";
    delete state.base.travel;
    writeStore(STORE_BASE, state.base);
    state.model.setPersonal(position.BASE_ID, {});
    travelChanged();
    el("map-base-text").innerHTML = "<strong>B</strong> moved. Tap again to adjust, or press Done.";
    render();
  });
  state.map.centreOn(state.base.lat, state.base.lon, 60);
  render();
}

async function finishPlacingBase() {
  if (el("map-base-hint").hidden) return;
  state.map?.setPicking(null);
  el("map-base-hint").hidden = true;
  if (state.base && !state.base.travel) {
    el("status").textContent = "Measuring road distances to your base…";
    const ok = await measureBase();
    el("status").textContent = ok
      ? `Road distances from ${state.base.name} to every garden measured.`
      : "The routing service could not be reached; distances to your base are estimates for now.";
  }
}

function wireWhere() {
  el("base-button").addEventListener("click", openBaseDialog);
  el("plan-set-start").addEventListener("click", openBaseDialog);
  el("base-lookup").addEventListener("click", lookUpAddress);
  // Enter in the address box looks it up rather than closing the dialog.
  el("base-address").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      lookUpAddress();
    }
  });
  el("base-results").addEventListener("click", (event) => {
    const button = event.target.closest("[data-candidate]");
    if (!button) return;
    const candidate = el("base-results")._candidates[Number(button.dataset.candidate)];
    el("base-results").querySelectorAll("button").forEach((b) => b.classList.toggle("is-on", b === button));
    setPendingBase({ ...candidate, source: "address" }, "Press Save, then check B on the map.");
  });
  el("use-gps").addEventListener("click", () => {
    if (!navigator.geolocation) return setPendingBase(null, "This browser has no location support.");
    setPendingBase(null, "Finding you…");
    navigator.geolocation.getCurrentPosition(
      (fix) =>
        setPendingBase(
          { name: "My base", lat: fix.coords.latitude, lon: fix.coords.longitude, source: "gps" },
          `Found, to within about ${Math.round(fix.coords.accuracy)} m. Press Save.`
        ),
      () => setPendingBase(null, "Location refused or unavailable."),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
  for (const id of ["base-lat", "base-lon"]) {
    el(id).addEventListener("input", () => {
      const point = position.parseCoordinates(el("base-lat").value, el("base-lon").value);
      setPendingBase(
        point ? { name: "My base", ...point, source: "coordinates" } : null,
        point ? "Press Save." : "Latitude and longitude in New Zealand, such as -39.06 and 174.07."
      );
    });
  }
  el("base-save").addEventListener("click", saveBase);
  el("base-current").addEventListener("click", async (event) => {
    if (!event.target.closest("#base-measure")) return;
    el("base-status").textContent = "Measuring…";
    const ok = await measureBase();
    el("base-status").textContent = ok ? "Measured." : "The routing service could not be reached. Try again later.";
    if (ok) openBaseDialog();
  });
  el("base-clear").addEventListener("click", () => {
    state.base = null;
    try {
      localStorage.removeItem(STORE_BASE);
    } catch {
      /* Nothing stored to remove. */
    }
    state.model.setPersonal(position.BASE_ID, {});
    travelChanged();
    el("base-dialog").close();
    fillPlaceSelect(el("origin"), { includeBase: true, includeHere: true });
    fillPlaceSelect(el("destination"), { includeBase: true });
    render();
  });
  el("map-base-done").addEventListener("click", finishPlacingBase);

  el("here-button").addEventListener("click", async () => {
    const ok = await refreshHere();
    if (ok && state.mode === "map") state.map?.centreOn(state.here.lat, state.here.lon, 30);
  });
  el("replan-here").addEventListener("click", async () => {
    if (await refreshHere()) {
      el("origin").value = "@here";
      saveView();
      render();
    }
  });
  el("head-base").addEventListener("click", () => {
    // No start given: Google Maps starts from the phone's live position.
    if (state.base) openInMaps(null, [], baseOrigin());
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshHereIfAllowed();
  });
}

// Registering the worker is what makes the app installable and offline-capable.
// It needs https (or localhost); it simply does not register elsewhere.
const BUILD = document.querySelector('meta[name="build"]')?.content || "dev";
if ("serviceWorker" in navigator) {
  if (BUILD === "dev") {
    // Working copy: always the files on disk. An offline cache here would keep
    // serving yesterday's code, because only published builds change its name.
    navigator.serviceWorker.getRegistrations().then((all) => all.forEach((r) => r.unregister()));
    caches?.keys().then((keys) => keys.filter((k) => k.startsWith("tgo-")).forEach((k) => caches.delete(k)));
  } else {
    // A new version takes over as soon as it has installed. Reload once when it
    // does, so the screen shows the new code rather than waiting for next time.
    // Not on a first visit, when there was no old version to replace.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {
        /* Offline support is a bonus, not a requirement for the page to work. */
      });
    });
  }
}

load()
  .then(() => {
    fillPlaceSelect(el("origin"), { includeBase: true, includeHere: true });
    fillPlaceSelect(el("destination"), { includeBase: true });
    fillAreaSelect();
    fillOpenOnSelect();
    wire();
    restoreView();
    setPane("gardens");
    render();
    // A base saved while offline, or before measuring existed, is measured now.
    if (state.base && !state.base.travel && navigator.onLine) measureBase();
    refreshHereIfAllowed();
  })
  .catch((error) => {
    el("status").textContent = `${error.message}. Serve this directory over http rather than opening the file directly.`;
  });
