/**
 * The map view: drawing, and turning fingers into intentions.
 *
 * Gestures, as agreed:
 *   press and hold on a pin   name, numbers and address pop up
 *   tap a pin                 dismiss any popup, lock the garden in or release it
 *   tap empty map             dismiss the popup, change nothing
 *   one finger drag           move the map
 *   pinch                     zoom about the fingers
 *   Select area, then drag    a box that sets everything inside it the same way
 *
 * With a mouse: hover shows the popup, the wheel zooms, drag moves, and
 * shift-drag selects an area without pressing the button.
 *
 * The rules themselves live in maplogic.js, where they are tested.
 */

import * as geo from "./maplogic.js";

const SVG = "http://www.w3.org/2000/svg";
const HOLD_MS = 500;
const MOVE_TOLERANCE = 8; // pixels a press may wander before it becomes a drag
const TAP_RADIUS = 22; // generous, because fingers are not mouse pointers
const LABEL_GAP = 26;

// Egmont National Park: centred on the summit, 9.6 km radius, crossed by nothing.
const PARK = { centre: geo.project(-39.2968, 174.0645), radiusKm: 9.6 };
const TOWNS = [
  ["New Plymouth", -39.0556, 174.0752],
  ["Waitara", -38.9975, 174.234],
  ["Inglewood", -39.1547, 174.205],
  ["Stratford", -39.3406, 174.2831],
  ["Eltham", -39.4286, 174.3],
  ["Hāwera", -39.5921, 174.2809],
  ["Ōpunake", -39.456, 173.858],
  ["Okato", -39.1914, 173.8814],
  ["Oākura", -39.1236, 173.9536],
].map(([name, lat, lon]) => ({ name, point: geo.project(lat, lon) }));

function node(name, attributes = {}, text) {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text != null) element.textContent = text;
  return element;
}

export function createMap({ container, isPlanned, onToggle, onSetMany, describe, onViewChange }) {
  const svg = node("svg", { class: "map-svg", role: "application", "aria-label": "Map of gardens" });
  // Coastline and highways are hundreds of points. They are built once, in
  // kilometres, and moved by a transform; only the pins and labels, which must
  // stay a readable size, are redrawn as the map moves.
  const geoLayer = node("g", { class: "map-geo" });
  const liveLayer = node("g");
  svg.append(geoLayer, liveLayer);
  let roadLabels = [];
  let minorLayer = null;
  let tertiaryLayer = null;
  let markers = []; // { kind: "base" | "here", lat, lon, ... }
  let markerPins = [];
  let picking = null; // a callback while placing the base by tapping the map
  const popup = document.createElement("div");
  popup.className = "map-popup";
  popup.hidden = true;
  container.append(svg, popup);

  let places = [];
  let extent = [];
  let view = null;
  let pendingView = null; // a saved view waiting for the map to have a size
  let selecting = false;
  let pins = [];
  let area = null; // { rect, selection }
  let frame = 0;
  let popupId = null;

  const pointers = new Map();
  let gesture = null;
  let holdTimer = 0;

  const size = () => ({ width: container.clientWidth, height: container.clientHeight });

  function ensureView() {
    const { width, height } = size();
    if (pendingView && width && height) {
      view = geo.restoreView(pendingView, width, height);
      pendingView = null;
      svg._lastSize = { width, height };
    }
    if (view) return;
    view = geo.fitView(extent, width, height);
  }

  let fallback = 0;

  // Redraw on the next animation frame, or shortly after if frames are being
  // withheld, as some browsers do when saving power. Whichever comes first wins.
  function schedule() {
    if (frame || fallback) return;
    frame = requestAnimationFrame(redraw);
    fallback = setTimeout(redraw, 60);
  }

  function redraw() {
    cancelAnimationFrame(frame);
    clearTimeout(fallback);
    frame = 0;
    fallback = 0;
    draw();
  }

  function draw() {
    const { width, height } = size();
    if (!width || !height) return;
    ensureView();
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    geoLayer.setAttribute("transform", `matrix(${view.scale} 0 0 ${view.scale} ${view.tx} ${view.ty})`);
    // Secondary roads are clutter across the whole region and a guide close in.
    if (minorLayer) minorLayer.style.display = geo.showMinorRoads(view.scale) ? "" : "none";
    if (tertiaryLayer) tertiaryLayer.style.display = geo.showTertiaryRoads(view.scale) ? "" : "none";
    liveLayer.replaceChildren();
    const svgAppend = (...children) => liveLayer.append(...children);

    // Geography scales with the view; text and pins stay a readable size.
    const park = geo.toScreen(view, PARK.centre);
    svgAppend(node("circle", { class: "map-park", cx: park.x, cy: park.y, r: PARK.radiusKm * view.scale }));
    if (PARK.radiusKm * view.scale > 40) {
      svgAppend(node("text", { class: "map-park-label", x: park.x, y: park.y, "text-anchor": "middle" }, "Egmont National Park"));
    }
    for (const label of roadLabels) {
      const at = geo.toScreen(view, label.point);
      if (at.x < -20 || at.x > width + 20 || at.y < -20 || at.y > height + 20) continue;
      svgAppend(node("text", { class: "map-road-label", x: at.x, y: at.y, "text-anchor": "middle" }, label.ref));
    }
    for (const town of TOWNS) {
      const at = geo.toScreen(view, town.point);
      svgAppend(node("circle", { class: "map-town", cx: at.x, cy: at.y, r: 2.5 }));
      svgAppend(node("text", { class: "map-town-label", x: at.x + 5, y: at.y - 5 }, town.name));
    }

    pins = places.map((place) => {
      const at = geo.toScreen(view, geo.project(place.lat, place.lon));
      return {
        id: place.id,
        sx: at.x,
        sy: at.y,
        label: place.label,
        planned: isPlanned(place.id),
        greyed: Boolean(place.greyed),
        place,
      };
    });
    const labelled = geo.declutter(pins, LABEL_GAP);
    const preview = area?.selection.target != null ? new Set(area.selection.ids) : null;

    for (const pin of pins) {
      const onScreen = pin.sx > -30 && pin.sx < width + 30 && pin.sy > -30 && pin.sy < height + 30;
      if (!onScreen) continue;
      const classes = ["map-pin", `map-pin-${pin.place.festivalClass}`];
      if (pin.planned) classes.push("is-planned");
      if (pin.greyed) classes.push("is-greyed");
      if (preview?.has(pin.id)) classes.push(area.selection.target ? "will-add" : "will-remove");
      const group = node("g", { class: classes.join(" ") });
      if (labelled.has(pin.id)) {
        group.append(node("circle", { cx: pin.sx, cy: pin.sy, r: 12 }));
        group.append(node("text", { x: pin.sx, y: pin.sy + 3.5, "text-anchor": "middle" }, pin.label));
      } else {
        group.append(node("circle", { cx: pin.sx, cy: pin.sy, r: 5 }));
      }
      svgAppend(group);
    }

    // The base and where you are, on top of everything: never decluttered away.
    markerPins = markers.map((marker) => {
      const at = geo.toScreen(view, geo.project(marker.lat, marker.lon));
      return { id: `marker:${marker.kind}`, sx: at.x, sy: at.y, marker, place: marker };
    });
    for (const pin of markerPins) {
      const group = node("g", { class: `map-marker map-marker-${pin.marker.kind}` });
      if (pin.marker.kind === "base") {
        group.append(node("circle", { cx: pin.sx, cy: pin.sy, r: 13 }));
        group.append(node("text", { x: pin.sx, y: pin.sy + 4.5, "text-anchor": "middle" }, "B"));
      } else {
        group.append(node("circle", { class: "map-here-ring", cx: pin.sx, cy: pin.sy, r: 11 }));
        group.append(node("circle", { class: "map-here-dot", cx: pin.sx, cy: pin.sy, r: 5.5 }));
      }
      svgAppend(group);
    }

    if (area) {
      const { x0, y0, x1, y1 } = area.rect;
      const verb = area.selection.target == null ? "" : area.selection.target ? " add" : " remove";
      svgAppend(
        node("rect", {
          class: `map-area${verb}`,
          x: Math.min(x0, x1),
          y: Math.min(y0, y1),
          width: Math.abs(x1 - x0),
          height: Math.abs(y1 - y0),
        })
      );
    }

    if (popupId) placePopup();
  }

  function localPoint(event) {
    const box = svg.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function showPopup(pin) {
    popupId = pin.id;
    popup.innerHTML = describe(pin.place);
    popup.hidden = false;
    placePopup();
  }

  /** A marker wins over a garden under the same finger: it is drawn on top. */
  function hitAnything(x, y, radius) {
    return geo.hitTest(markerPins, x, y, radius) || geo.hitTest(pins, x, y, radius);
  }

  function worldAt(x, y) {
    const point = geo.toWorld(view, x, y);
    return geo.unproject(point.x, point.y);
  }

  function placePopup() {
    const pin = [...markerPins, ...pins].find((p) => p.id === popupId);
    if (!pin) return hidePopup();
    const { width } = size();
    const w = popup.offsetWidth;
    const h = popup.offsetHeight;
    const left = Math.min(Math.max(8, pin.sx - w / 2), width - w - 8);
    const top = pin.sy - h - 18 < 8 ? pin.sy + 18 : pin.sy - h - 18;
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  function hidePopup() {
    popupId = null;
    popup.hidden = true;
  }

  function commitView() {
    const { width, height } = size();
    if (view && onViewChange) onViewChange(geo.describeView(view, width, height));
  }

  function cancelHold() {
    clearTimeout(holdTimer);
    holdTimer = 0;
  }

  svg.addEventListener("pointerdown", (event) => {
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      /* A pointer the browser will not capture still works; it just may stray. */
    }
    const at = localPoint(event);
    pointers.set(event.pointerId, at);

    if (pointers.size === 2) {
      // A second finger turns whatever was happening into a pinch.
      cancelHold();
      area = null;
      const [a, b] = [...pointers.values()];
      gesture = { kind: "pinch", distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      schedule();
      return;
    }
    if (pointers.size > 2) return;

    const areaGesture = selecting || (event.pointerType === "mouse" && event.shiftKey);
    gesture = { kind: areaGesture ? "area" : "press", start: at, last: at, moved: false, held: false };
    if (!areaGesture) {
      holdTimer = setTimeout(() => {
        if (!gesture || gesture.moved) return;
        if (picking) {
          gesture.held = true;
          const { lat, lon } = worldAt(gesture.start.x, gesture.start.y);
          navigator.vibrate?.(15);
          picking(lat, lon);
          return;
        }
        const pin = hitAnything(gesture.start.x, gesture.start.y, TAP_RADIUS);
        if (pin) {
          gesture.held = true;
          showPopup(pin);
          navigator.vibrate?.(15);
        }
      }, HOLD_MS);
    }
  });

  svg.addEventListener("pointermove", (event) => {
    const at = localPoint(event);

    if (!pointers.has(event.pointerId)) {
      // A mouse moving with no button down: hover shows what is under it.
      if (event.pointerType === "mouse" && !area) {
        const pin = hitAnything(at.x, at.y, 14);
        if (pin && pin.id !== popupId) showPopup(pin);
        else if (!pin && popupId) hidePopup();
      }
      return;
    }
    pointers.set(event.pointerId, at);
    if (!gesture) return;

    if (gesture.kind === "pinch" && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (gesture.distance > 0) view = geo.zoomAt(view, distance / gesture.distance, mid.x, mid.y);
      view = geo.panBy(view, mid.x - gesture.mid.x, mid.y - gesture.mid.y);
      gesture.distance = distance;
      gesture.mid = mid;
      schedule();
      return;
    }

    if (!gesture.moved && Math.hypot(at.x - gesture.start.x, at.y - gesture.start.y) > MOVE_TOLERANCE) {
      gesture.moved = true;
      cancelHold();
      if (gesture.kind === "area") {
        hidePopup();
        area = { rect: { x0: gesture.start.x, y0: gesture.start.y, x1: at.x, y1: at.y }, selection: new geo.AreaSelection(isPlanned) };
      }
    }
    if (!gesture.moved) return;

    if (gesture.kind === "area" && area) {
      area.rect.x1 = at.x;
      area.rect.y1 = at.y;
      // A box sweeps up what is on offer; greyed-out gardens are outside the
      // preselection, and taking a whole corner of them in would be a surprise.
      area.selection.update(area.rect, pins.filter((pin) => !pin.greyed));
    } else if (gesture.kind === "press") {
      view = geo.panBy(view, at.x - gesture.last.x, at.y - gesture.last.y);
    }
    gesture.last = at;
    schedule();
  });

  function endPointer(event, cancelled) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    cancelHold();
    if (!gesture) return;

    if (gesture.kind === "pinch") {
      if (pointers.size === 1) {
        // The finger left behind carries on as a drag, without jumping or tapping.
        const [remaining] = pointers.values();
        gesture = { kind: "press", start: remaining, last: remaining, moved: true, held: false };
      } else if (pointers.size === 0) {
        gesture = null;
        commitView();
      }
      return;
    }

    const finished = gesture;
    gesture = null;
    if (cancelled) {
      area = null;
      schedule();
      return;
    }

    if (finished.kind === "area") {
      if (area) {
        const { target, ids } = area.selection.result();
        area = null;
        if (target !== null && ids.length) onSetMany(ids, target);
        setSelecting(false);
      }
      schedule();
      return;
    }

    if (finished.moved) {
      commitView();
    } else if (!finished.held) {
      // A tap. On a pin: dismiss any popup and lock in or release. A greyed-out
      // garden can be tapped too; that is how one outside the filters is added.
      // On empty map: just dismiss. On the base or here marker: say what it is.
      // While placing the base, a tap anywhere puts it there instead.
      hidePopup();
      if (picking) {
        const { lat, lon } = worldAt(finished.start.x, finished.start.y);
        picking(lat, lon);
      } else {
        const pin = hitAnything(finished.start.x, finished.start.y, TAP_RADIUS);
        if (pin?.marker) showPopup(pin);
        else if (pin) onToggle(pin.id);
      }
    }
    schedule();
  }

  svg.addEventListener("pointerup", (event) => endPointer(event, false));
  svg.addEventListener("pointercancel", (event) => endPointer(event, true));
  svg.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && !pointers.size && popupId) hidePopup();
  });
  svg.addEventListener("contextmenu", (event) => event.preventDefault());
  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const at = localPoint(event);
      ensureView();
      view = geo.zoomAt(view, Math.exp(-event.deltaY * 0.0015), at.x, at.y);
      schedule();
      clearTimeout(svg._wheelTimer);
      svg._wheelTimer = setTimeout(commitView, 250);
    },
    { passive: false }
  );

  new ResizeObserver(() => {
    if (!view) return schedule();
    // Keep the same ground in the middle when the screen changes shape, and
    // ignore being hidden, which is not a change of shape.
    ({ view, size: svg._lastSize } = geo.resizeView(view, svg._lastSize, size()));
    schedule();
  }).observe(container);

  let onSelectingChange = () => {};

  function setSelecting(value) {
    selecting = value;
    area = null;
    onSelectingChange(selecting);
    schedule();
  }

  return {
    /** Coastline, secondary roads and highways, baked from OpenStreetMap. Optional. */
    setGeography(geography) {
      geoLayer.replaceChildren();
      roadLabels = [];
      if (!geography) return schedule();
      const scale = geography.scale || 10000;
      for (const flat of geography.coast || []) {
        geoLayer.append(node("path", { class: "map-coast", d: geo.pathData(geo.decodeLine(flat, scale)) }));
      }
      // Lesser roads under greater ones, so a highway is never hidden by a lane.
      tertiaryLayer = node("g", { class: "map-tertiary-layer" });
      for (const flat of geography.tertiary || []) {
        tertiaryLayer.append(node("path", { class: "map-tertiary", d: geo.pathData(geo.decodeLine(flat, scale)) }));
      }
      geoLayer.append(tertiaryLayer);
      minorLayer = node("g", { class: "map-minor-layer" });
      for (const flat of geography.minor || []) {
        minorLayer.append(node("path", { class: "map-minor", d: geo.pathData(geo.decodeLine(flat, scale)) }));
      }
      geoLayer.append(minorLayer);
      for (const road of geography.roads || []) {
        const lines = road.lines.map((flat) => geo.decodeLine(flat, scale));
        for (const line of lines) {
          geoLayer.append(node("path", { class: "map-road", d: geo.pathData(line) }));
        }
        const point = geo.labelAnchor(lines, road.ref === "SH45" ? 0.55 : 0.4);
        if (point) roadLabels.push({ ref: road.ref, point });
      }
      schedule();
    },
    /** Places to draw, each marked greyed or not. Seen gardens are left out by the caller. */
    setPlaces(visible, all) {
      places = visible;
      extent = all.map((p) => geo.project(p.lat, p.lon));
      if (popupId && !visible.some((p) => p.id === popupId)) hidePopup();
      schedule();
    },
    refresh: schedule,
    /** The base and where you are. Drawn on top, not selectable. */
    setMarkers(list) {
      markers = (list || []).filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon));
      if (popupId?.startsWith("marker:") && !markers.some((m) => `marker:${m.kind}` === popupId)) hidePopup();
      schedule();
    },
    /** Put a point in the middle, zoomed in at least as far as `scale`. */
    centreOn(lat, lon, scale = 40) {
      const point = geo.project(lat, lon);
      const target = geo.clampScale(Math.max(scale, view?.scale ?? 0));
      const { width, height } = size();
      if (width && height) {
        pendingView = null;
        view = { scale: target, tx: width / 2 - point.x * target, ty: height / 2 - point.y * target };
        svg._lastSize = { width, height };
        commitView();
      } else {
        pendingView = { cx: point.x, cy: point.y, scale: target };
      }
      schedule();
    },
    /** While set, a tap or press on the map calls back with its position rather than toggling. */
    setPicking(callback) {
      picking = callback || null;
      setSelecting(false);
      hidePopup();
    },
    fit() {
      pendingView = null;
      const { width, height } = size();
      view = geo.fitView(extent, width, height);
      commitView();
      schedule();
    },
    restore(saved) {
      const { width, height } = size();
      if (saved && width && height) {
        view = geo.restoreView(saved, width, height);
        svg._lastSize = { width, height };
      } else if (saved) {
        // Not laid out yet: hold on to it rather than lose it to a fit.
        pendingView = saved;
      }
      schedule();
    },
    setSelecting,
    get selecting() {
      return selecting;
    },
    onSelectingChange(callback) {
      onSelectingChange = callback;
    },
    hidePopup,
  };
}
