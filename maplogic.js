/**
 * Geometry and selection rules for the map, with no DOM in sight.
 *
 * Kept apart from map.js so the parts most likely to hide a subtle bug - the
 * zoom that should keep the point under your fingers still, which garden a tap
 * lands on, and what an area selection does - can be tested without a browser.
 */

const KM_PER_DEGREE = 111.32;
// Taranaki spans well under a degree of latitude, so one reference latitude
// keeps east-west distances true to within about half a percent.
const REFERENCE_LATITUDE = -39.3;
const COS_REFERENCE = Math.cos((REFERENCE_LATITUDE * Math.PI) / 180);

export const MIN_SCALE = 2; // pixels per kilometre, whole region comfortably in view
export const MAX_SCALE = 400; // close enough to separate gardens metres apart

/** Latitude and longitude to kilometres east and south of an arbitrary origin. */
export function project(lat, lon) {
  return {
    x: (lon - 174) * KM_PER_DEGREE * COS_REFERENCE,
    y: (-39 - lat) * KM_PER_DEGREE,
  };
}

/**
 * Decode one baked line into projected kilometres.
 *
 * Lines arrive as [lat, lon, dLat, dLon, ...] in whole ten-thousandths of a
 * degree, the first pair absolute and the rest differences from the previous.
 */
export function decodeLine(flat, scale = 10000) {
  const points = [];
  let lat = 0;
  let lon = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    lat += flat[i];
    lon += flat[i + 1];
    points.push(project(lat / scale, lon / scale));
  }
  return points;
}

/** SVG path data for points in kilometres. */
export function pathData(points) {
  return points
    .map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(3)} ${p.y.toFixed(3)}`)
    .join("");
}

/** Where to put a road's label: part-way along its longest line. */
export function labelAnchor(lines, share = 0.4) {
  let longest = null;
  let longestLength = -1;
  for (const line of lines) {
    let length = 0;
    for (let i = 1; i < line.length; i += 1) {
      length += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
    }
    if (length > longestLength) {
      longest = line;
      longestLength = length;
    }
  }
  if (!longest || longest.length < 2) return null;
  let target = longestLength * share;
  for (let i = 1; i < longest.length; i += 1) {
    const step = Math.hypot(longest[i].x - longest[i - 1].x, longest[i].y - longest[i - 1].y);
    if (step >= target) {
      const t = step ? target / step : 0;
      return {
        x: longest[i - 1].x + t * (longest[i].x - longest[i - 1].x),
        y: longest[i - 1].y + t * (longest[i].y - longest[i - 1].y),
      };
    }
    target -= step;
  }
  return longest[longest.length - 1];
}

export function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** A view is pixels per kilometre plus a screen offset. */
export function toScreen(view, point) {
  return { x: point.x * view.scale + view.tx, y: point.y * view.scale + view.ty };
}

export function toWorld(view, sx, sy) {
  return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale };
}

/** Frame every point inside a width by height box, with padding. */
export function fitView(points, width, height, padding = 32) {
  if (!points.length) return { scale: MIN_SCALE, tx: width / 2, ty: height / 2 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 0.5);
  const spanY = Math.max(maxY - minY, 0.5);
  const scale = clampScale(
    Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY)
  );
  return {
    scale,
    tx: width / 2 - ((minX + maxX) / 2) * scale,
    ty: height / 2 - ((minY + maxY) / 2) * scale,
  };
}

/**
 * Zoom by a factor about a screen point, keeping the ground under that point
 * exactly where it was. Without this a pinch drifts away from your fingers.
 */
export function zoomAt(view, factor, sx, sy) {
  const scale = clampScale(view.scale * factor);
  const anchor = toWorld(view, sx, sy);
  return { scale, tx: sx - anchor.x * scale, ty: sy - anchor.y * scale };
}

export function panBy(view, dx, dy) {
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy };
}

/** Views are stored by centre and scale, so they survive a change of screen size. */
export function describeView(view, width, height) {
  const centre = toWorld(view, width / 2, height / 2);
  return { cx: centre.x, cy: centre.y, scale: view.scale };
}

export function restoreView(saved, width, height) {
  const scale = clampScale(saved.scale);
  return { scale, tx: width / 2 - saved.cx * scale, ty: height / 2 - saved.cy * scale };
}

/** The pin a tap lands on: the nearest one within reach, or none. */
export function hitTest(pins, sx, sy, radius) {
  let best = null;
  let bestDistance = radius;
  for (const pin of pins) {
    const distance = Math.hypot(pin.sx - sx, pin.sy - sy);
    if (distance <= bestDistance) {
      best = pin;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Which pins get a readable number rather than a plain dot.
 *
 * At full extent the New Plymouth cluster is a pile of overlapping labels, with
 * one garden having six others inside a kilometre. Labels are granted greedily,
 * planned gardens first, and refused to any pin too close to one already
 * labelled. Zoom in and the gaps open, so more numbers appear.
 */
export function declutter(pins, minGap) {
  const ordered = [...pins].sort(
    (a, b) => Number(b.planned) - Number(a.planned) || a.label.localeCompare(b.label, "en", { numeric: true })
  );
  const labelled = [];
  for (const pin of ordered) {
    if (labelled.every((other) => Math.hypot(other.sx - pin.sx, other.sy - pin.sy) >= minGap)) {
      labelled.push(pin);
    }
  }
  return new Set(labelled.map((pin) => pin.id));
}

function inside(pin, rect) {
  const left = Math.min(rect.x0, rect.x1);
  const right = Math.max(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const bottom = Math.max(rect.y0, rect.y1);
  return pin.sx >= left && pin.sx <= right && pin.sy >= top && pin.sy <= bottom;
}

/**
 * One area selection, from the moment the drag starts to the moment it ends.
 *
 * The rule is "set all", not "toggle each": everything inside ends up the same
 * way. Which way is decided by the first garden the growing box catches. If that
 * one was in the plan, the box removes; if it was not, the box adds. The choice
 * is locked the moment it is made, so shrinking the box back past that garden
 * does not reverse it, and the preview never flickers between the two.
 *
 * Should one movement of the finger catch several gardens at once, the one
 * nearest the corner where the drag began counts as first.
 */
export class AreaSelection {
  constructor(isPlanned) {
    this.isPlanned = isPlanned;
    this.first = null;
    this.target = null;
    this.ids = [];
  }

  update(rect, pins) {
    const caught = pins.filter((pin) => inside(pin, rect));
    if (this.target === null && caught.length) {
      const first = [...caught].sort(
        (a, b) =>
          Math.hypot(a.sx - rect.x0, a.sy - rect.y0) - Math.hypot(b.sx - rect.x0, b.sy - rect.y0) ||
          (a.id < b.id ? -1 : 1)
      )[0];
      this.first = first.id;
      this.target = !this.isPlanned(first.id);
    }
    this.ids = caught.map((pin) => pin.id);
    return { target: this.target, ids: this.ids, first: this.first };
  }

  /** What to set when the finger lifts. Nothing if the box caught nothing. */
  result() {
    if (this.target === null) return { target: null, ids: [] };
    return { target: this.target, ids: [...this.ids] };
  }
}
