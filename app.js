/**
 * Interface for the Taranaki Garden Optimiser.
 *
 * All query logic lives in engine.js, which is a port of the Python and is held
 * to it by tests/test_parity.py. This file only reads controls, calls the
 * engine, and draws the answer.
 *
 * Two things are deliberately kept out of the published bundle and held only in
 * this browser: the start point, and what the user has visited or rated. The
 * bundle is read-only reference data that everyone shares; personal state is
 * nobody else's business and never leaves the device.
 */

import * as engine from "./engine.js";
import { toCsv, fromCsv } from "./notes.js";

const STORE_BASE = "tgo.base.v1";
const STORE_VISITS = "tgo.visits.v1";
const STORE_PLAN = "tgo.plan.v1";

const el = (id) => document.getElementById(id);
const state = {
  bundle: null,
  model: null,
  byId: new Map(),
  base: null,
  visits: new Map(),
  plan: [],
  mode: "nearest",
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

async function load() {
  const response = await fetch("data/bundle.json");
  if (!response.ok) throw new Error(`Could not load data (${response.status})`);
  state.bundle = await response.json();
  state.model = new engine.TravelModel(state.bundle);
  state.byId = new Map(state.bundle.places.map((p) => [p.id, p]));
  state.base = readStore(STORE_BASE, null);
  state.visits = new Map(Object.entries(readStore(STORE_VISITS, {})));
  state.plan = readStore(STORE_PLAN, []).filter((id) => state.byId.has(id));
}

function sortedPlaces() {
  return [...state.bundle.places].sort((a, b) => a.name.localeCompare(b.name));
}

function fillPlaceSelect(select, { includeBase = false } = {}) {
  select.innerHTML = "";
  if (includeBase) {
    const option = document.createElement("option");
    option.value = "@base";
    option.textContent = state.base ? `${state.base.name} (your start)` : "Set a start point first";
    select.append(option);
  }
  for (const place of sortedPlaces()) {
    const option = document.createElement("option");
    option.value = place.id;
    option.textContent = place.name;
    select.append(option);
  }
}

/** The origin the engine works with: either a known place or the private base. */
function originFrom(select) {
  if (select.value === "@base") {
    if (!state.base) return null;
    return { id: null, name: state.base.name, lat: state.base.lat, lon: state.base.lon };
  }
  return state.byId.get(select.value) || null;
}

function currentFilters() {
  const maxKm = Number(el("max-km").value);
  return {
    festival: el("festival").value,
    entryType: el("entry-type").value,
    anchorClass: el("anchor").value || null,
    includeVisited: !el("hide-visited").checked,
    maxKm: maxKm > 0 ? maxKm : null,
    requireAmenities: [...document.querySelectorAll("[data-amenity]")]
      .filter((box) => box.checked)
      .map((box) => box.dataset.amenity),
  };
}

function visitOf(id) {
  return state.visits.get(id) || {};
}

function setVisit(id, patch) {
  const next = { ...visitOf(id), ...patch };
  state.visits.set(id, next);
  writeStore(STORE_VISITS, Object.fromEntries(state.visits));
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

function mapsLink(place) {
  return `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lon}`;
}

function resultRow(row, index) {
  const place = row.place;
  const visit = visitOf(place.id);
  const item = document.createElement("li");
  item.className = "result";
  if (visit.visited) item.classList.add("is-visited");

  const primary =
    row.detourKm != null
      ? `<span class="metric">+${row.detourKm.toFixed(1)} km</span><span class="sub">${row.estimate.roadKm.toFixed(0)} out · ${row.onward.roadKm.toFixed(0)} on</span>`
      : `<span class="metric">${row.estimate.roadKm.toFixed(1)} km</span><span class="sub">${Math.round(row.estimate.minutes)} min</span>`;

  const festival = place.festivals.length > 1 ? "both" : (place.festivals[0] || "").toLowerCase();
  const inPlan = state.plan.includes(place.id);
  const rating = visit.interest ?? place.interest ?? "";
  const options = ["", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    .map((value) => {
      const label = value === "" ? "rate" : value;
      return `<option value="${value}"${String(value) === String(rating) ? " selected" : ""}>${label}</option>`;
    })
    .join("");
  const score = row.score != null ? `<span class="score">${row.score.toFixed(2)}</span>` : "";

  item.innerHTML = `
    <div class="rank">${index + 1}</div>
    <div class="figure">${primary}</div>
    <div class="body">
      <div class="name">${place.name} ${score}</div>
      <div class="meta">
        <span class="tag tag-${festival}">${festival}</span>
        ${place.anchor === "Daily anchor" ? '<span class="tag tag-anchor">major</span>' : ""}
        <span class="badges">${amenityBadges(place)}</span>
        <span class="region">${place.region}</span>
        <select class="rate${rating === "" ? "" : " is-rated"}" data-rate="${place.id}"
          title="How interesting is this garden, 1 to 10?">${options}</select>
      </div>
    </div>
    <div class="actions">
      <button type="button" class="${inPlan ? "is-on" : ""}" data-add="${place.id}"
        title="${inPlan ? "Remove from today's plan" : "Add to today's plan"}">${inPlan ? "✓ Plan" : "+ Plan"}</button>
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

  const origin = originFrom(el("origin"));
  if (!origin) {
    status.textContent = "Set a start point to begin.";
    return;
  }

  const count = Number(el("count").value);
  const filters = currentFilters();
  let rows = [];

  if (state.mode === "nearest") {
    rows = engine.nearest(state.bundle.places, origin, count, state.model, filters, state.visits);
  } else if (state.mode === "recommend") {
    rows = engine.recommend(state.bundle.places, origin, count, state.model, filters, state.visits);
  } else if (state.mode === "via") {
    const destination = originFrom(el("destination"));
    if (!destination) {
      status.textContent = "Choose where you are heading.";
      return;
    }
    rows = engine.onTheWay(
      state.bundle.places, origin, destination, count, state.model, filters, state.visits, null
    );
  }

  if (state.mode !== "route") {
    if (!rows.length) {
      status.textContent = "Nothing matched those filters.";
    } else {
      const source = rows[0].estimate.source;
      status.textContent = `${rows.length} shown · ${source}`;
    }
    rows.forEach((row, index) => results.append(resultRow(row, index)));
  } else {
    status.textContent = state.plan.length
      ? ""
      : "Add gardens from any other tab, then come back here.";
  }

  renderPlan(origin);
  el("provenance").textContent =
    `${state.bundle.places.length} destinations · road costs baked ${(state.bundle.generatedAt || "").slice(0, 10)}`;
}

function renderPlan(origin) {
  const panel = el("plan");
  const list = el("plan-list");
  const summary = el("plan-summary");
  panel.hidden = state.mode !== "route";
  if (state.mode !== "route") return;

  list.innerHTML = "";
  if (!state.plan.length) {
    summary.textContent = "";
    el("navigate").hidden = true;
    return;
  }

  const chosen = state.plan.map((id) => state.byId.get(id));
  const route = engine.buildRoute(chosen, origin, state.model, el("return-home").checked);

  route.legs.forEach((leg, index) => {
    const drive = document.createElement("li");
    drive.className = "leg";
    drive.innerHTML = `<span class="drive">${leg.estimate.roadKm.toFixed(1)} km · ${Math.round(leg.estimate.minutes)} min</span> <span class="to">${leg.to}</span>`;
    list.append(drive);
    const place = route.places[index];
    if (place) {
      const stop = document.createElement("li");
      stop.className = "stop";
      stop.innerHTML = `
        <span class="stay">${place.minutes ?? engine.DEFAULT_VISIT_MINUTES} min${place.minutes == null ? " (assumed)" : ""}</span>
        <span class="to">${place.name}</span>
        <button type="button" class="link" data-remove="${place.id}">remove</button>`;
      list.append(stop);
    }
  });

  const hours = (route.totalMinutes / 60).toFixed(1);
  summary.textContent =
    `${route.places.length} stops · ${route.totalKm.toFixed(1)} km · ${Math.round(route.travelMinutes)} min driving · ${hours} hours all up`;
  el("navigate").hidden = false;
  el("navigate").onclick = () => {
    // The app plans; the phone navigates. Hand the ordered stops to Google Maps.
    const points = route.places.map((p) => `${p.lat},${p.lon}`);
    const destination = el("return-home").checked && state.base
      ? `${state.base.lat},${state.base.lon}`
      : points.pop();
    const url = new URL("https://www.google.com/maps/dir/");
    url.searchParams.set("api", "1");
    url.searchParams.set("origin", `${origin.lat},${origin.lon}`);
    url.searchParams.set("destination", destination);
    if (points.length) url.searchParams.set("waypoints", points.join("|"));
    window.open(url.toString(), "_blank", "noopener");
  };
}

function togglePlan(id) {
  const index = state.plan.indexOf(id);
  if (index >= 0) state.plan.splice(index, 1);
  else state.plan.push(id);
  writeStore(STORE_PLAN, state.plan);
  render();
}

function wire() {
  document.querySelectorAll(".mode").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".mode").forEach((b) => b.classList.remove("is-active"));
      button.classList.add("is-active");
      state.mode = button.dataset.mode;
      el("destination-field").hidden = state.mode !== "via";
      render();
    });
  });

  ["origin", "destination", "count", "festival", "entry-type", "anchor", "hide-visited", "return-home"]
    .forEach((id) => el(id).addEventListener("change", render));
  document.querySelectorAll("[data-amenity]").forEach((box) => box.addEventListener("change", render));

  el("max-km").addEventListener("input", () => {
    const value = Number(el("max-km").value);
    el("max-km-value").textContent = value > 0 ? `${value} km` : "no limit";
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
    else if (target.dataset.visited) {
      const id = target.dataset.visited;
      const now = visitOf(id).visited;
      setVisit(id, { visited: !now, visitedOn: now ? null : new Date().toISOString().slice(0, 10) });
      render();
    }
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

  el("clear-plan").addEventListener("click", () => {
    state.plan = [];
    writeStore(STORE_PLAN, state.plan);
    render();
  });

  el("base-button").addEventListener("click", () => {
    fillPlaceSelect(el("base-place"));
    el("base-status").textContent = "";
    el("base-dialog").showModal();
  });

  el("use-gps").addEventListener("click", () => {
    if (!navigator.geolocation) {
      el("base-status").textContent = "This browser has no location support.";
      return;
    }
    el("base-status").textContent = "Finding you…";
    navigator.geolocation.getCurrentPosition(
      (position) => {
        el("base-lat").value = position.coords.latitude.toFixed(6);
        el("base-lon").value = position.coords.longitude.toFixed(6);
        el("base-status").textContent = "Got it. Press Save.";
      },
      () => {
        el("base-status").textContent =
          "Location refused or unavailable. Location needs a secure (https) connection.";
      }
    );
  });

  el("base-save").addEventListener("click", () => {
    const lat = Number(el("base-lat").value);
    const lon = Number(el("base-lon").value);
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0) {
      state.base = { name: "My start", lat, lon };
    } else {
      const place = state.byId.get(el("base-place").value);
      if (place) state.base = { name: place.name, lat: place.lat, lon: place.lon };
    }
    if (state.base) {
      writeStore(STORE_BASE, state.base);
      el("base-button").textContent = state.base.name;
      fillPlaceSelect(el("origin"), { includeBase: true });
      fillPlaceSelect(el("destination"), { includeBase: true });
      render();
    }
  });
}

// Registering the worker is what makes the app installable and offline-capable.
// It needs https (or localhost); it simply does not register elsewhere.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* Offline support is a bonus, not a requirement for the page to work. */
    });
  });
}

load()
  .then(() => {
    fillPlaceSelect(el("origin"), { includeBase: true });
    fillPlaceSelect(el("destination"), { includeBase: true });
    if (state.base) el("base-button").textContent = state.base.name;
    wire();
    render();
  })
  .catch((error) => {
    el("status").textContent = `${error.message}. Serve this directory over http rather than opening the file directly.`;
  });
