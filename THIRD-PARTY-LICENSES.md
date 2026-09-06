# Third-party licences

WingLog itself is licensed under the GNU General Public License v3.0 — see
[`LICENSE`](./LICENSE). This document covers the third-party code and data distributed
*with* it, and the obligations that come with them.

**This file is generated** by `npm run licenses:generate` from the installed production
dependencies. Don't edit it by hand; edit `scripts/generate-third-party-licenses.ts`
and re-run.

---

## GNU LGPL v3.0: node-simconnect

WingLog's SimConnect layer depends on [node-simconnect][ns], which is licensed under
the **GNU Lesser General Public License, version 3 or later**. This is the one dependency
whose licence imposes obligations beyond attribution, so they're stated explicitly:

- **The library is used unmodified.** WingLog ships the published npm package as-is;
  no patches, no vendored fork.
- **It is dynamically loaded, not statically combined.** The build externalizes it
  (`externalizeDepsPlugin` in `electron.vite.config.ts`), so the packaged main process
  does a plain `require("node-simconnect")` at runtime.
- **It is replaceable.** The package is excluded from the app's asar archive
  (`asarUnpack` in `electron-builder.yml`), so it exists as ordinary files under
  `resources/app.asar.unpacked/node_modules/node-simconnect/` in an installed copy. A
  user may replace it with a modified or newer version of the library and run the result.
- **Corresponding source** for the exact version shipped is available from the upstream
  repository and from the npm registry, and on request from the copyright holder of
  WingLog at no charge.
- **The full LGPL v3.0 text** is reproduced below. LGPL v3.0 incorporates the terms of
  GPL v3.0 by reference; that text is in [`LICENSE`](./LICENSE).

[ns]: https://github.com/EvenAR/node-simconnect

### GNU Lesser General Public License v3.0

```
[object Object]
```

---

## Dependencies

| Package | Version | Licence |
| --- | --- | --- |
| [better-sqlite3](git://github.com/WiseLibs/better-sqlite3) | 13.0.3 | MIT |
| [class-variance-authority](https://github.com/joe-bell/cva) | 0.7.1 | Apache-2.0 |
| [clsx](lukeed/clsx) | 2.1.1 | MIT |
| [drizzle-orm](https://github.com/drizzle-team/drizzle-orm) | 0.45.2 | Apache-2.0 |
| [lucide-react](https://github.com/lucide-icons/lucide) | 1.39.0 | ISC |
| [maplibre-gl](https://github.com/maplibre/maplibre-gl-js) | 6.6.0 | BSD-3-Clause |
| [next-themes](https://github.com/pacocoursey/next-themes) | 0.4.6 | MIT |
| [node-simconnect](https://github.com/EvenAR/node-simconnect) | 4.2.0 | LGPL-3.0-or-later |
| [radix-ui](https://github.com/radix-ui/primitives) | 1.6.7 | MIT |
| [react](https://github.com/react/react) | 19.2.8 | MIT |
| [react-dom](https://github.com/react/react) | 19.2.8 | MIT |
| [recharts](https://github.com/recharts/recharts) | 3.10.1 | MIT |
| [sonner](https://github.com/emilkowalski/sonner) | 2.0.8 | MIT |
| [tailwind-merge](https://github.com/dcastil/tailwind-merge) | 3.6.0 | MIT |

### better-sqlite3 13.0.3 — MIT

```
[object Object]
```

### class-variance-authority 0.7.1 — Apache-2.0

```
[object Object]
```

### clsx 2.1.1 — MIT

```
[object Object]
```

### drizzle-orm 0.45.2 — Apache-2.0

This package declares `Apache-2.0` in its manifest but does not ship a licence file. See https://github.com/drizzle-team/drizzle-orm for the applicable terms.

### lucide-react 1.39.0 — ISC

```
[object Object]
```

### maplibre-gl 6.6.0 — BSD-3-Clause

```
[object Object]
```

### next-themes 0.4.6 — MIT

```
[object Object]
```

### radix-ui 1.6.7 — MIT

```
[object Object]
```

### react 19.2.8 — MIT

```
[object Object]
```

### react-dom 19.2.8 — MIT

```
[object Object]
```

### recharts 3.10.1 — MIT

```
[object Object]
```

### sonner 2.0.8 — MIT

```
[object Object]
```

### tailwind-merge 3.6.0 — MIT

```
[object Object]
```

---

## Bundled data

Three reference datasets are vendored into the app. Their per-file provenance and terms
are reproduced verbatim below, from `resources/*.LICENSE.txt` in the source repository.

**Note on the airline database:** it is licensed under the Open Database License (ODbL)
1.0, which is share-alike **for the database**. It does not place WingLog's own source
code under ODbL, but the dataset itself — and any redistributed derivative of it — must
remain under a free/open licence, in any distribution of this app.

### Airports — OurAirports

```
airports.csv

Source: https://davidmegginson.github.io/ourairports-data/airports.csv
        (fetched 2026-09-01)
License: Public domain (OurAirports data)

Trimmed from the full ~80k-row, 19-column, 12.7 MB source down to a minimal name/ICAO
search slice for Dispatch's airport-search feature (docs/decisions.md, 2026-09-01 entry):
kept only rows with a 4-letter icao_code or (falling back) gps_code, dropped rows with
type "closed", and projected down to
icao,name,municipality,iso_country,type,latitude_deg,longitude_deg — 43,400 rows, 3.4 MB.
latitude_deg/longitude_deg were added 2026-09-06 for Logbook's total-distance-flown stat
(great-circle dep/arr, airport-search.ts's getAirportCoords) — reusing this same vendored
slice rather than a second one, since the two features draw from the same underlying
OurAirports fetch. Runways/navaids are still not included; PLAN.md's M6 (landing
analysis) vendors those separately in resources/runways.csv.
```

### Airlines — OpenFlights (ODbL 1.0)

```
Source: https://github.com/jpatokal/openflights/blob/master/data/airlines.dat
        (OpenFlights Airline Database, fetched 2026-09-01)
License: Open Database License (ODbL) 1.0 — https://opendatacommons.org/licenses/odbl/1-0/
         Attribution required; any redistributed derivative of the database must remain
         under a free/open license. This attribution file plus a NOTICE entry (see
         docs/decisions.md) satisfy that requirement for this trimmed slice; the app's
         own MIT-licensed source code is not itself put under ODbL by this — the license
         applies to the airlines.csv database file, not to the application.

Trimmed from the full 6,162-row, 8-column upstream file down to a name/ICAO/IATA search
slice for Fleet's airline-search feature (docs/decisions.md, 2026-09-01 entry): dropped
the two placeholder rows ("Unknown"/"Private flight"), dropped rows with no usable ICAO
code, and projected down to name,icao,iata — 5,886 rows, 136 KB. Airline ID, alias,
callsign, country, and active-status columns from the original are not included. Not
filtered by the upstream "active" flag — that field is known to be stale for a database
that hasn't been actively maintained, so filtering on it would silently drop real
airlines; correctness of the ICAO/IATA codes themselves was spot-checked against several
well-known carriers instead.

Airline logos are not part of this dataset (OpenFlights doesn't provide any) — the app
fetches those live from images.kiwi.com by IATA code, see docs/decisions.md. Rows with no
IATA code (about 4,600 of the 5,886) can still be found and selected by name/ICAO; they
simply show no logo.
```

### Aircraft type designators — ICAO Doc 8643 list

```
icao-aircraft-types.csv

Source: https://github.com/ColtJD45/icao-aircraft-designator-list
        (icao_aircraft_data.csv, fetched 2026-09-01)
License: MIT (per the source repository)
Origin:  ICAO Doc 8643, Aircraft Type Designators

Used in WingLog as a local reference list for the Fleet "search aircraft type"
fallback (docs/decisions.md, 2026-09-01 entry). Not modified from the source file.
```

---

## Application runtime

WingLog is distributed as an [Electron](https://www.electronjs.org/) application.
Electron is MIT-licensed and embeds Chromium and Node.js, which carry their own licences;
electron-builder includes Electron's own licence files in the packaged application
alongside this document.

Airline logos shown in the interface are fetched at runtime from a third-party image
service and are not redistributed with this application. They remain the property of the
respective airlines.

