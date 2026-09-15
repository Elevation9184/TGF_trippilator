# TGF Trippilator

An offline trip planner for the Centuria Taranaki Garden Festival and the
Taranaki Fringe Garden Festival, Friday 30 October to Sunday 8 November 2026.

**This repository contains only the published app.** It is generated; do not
edit it by hand. The planning tools, source workbook and geocoding audit trail
live in a separate private project and are published with `python -m src.publish`.

## Installing it on an Android phone

1. Open the link **in Chrome**. A link tapped inside WhatsApp, Messenger or
   email opens in that app's own browser, which cannot install the app and
   keeps your ratings separately. Use ⋮ → *Open in Chrome* first.
2. In Chrome, ⋮ → **Install app** (or *Add to Home screen*).
3. Open it once with signal before driving out. After that it works with no
   coverage at all.

Updates arrive by themselves the next time the app is opened with signal. The
footer shows a build stamp, such as `build 20261028-1930`; quote it when
reporting a problem.

## Using it

- **Nearest** — the closest gardens to your base, to where you are, or to any
  garden, optionally ranked by your own ratings as well as distance.
- **On the way** — what is worth collecting between two places, and what each
  one adds to the drive.
- **Map** — every garden by its festival map number, with no signal needed.
  Tap to add a garden to your plan; press and hold for its details.
- **My day** — the shortest order to visit everything in your plan, with
  driving and visit times, checked against each garden's published opening
  days.
- **Preselect** narrows what every tab shows: area, festival, opening day,
  facilities, rating. **Garden Edit** holds your own ratings, notes and visits.

Driving is handed to Google Maps. It takes ten stops at a time, so a longer
day is sent in batches: mark gardens *Seen* as you go and the button sends the
rest.

## Your data stays on your phone

Your base, ratings, notes, visits and plan are kept in this browser on this
device. Nothing is uploaded, and nobody else's copy can see them. Clearing
Chrome's site data removes them, so use **Export notes** in the footer to keep
a backup or move them to another phone.

Two things ask a free public service from your phone, and only when you use
them: finding your base by address asks OpenStreetMap's Nominatim, and
measuring road distances from your base or from where you are asks the OSRM
router. Neither is sent anywhere else.

## Licence

The code is MIT licensed — see `LICENSE`.

That covers the code only. The data it carries has its own terms, below, which
the MIT licence does not and cannot override.

## Sources and data

Garden listings and opening days are from the published programmes and garden
pages of the
[Centuria Taranaki Garden Festival](https://www.gardenfestnz.co.nz/gardens) and
the [Taranaki Fringe Garden Festival](https://www.taranakigardens.co.nz/gardens-and-map/).

Coordinates, road distances and map outlines are derived from
[© OpenStreetMap contributors](https://www.openstreetmap.org/copyright) via
Nominatim, OSRM and Overpass, and are available under the
[Open Database Licence (ODbL)](https://opendatacommons.org/licenses/odbl/).

If you reuse the bundle, the OpenStreetMap attribution has to travel with it.
It is included inside `data/bundle.json` as well as on the page, so a copy taken
without the page still carries it.

Road distances are estimates. Opening days are read from each festival's own
wording and are shown as unknown (*days ?*) wherever a garden does not state
them. **Check with the festival before travelling** if a visit depends on it.
