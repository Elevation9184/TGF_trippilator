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

  /** Cost from an origin, which may be a known place or a raw position. */
  from(origin, destination) {
    if (origin.id && this.lookup(origin.id, destination.id)) {
      const entry = this.lookup(origin.id, destination.id);
      return {
        straightKm: haversineKm(origin.lat, origin.lon, destination.lat, destination.lon),
        roadKm: entry.km,
        minutes: entry.minutes,
        source: "road matrix",
      };
    }
    if (origin.id === destination.id) {
      return { straightKm: 0, roadKm: 0, minutes: 0, source: "same place" };
    }

    const snapped = this.snap(origin.lat, origin.lon);
    if (snapped && snapped.place.id !== destination.id) {
      const entry = this.lookup(snapped.place.id, destination.id);
      if (entry) {
        const hop = this.geometry(origin.lat, origin.lon, snapped.place.lat, snapped.place.lon);
        return {
          straightKm: haversineKm(origin.lat, origin.lon, destination.lat, destination.lon),
          roadKm: hop.roadKm + entry.km,
          minutes: hop.minutes + entry.minutes,
          source: `road matrix via ${snapped.place.name}`,
          snappedTo: snapped.place.name,
          snapKm: snapped.km,
        };
      }
    }
    if (snapped && snapped.place.id === destination.id) {
      const hop = this.geometry(origin.lat, origin.lon, destination.lat, destination.lon);
      return { ...hop, source: "geometry (you are here)" };
    }
    return this.geometry(origin.lat, origin.lon, destination.lat, destination.lon);
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

function sequenceKm(order, start, finish, model, byId, closes) {
  if (!order.length) return closes ? model.from(start, finish).roadKm : 0;
  let total = model.from(start, byId.get(order[0])).roadKm;
  for (let i = 0; i < order.length - 1; i += 1) {
    total += model.from(byId.get(order[i]), byId.get(order[i + 1])).roadKm;
  }
  if (closes) total += model.from(byId.get(order[order.length - 1]), finish).roadKm;
  return total;
}

/**
 * Nearest-neighbour construction then best-improvement 2-opt. Deterministic.
 *
 * Both ends can be pinned. Pass `finish` for an open path from one place to
 * another, which is the shape of a day driving from somewhere to somewhere
 * else. Ordering matters far more than it looks: for stops picked because they
 * are cheap detours the order you pass them is already optimal, but for stops
 * picked because you want them, optimising saved a median of 15 km and up to
 * 110 km across 200 sampled six-stop trips.
 */
export function buildRoute(chosen, origin, model, returnsToStart = false, finish = null) {
  const byId = new Map();
  for (const place of chosen) if (!byId.has(place.id)) byId.set(place.id, place);
  const ids = [...byId.keys()];
  const end = finish || origin;
  const closes = returnsToStart || finish != null;
  if (!ids.length) return { places: [], legs: [], totalKm: 0, travelMinutes: 0, visitMinutes: 0 };

  const remaining = new Set(ids);
  const order = [];
  let current = null;
  while (remaining.size) {
    let best = null;
    let bestKm = Infinity;
    for (const id of [...remaining].sort()) {
      const km = model.from(current ? byId.get(current) : origin, byId.get(id)).roadKm;
      if (km < bestKm) {
        best = id;
        bestKm = km;
      }
    }
    order.push(best);
    remaining.delete(best);
    current = best;
  }

  let bestOrder = order;
  let bestKm = sequenceKm(bestOrder, origin, end, model, byId, closes);
  const initialKm = bestKm;
  let improved = true;
  while (improved && bestOrder.length > 2) {
    improved = false;
    let candidate = null;
    let candidateKm = bestKm;
    for (let i = 0; i < bestOrder.length - 1; i += 1) {
      for (let j = i + 1; j < bestOrder.length; j += 1) {
        const trial = [
          ...bestOrder.slice(0, i),
          ...bestOrder.slice(i, j + 1).reverse(),
          ...bestOrder.slice(j + 1),
        ];
        const km = sequenceKm(trial, origin, end, model, byId, closes);
        if (km < candidateKm - 1e-9) {
          candidate = trial;
          candidateKm = km;
        }
      }
    }
    if (candidate) {
      bestOrder = candidate;
      bestKm = candidateKm;
      improved = true;
    }
  }

  const places = bestOrder.map((id) => byId.get(id));
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
 * Every stop is tried as the first, the rest ordered from it, and the shortest
 * open run kept. Without this, gardens picked on the map before anyone has set
 * a start point simply never appear in My day.
 *
 * A UI helper with no Python counterpart: the command line always has a base.
 */
export function routeFromBestFirstStop(chosen, model) {
  const unique = [...new Map(chosen.map((place) => [place.id, place])).values()];
  const visitOf = (place) => place.minutes ?? DEFAULT_VISIT_MINUTES;
  if (!unique.length) {
    return { places: [], legs: [], totalKm: 0, travelMinutes: 0, visitMinutes: 0, totalMinutes: 0 };
  }

  let best = null;
  for (const start of [...unique].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const rest = unique.filter((place) => place.id !== start.id);
    const route = rest.length
      ? buildRoute(rest, start, model, false)
      : { places: [], legs: [], totalKm: 0, travelMinutes: 0 };
    if (!best || route.totalKm < best.route.totalKm - 1e-9) best = { start, route };
  }

  const places = [best.start, ...best.route.places];
  const visitMinutes = places.reduce((sum, place) => sum + visitOf(place), 0);
  return {
    places,
    // The first stop has no drive into it; legs[i] leads to places[i + 1].
    legs: best.route.legs,
    totalKm: best.route.totalKm,
    travelMinutes: best.route.travelMinutes,
    visitMinutes,
    totalMinutes: best.route.travelMinutes + visitMinutes,
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
