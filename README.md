# TGF Trippilator

An offline trip planner for the Taranaki Garden Festival, 31 October to
5 November 2026. Open the link on a phone, add it to the home screen, and it
works with no mobile coverage.

**This repository contains only the published app.** It is generated; do not
edit it by hand. The planning tools, source workbook and geocoding audit trail
live in a separate private project and are published with `python -m src.publish`.

## Using it

Find the closest gardens to where you are, the best picks by distance and your
own interest ratings, what is worth collecting on the way somewhere, and an
ordered plan for the day that hands off to Google Maps for driving.

Your start point, ratings and visit history stay in your own browser. Nothing is
uploaded, and nobody else's copy can see them. Export them as a spreadsheet to
keep a backup or move them to another device.

## Licence

The code is MIT licensed — see `LICENSE`.

That covers the code only. The data it carries has its own terms, below, which
the MIT licence does not and cannot override.

## Sources and data

Garden listings are from the published programmes of the
[Centuria Taranaki Garden Festival](https://www.gardenfestnz.co.nz/gardens) and
the [Taranaki Fringe Garden Festival](https://www.taranakigardens.co.nz/gardens-and-map/).

Coordinates and road distances are derived from
[© OpenStreetMap contributors](https://www.openstreetmap.org/copyright) via
Nominatim and OSRM, and are available under the
[Open Database Licence (ODbL)](https://opendatacommons.org/licenses/odbl/).

If you reuse the bundle, the OpenStreetMap attribution has to travel with it.
It is included inside `data/bundle.json` as well as on the page, so a copy taken
without the page still carries it.

Road distances are estimates. **Check opening days with the festival before
travelling** — some gardens are not open every day, and that information is not
in this dataset.
