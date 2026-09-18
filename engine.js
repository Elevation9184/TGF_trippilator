/**
 * Query engine for the Taranaki Garden Optimiser field app.
 *
 * A deliberate port of src/query.py, src/routing.py and src/distances.py, kept
 * function-for-function so the two can be diffed by eye and checked by the
 * parity harness in tests/test_parity.py. If you change a rule here, change it
 * there, and the harness will tell you if you did not.
 *
 * Everything decided lives in Python: canonical places, geocoding, the baked
 * road matrix. This file only does arithmetic over the result, which is the
 * part that is hard to get subtly wrong.
 *
 * No dependencies and no build step, so the published directory can be served
 * as-is and cached offline.
 */

export const EARTH_RADIUS_KM = 6371.0088;

// Mirrors src/distances.py. Fitted against 6,628 measured road pairs.
export const ROAD_DETOUR_FACTOR = 1.323;
export const DEFAULT_SPEED_KMH = 66.0;

// Mirrors src/query.py.
export const DISTANCE_WEIGHT = 0.65;
export const INTEREST_WEIGHT = 0.35;
export const PROXIMITY_HALF_LIFE_KM = 10.0;
export const NEUTRAL_INTEREST = 5.0;
export const MIN_INTEREST = 1.0;
export const MAX_INTEREST = 10.0;
export const DEFAULT_VISIT_MINUTES = 45.0;

// Ordering for "on the way". Cheapest answers "is it worth stopping?";
// route order answers "when will I reach it?", which is what you want once
// the detour budget has already decided the shortlist.
export const BY_DETOUR = "detour";
export const BY_ROUTE = "route";

export const BOTH = "Both";
export const ALL = "All";

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Strip macrons so "tupare" finds "Tūpare" on a phone keyboard. */
export function fold(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Travel costs over the baked matrix, with a geometry fallback.
 *
 * The published bundle contains no start points, so a personal base is never in
 * the matrix. Rather than fall back to geometry for the longest legs of the
 * day, an off-matrix position is snapped to the nearest known destination and
 * costed as: short geometric hop to that destination, plus its measured row.
 * A house is almost always within a kilometre of some garden, so the residual
 * error is far smaller than the ten percent the pure geometry model carries.
 */
export class TravelModel {
  constructor(bundle) {
    this.places = bundle.places;
    this.travel = bundle.travel || {};
    this.byId = new Map(bundle.places.map((p) => [p.id, p]));
  }

  lookup(fromId, toId) {
    const row = this.travel[fromId];
    return row ? row[toId] : undefined;
  }

  geometry(lat1, lon1, lat2, lon2) {
    const straight = haversineKm(lat1, lon1, lat2, lon2);
    const road = straight * ROAD_DETOUR_FACTOR;
    return {
      straightKm: straight,
      roadKm: road,
      minutes: (60 * road) / DEFAULT_SPEED_KMH,
      source: "geometry",
    };
  }

  /** Nearest known destination to a raw position, by straight line. */
  snap(lat, lon) {
    let best = null;
    let bestKm = Infinity;
    for (const place of this.places) {
      if (place.lat == null || place.lon == null) continue;
      const km = haversineKm(lat, lon, place.lat, place.lon);
      if (km < bestKm || (km === bestKm && best && place.id < best.id)) {
        best = place;
        bestKm = km;
      }
    }
    return best ? { place: best, km: bestKm } : null;
  }

  /**
   * Measured costs for a personal point, such as a base or where you are now:
   * `to` maps each garden (or other point) it reaches, `from` each that reaches
   * it. Held in memory on this device only; any earlier costs for the id go.
   */
  setPersonal(id, { to = {}, from = {} } = {}) {
    delete this.travel[id];
    for (const row of Object.values(this.travel)) delete row[id];
    if (Object.keys(to).length) this.travel[id] = { ...to };
    for (const [placeId, cost] of Object.entries(from)) {
      (this.travel[placeId] ||= {})[id] = cost;
    }
  }

  /** A point with measured costs of its own: a garden, or a measured personal point. */
  measured(point) {
    return Boolean(point.id && this.travel[point.id]);
  }

  /**
   * Cost between two points, either of which may be a known place or a raw position.
   *
   * Measured where a cost exists. Otherwise an end with no costs of its own is
   * moved to its nearest garden with a short geometric hop, at either end: a
   * return to an unmeasured base used to fall back to straight-line geometry.
   */
  from(origin, destination) {
    const straightKm = haversineKm(origin.lat, origin.lon, destination.lat, destination.lon);
    if (origin.id && origin.id === destination.id) {
      return { straightKm: 0, roadKm: 0, minutes: 0, source: "same place" };
    }
    const entry = origin.id && destination.id ? this.lookup(origin.id, destination.id) : undefined;
    if (entry) return { straightKm, roadKm: entry.km, minutes: entry.minutes, source: "road matrix" };

    const start = this.measured(origin) ? null : this.snap(origin.lat, origin.lon);
    const end = this.measured(destination) ? null : this.snap(destination.lat, destination.lon);
    const from = start ? start.place : origin;
    const to = end ? end.place : destination;
    if (from.id === to.id) {
      const hop = this.geometry(origin.lat, origin.lon, destination.lat, destination.lon);
      return start ? { ...hop, source: "geometry (you are here)" } : hop;
    }
    const middle = this.lookup(from.id, to.id);
    if (!middle) return this.geometry(origin.lat, origin.lon, destination.lat, destination.lon);

    const none = { roadKm: 0, minutes: 0 };
    const first = start ? this.geometry(origin.lat, origin.lon, from.lat, from.lon) : none;
    const last = end ? this.geometry(to.lat, to.lon, destination.lat, destination.lon) : none;
    const via = [start?.place.name, end?.place.name].filter(Boolean).join(" and ");
    return {
      straightKm,
      roadKm: first.roadKm + middle.km + last.roadKm,
      minutes: first.minutes + middle.minutes + last.minutes,
      source: `road matrix via ${via}`,
      snappedTo: (start || end).place.name,
      snapKm: (start || end).km,
    };
  }

  between(a, b) {
    return this.from(a, b);
  }
}

export const defaultFilters = () => ({
  festival: BOTH,
  entryType: ALL,
  anchorClass: null,
  mustVisitOnly: false,
  minInterest: null,
  includeVisited: false,
  includeExcluded: false,
  maxKm: null,
  requireAmenities: [],
});

/**
 * Hard eligibility rules, applied before any ordering.
 *
 * Amenities are a deliberate exception: 36 of 81 places have never had them
 * harvested, so "Unknown" means unrecorded, not absent. Requiring one keeps
 * Unknown rather than excluding it, because hiding half the festival behind a
 * gap in the data would be worse than showing a maybe.
 */
export function eligible(places, filters, state) {
  const f = { ...defaultFilters(), ...filters };
  return places.filter((place) => {
    if (place.lat == null || place.lon == null) return false;
    const visit = state?.get(place.id) || {};
    if (!f.includeExcluded && visit.excluded) return false;
    if (!f.includeVisited && visit.visited) return false;
    if (f.festival !== BOTH && !place.festivals.includes(f.festival)) return false;
    if (f.entryType !== ALL && place.type !== f.entryType) return false;
    if (f.anchorClass && place.anchor !== f.anchorClass) return false;
    // A stored "No" is a non-empty string, so this must compare, not test truthiness.
    if (f.mustVisitOnly && (visit.mustVisit ?? place.mustVisit) !== "Yes") return false;
    // An unrated garden cannot meet a minimum rating.
    if (f.minInterest != null) {
      const rating = interestOf(place, state);
      if (rating == null || rating < f.minInterest) return false;
    }
    for (const amenity of f.requireAmenities) {
      if (place.amenities?.[amenity] === "No") return false;
    }
    return true;
  });
}

function interestOf(place, state) {
  const visit = state?.get(place.id) || {};
  const value = visit.interest ?? place.interest;
  return value == null ? null : Number(value);
}

export function effectiveInterest(place, state) {
  const value = interestOf(place, state);
  return value == null ? NEUTRAL_INTEREST : value;
}

function measure(places, origin, model, filters, state) {
  const f = { ...defaultFilters(), ...filters };
  const rows = [];
  for (const place of eligible(places, f, state)) {
    if (place.id === origin.id) continue;
    const estimate = model.from(origin, place);
    if (f.maxKm != null && estimate.roadKm > f.maxKm) continue;
    rows.push({ place, estimate });
  }
  return rows;
}

/** Strict nearest. Interest never changes this order. */
export function nearest(places, origin, count, model, filters, state) {
  const rows = measure(places, origin, model, filters, state);
  rows.sort((a, b) => a.estimate.roadKm - b.estimate.roadKm || (a.place.id < b.place.id ? -1 : 1));
  return rows.slice(0, Math.max(0, count));
}

export function proximity(km, halfLifeKm = PROXIMITY_HALF_LIFE_KM) {
  return Math.pow(0.5, km / halfLifeKm);
}

/** Weighted blend of proximity and interest, with both components exposed. */
export function recommend(places, origin, count, model, filters, state, weights = {}) {
  const distanceWeight = weights.distance ?? DISTANCE_WEIGHT;
  const interestWeight = weights.interest ?? INTEREST_WEIGHT;
  const rows = measure(places, origin, model, filters, state);
  for (const row of rows) {
    const interest = effectiveInterest(row.place, state);
    row.proximity = proximity(row.estimate.roadKm);
    row.interestComponent = (interest - MIN_INTEREST) / (MAX_INTEREST - MIN_INTEREST);
    row.score = distanceWeight * row.proximity + interestWeight * row.interestComponent;
    row.assumedInterest = interestOf(row.place, state) == null;
  }
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      a.estimate.roadKm - b.estimate.roadKm ||
      (a.place.id < b.place.id ? -1 : 1)
  );
  return rows.slice(0, Math.max(0, count));
}

/**
 * What costs least to collect between here and where you are going.
 *
 * Not a nearest search. A place can be close and still be the wrong way: the
 * measure is the extra distance a stop adds to the journey you were making
 * anyway.
 */
export function onTheWay(places, origin, destination, count, model, filters, state, maxDetourKm, order = BY_DETOUR) {
  const baseline = model.from(origin, destination);
  const rows = [];
  for (const place of eligible(places, filters, state)) {
    if (place.id === origin.id || place.id === destination.id) continue;
    const outbound = model.from(origin, place);
    const onward = model.from(place, destination);
    const detourKm = outbound.roadKm + onward.roadKm - baseline.roadKm;
    if (maxDetourKm != null && detourKm > maxDetourKm) continue;
    rows.push({
      place,
      estimate: outbound,
      onward,
      detourKm,
      detourMinutes: outbound.minutes + onward.minutes - baseline.minutes,
    });
  }
  rows.sort((a, b) => a.detourKm - b.detourKm || (a.place.id < b.place.id ? -1 : 1));
  const chosen = rows.slice(0, Math.max(0, count));
  if (order === BY_ROUTE) {
    // Still the cheapest `count`, but shown in the order they are passed.
    chosen.sort((a, b) => a.estimate.roadKm - b.estimate.roadKm || (a.place.id < b.place.id ? -1 : 1));
  }
  return chosen;
}

// Largest number of stops ordered exactly. Mirrored in src/routing.py.
export const EXACT_LIMIT = 15;

/**
 * The provably cheapest order of n stops, by Held-Karp dynamic programming.
 *
 * Minimises first[o0] + step[o0][o1] + ... + last[o(n-1)], which covers a loop
 * home, a run to a fixed destination, and a day with no start point. Iteration
 * order and strict comparisons match exact_order in src/routing.py, so both
 * choose the same order even between equal-cost ties.
 *
 * Nearest-neighbour and 2-opt alone matched the true optimum in only 89-94% of
 * 600 sampled trips and missed by up to 20 km. At fifteen stops this takes
 * about 16 ms on a laptop and 3.8 MB; each extra stop doubles both.
 */
export function exactOrder(n, first, step, last) {
  if (n === 0) return [];
  const size = 1 << n;
  const cost = new Float64Array(size * n).fill(Infinity);
  const parent = new Int8Array(size * n).fill(-1);
  for (let i = 0; i < n; i += 1) cost[(1 << i) * n + i] = first[i];
  for (let mask = 1; mask < size; mask += 1) {
    for (let j = 0; j < n; j += 1) {
      if (!(mask & (1 << j))) continue;
      const here = cost[mask * n + j];
      if (here === Infinity) continue;
      const row = step[j];
      for (let k = 0; k < n; k += 1) {
        if (mask & (1 << k)) continue;
        const index = (mask | (1 << k)) * n + k;
        const value = here + row[k];
        if (value < cost[index]) {
          cost[index] = value;
          parent[index] = j;
        }
      }
    }
  }
  const full = size - 1;
  let best = Infinity;
  let bestLast = -1;
  for (let j = 0; j < n; j += 1) {
    const value = cost[full * n + j] + last[j];
    if (value < best) {
      best = value;
      bestLast = j;
    }
  }
  const order = [];
  let mask = full;
  let j = bestLast;
  while (j !== -1) {
    order.push(j);
    const previous = parent[mask * n + j];
    mask ^= 1 << j;
    j = previous;
  }
  return order.reverse();
}

function orderCost(order, first, step, last) {
  if (!order.length) return 0;
  let total = first[order[0]] + last[order[order.length - 1]];
  for (let i = 0; i < order.length - 1; i += 1) total += step[order[i]][order[i + 1]];
  return total;
}

export function nearestNeighbourOrder(n, first, step) {
  const remaining = Array.from({ length: n }, (_, i) => i);
  const order = [];
  let current = -1;
  while (remaining.length) {
    // Lowest index wins a tie; indices follow place id, so this is reproducible.
    let chosen = remaining[0];
    let chosenCost = current < 0 ? first[chosen] : step[current][chosen];
    for (const k of remaining) {
      const value = current < 0 ? first[k] : step[current][k];
      if (value < chosenCost || (value === chosenCost && k < chosen)) {
        chosen = k;
        chosenCost = value;
      }
    }
    order.push(chosen);
    remaining.splice(remaining.indexOf(chosen), 1);
    current = chosen;
  }
  return order;
}

function twoOptOrder(order, first, step, last) {
  let best = [...order];
  let bestCost = orderCost(best, first, step, last);
  let improved = true;
  while (improved && best.length > 2) {
    improved = false;
    let candidate = null;
    let candidateCost = bestCost;
    for (let i = 0; i < best.length - 1; i += 1) {
      for (let j = i + 1; j < best.length; j += 1) {
        const trial = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const trialCost = orderCost(trial, first, step, last);
        if (trialCost < candidateCost - 1e-9) {
          candidate = trial;
          candidateCost = trialCost;
        }
      }
    }
    if (candidate) {
      best = candidate;
      bestCost = candidateCost;
      improved = true;
    }
  }
  return best;
}

/** Exact up to EXACT_LIMIT stops, nearest-neighbour and 2-opt above it. */
export function planOrder(n, first, step, last) {
  if (n <= EXACT_LIMIT) return { order: exactOrder(n, first, step, last), method: "exact" };
  return { order: twoOptOrder(nearestNeighbourOrder(n, first, step), first, step, last), method: "heuristic" };
}

/**
 * Order chosen stops into the shortest route.
 *
 * Both ends can be pinned. Pass `finish` for an open run from one place to
 * another; set `returnsToStart` for a loop home. Up to EXACT_LIMIT stops the
 * order is provably the shortest.
 */
export function buildRoute(chosen, origin, model, returnsToStart = false, finish = null) {
  const byId = new Map();
  for (const place of chosen) if (!byId.has(place.id)) byId.set(place.id, place);
  // Indexed by place id so the order does not depend on the order stops arrive in.
  const ids = [...byId.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const end = finish || origin;
  const closes = returnsToStart || finish != null;
  if (!ids.length) return { places: [], legs: [], totalKm: 0, travelMinutes: 0, visitMinutes: 0, method: "exact" };

  const stops = ids.map((id) => byId.get(id));
  const first = stops.map((place) => model.from(origin, place).roadKm);
  const step = stops.map((a) => stops.map((b) => (a.id === b.id ? 0 : model.from(a, b).roadKm)));
  const last = stops.map((place) => (closes ? model.from(place, end).roadKm : 0));
  const { order, method } = planOrder(stops.length, first, step, last);
  const initialKm = orderCost(nearestNeighbourOrder(stops.length, first, step), first, step, last);

  const places = order.map((index) => stops[index]);
  const legs = [{ from: origin.name, to: places[0].name, estimate: model.from(origin, places[0]) }];
  for (let i = 0; i < places.length - 1; i += 1) {
    legs.push({ from: places[i].name, to: places[i + 1].name, estimate: model.from(places[i], places[i + 1]) });
  }
  if (closes) {
    legs.push({
      from: places[places.length - 1].name,
      to: end.name,
      estimate: model.from(places[places.length - 1], end),
    });
  }

  const visitMinutes = places.reduce((sum, p) => sum + (p.minutes ?? DEFAULT_VISIT_MINUTES), 0);
  const travelMinutes = legs.reduce((sum, leg) => sum + leg.estimate.minutes, 0);
  return {
    places,
    legs,
    returnsToStart,
    finish,
    method,
    totalKm: legs.reduce((sum, leg) => sum + leg.estimate.roadKm, 0),
    initialKm,
    travelMinutes,
    visitMinutes,
    totalMinutes: travelMinutes + visitMinutes,
    assumedVisitCount: places.filter((p) => p.minutes == null).length,
  };
}

/**
 * Order chosen gardens when there is no start point to begin from.
 *
 * Up to EXACT_LIMIT stops this is one exact search with the start left free,
 * so the first garden is chosen as part of the optimum. Above it, each garden
 * is tried as the first with the approximate ordering, and the shortest kept.
 *
 * A UI helper with no Python counterpart: the command line always has a base.
 */
export function routeFromBestFirstStop(chosen, model) {
  const unique = [...new Map(chosen.map((place) => [place.id, place])).values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  const visitOf = (place) => place.minutes ?? DEFAULT_VISIT_MINUTES;
  if (!unique.length) {
    return { places: [], legs: [], totalKm: 0, travelMinutes: 0, visitMinutes: 0, totalMinutes: 0, method: "exact" };
  }

  const n = unique.length;
  const step = unique.map((a) => unique.map((b) => (a.id === b.id ? 0 : model.from(a, b).roadKm)));
  const zeros = new Array(n).fill(0);
  let order;
  let method;
  if (n <= EXACT_LIMIT) {
    order = exactOrder(n, zeros, step, zeros);
    method = "exact";
  } else {
    let best = null;
    for (let s = 0; s < n; s += 1) {
      const first = zeros.map((_, k) => (k === s ? 0 : Infinity));
      const candidate = twoOptOrder(nearestNeighbourOrder(n, first, step), first, step, zeros);
      const km = orderCost(candidate, first, step, zeros);
      if (!best || km < best.km - 1e-9) best = { order: candidate, km };
    }
    order = best.order;
    method = "heuristic";
  }

  const places = order.map((index) => unique[index]);
  const legs = [];
  for (let i = 0; i < places.length - 1; i += 1) {
    legs.push({ from: places[i].name, to: places[i + 1].name, estimate: model.from(places[i], places[i + 1]) });
  }
  const travelMinutes = legs.reduce((sum, leg) => sum + leg.estimate.minutes, 0);
  const visitMinutes = places.reduce((sum, place) => sum + visitOf(place), 0);
  return {
    places,
    // The first stop has no drive into it; legs[i] leads to places[i + 1].
    legs,
    method,
    totalKm: legs.reduce((sum, leg) => sum + leg.estimate.roadKm, 0),
    travelMinutes,
    visitMinutes,
    totalMinutes: travelMinutes + visitMinutes,
    startsAtFirstStop: true,
  };
}

/** Mirrors Place.garden_nr: "C24, F30". A human reference, never a key. */
export function gardenNr(place) {
  const parts = [];
  if (place.centuriaNo != null) parts.push(`C${place.centuriaNo}`);
  if (place.fringeNo != null) parts.push(`F${place.fringeNo}`);
  return parts.join(", ");
}

/** Mirrors Place.map_label: one label per pin, Centuria winning where both exist. */
export function mapLabel(place) {
  if (place.centuriaNo != null) return `C${place.centuriaNo}`;
  return place.fringeNo != null ? `F${place.fringeNo}` : "";
}

export function findPlaces(places, query) {
  const wanted = fold(query);
  if (!wanted) return places;
  return places.filter(
    (p) =>
      fold(p.name).includes(wanted) ||
      fold(p.region).includes(wanted) ||
      fold(gardenNr(p)).split(", ").includes(wanted)
  );
}

/**
 * A day with some stops committed: already visited today, or handed to Google
 * Maps, so their order is settled. They are kept exactly in the order given —
 * visited ones in the order they were visited, then the ones in Maps in the
 * order Maps was given them — and only the rest is solved, onward from the last.
 *
 * Solving everything together is shorter on paper but wrong in the car. Add or
 * remove one garden after sending and the whole day re-optimises, scattering the
 * sent gardens through it; and re-solving the committed ones among themselves
 * after a top-up reorders the very list Maps is driving, and routes you back
 * through gardens already done. Either way the plan stops agreeing with the car.
 * Field-app only; the Python planner has no Google Maps.
 */
export function buildCommittedRoute(committed, rest, origin, model, finish = null) {
  const leg = (a, b) => ({ from: a.name, to: b.name, estimate: model.from(a, b) });
  if (!committed.length) {
    return origin ? buildRoute(rest, origin, model, false, finish) : routeFromBestFirstStop(rest, model);
  }
  const head = [...new Map(committed.map((place) => [place.id, place])).values()];
  const legs = [];
  let from = origin;
  for (const place of head) {
    if (from) legs.push(leg(from, place));
    from = place;
  }
  const last = head[head.length - 1];
  let tail = { places: [], legs: finish ? [leg(last, finish)] : [], method: "exact" };
  if (rest.length) tail = buildRoute(rest, last, model, false, finish);
  const places = [...head, ...tail.places];
  legs.push(...tail.legs);
  const travelMinutes = legs.reduce((sum, item) => sum + item.estimate.minutes, 0);
  const visitMinutes = places.reduce((sum, p) => sum + (p.minutes ?? DEFAULT_VISIT_MINUTES), 0);
  return {
    places,
    legs,
    startsAtFirstStop: !origin,
    returnsToStart: false,
    finish,
    // The committed order is given, not searched for; only the rest can be approximate.
    method: tail.method,
    totalKm: legs.reduce((sum, item) => sum + item.estimate.roadKm, 0),
    travelMinutes,
    visitMinutes,
    totalMinutes: travelMinutes + visitMinutes,
    assumedVisitCount: places.filter((p) => p.minutes == null).length,
  };
}
