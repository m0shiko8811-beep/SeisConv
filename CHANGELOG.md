# Changelog

All notable changes to SeisConv are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.12] - 2026-09-03

### Fixed, and these produced wrong coordinates

Six defects in the coordinate engine, every one of them silent. Each was verified
against PROJ driven with SeisConv's own registry parameters, so a disagreement could
only be our arithmetic.

- **Inverse UTM ignored the southern hemisphere.** A station at 24 degrees south came
  back at 66 degrees north, about ten thousand kilometres away. The forward direction was
  correct, so a round trip inside SeisConv never revealed it, and every test in the suite
  hardcoded the northern hemisphere. It reached the reprojection, the KML and shapefile
  exports, the GeoTIFF raster and the P1/11 export.
- **The linear unit was ignored**, so grids in feet returned metres. A false easting of
  700,000 feet came back as 213,360. This affected 499 supported grids.
- **UTM assumed the WGS 84 ellipsoid** whatever the datum said, worth 53 metres across
  1,227 grids.
- **The inverse applied no datum tie while the forward did**, a 408 metre round-trip
  error on every UTM grid not on WGS 84.
- **Rotation-only datum transforms were discarded** by a screening test that only looked
  at translation, worth about 190 metres on the Saudi Arabian grids.
- **The prime meridian offset was ignored**, worth about 615 kilometres on grids
  referenced to Oslo.

The cause in every case was the same: two implementations of one idea that disagreed,
and a dispatch that shortcut to helpers which only ever understood WGS 84. Both
directions now resolve the ellipsoid, the datum tie, the linear unit and the prime
meridian through one path, so they cannot drift apart again. A golden fixture built from
PROJ pins eighteen cases; that dispatch previously had no external reference at all.

- A coordinate scalar that cannot represent the survey no longer clamps every coordinate
  to the 32-bit maximum in silence. It steps back to the largest scalar that fits and
  says so.
- The SEG-Y writer declares the padded sample count, so a file with unequal trace lengths
  no longer desynchronises readers, including our own.
- The SEG-Y writer emits receiver elevation, surface elevation and source depth, which it
  had been dropping while still writing the elevation scalar beside them.

### Fixed, field and interface

- **The observer log froze for about half a second on every shot.** At a production day's
  scale it rebuilt roughly ninety thousand elements each time a row arrived. It now
  reconciles the table instead: measured 450 to 533 ms before, 3 to 7 ms after.
- **A failed save is no longer hidden.** The log is saved on a debounce rather than on
  every keystroke, and if saving fails you get a persistent banner telling you to export
  now, instead of the failure being swallowed and the log quietly ceasing to persist.
- **WiFiSync no longer trusts any machine on the network.** A peer must be approved once,
  and the shared folder must be one you actually chose. A remote peer cannot delete your
  local files at all unless you explicitly allow it.
- Peer-supplied text is no longer interpolated into the interface as markup, and reads
  from a peer are bounded.
- Filenames are sanitised against control characters, bidi overrides and over-long names,
  which previously made an entire batch fail and allowed a file to display with a
  different extension than it has.
- Trace-health threshold sliders are throttled like the gain slider beside them, and
  survey QC no longer rescans a whole receiver line for every cross-reference record.

### Fixed, found after the release was cut

- **The hotspot shipped with a hardcoded default password.** The repository is public and
  the string was compiled into the installer, so every SeisConv hotspot left on defaults
  had a password anyone could look up. There is now no default: the field is empty, and
  starting without a usable password fails with a message that says what to do. A settings
  file still carrying the old value is migrated to empty rather than quietly kept.
- **The interface size control was undiscoverable.** The zoom already existed, persisted,
  with buttons and keyboard shortcuts in the status bar, but nobody found it. It now has a
  slider, reads as "UI size", is styled as a control rather than as another read-only
  status field, and is documented in the Help for the first time. It is the same
  mechanism, not a second one.
- **Above roughly 200 percent zoom the status bar was clipped off the bottom of the
  window**, so the only mouse route back out of zoom disappeared. Someone who zoomed in
  too far to read the interface had no way back without knowing the keyboard shortcut.

### Changed

- Electron moves from 39 to 44.1.1, clearing the last published advisory. `npm audit`
  reports zero.

## [0.7.11] - 2026-09-02

### Security

- **Electron updated from 33 to 39.8.10**, which clears 32 published advisories that were
  shipping inside the installer, seven of them rated high. The three that mattered most for
  SeisConv were a context-isolation bypass, a sandboxed iframe escaping the allow-popups
  restriction, and a custom protocol permitting cross-origin reads. SeisConv opens files it
  did not create, and the sandboxed renderer is the boundary that keeps a malformed or
  hostile file from reaching the machine, so a hole in that boundary matters more here than
  the severity rating alone suggests.
- The upgrade required no source changes. Context isolation, the disabled Node integration,
  the sandbox and the `default-src 'none'` policy are all unchanged, and were re-checked at
  runtime rather than only in configuration: in the live renderer `require`, `process`,
  `module`, `global` and `Buffer` are all undefined and the preload bridge is the only
  object exposed.
- electron-builder moved to 26.15.3, the first line carrying the fixed archive-handling
  dependencies. Build tooling advisories dropped from 19 to 2, and both survivors are
  install-time only and are not present in the shipped application.

## [0.7.10] - 2026-09-02

> The 0.7.x releases were developed through July 2026 and first published together on 2 September 2026, which is the date this entry and `CITATION.cff` both carry. The dates on 0.7.9 and earlier are their development dates.

### Added
- **The SPS 2.1 export now carries a matching `.prj`.** The SPS triplet is written with an ESRI WKT projection file named after the data file (`survey.s` / `survey.r` / `survey.x` -> `survey.prj`), so the exported points drop straight onto a map in QGIS, ArcGIS or Global Mapper already georeferenced - an SPS header states its CRS in a vocabulary no GIS reads, and the `.prj` says the same thing in the one they all do. That export is already delivered as a ZIP, so the sidecar costs the user nothing. Generated surveys (SPS Creation -> Generate) and the direct SPS 2.1 export both get one.
- The other three positioning formats are **single files and stay single files** - a `.prj` beside them would silently turn "save a .csv" into "save a .zip". They state their CRS inside the file itself instead: coordinate CSV writes a `# CRS:` comment tag, IOGP P1/11 writes an `H,CRS` header record, and SEG-P1 writes an `H GRID: <projection> ... DATUM <datum>` header line.
- A survey whose CRS is unknown, or whose projection cannot be described honestly in WKT, is given **no** `.prj` with its SPS export rather than a guessed one - an absent `.prj` reads as "CRS unknown" to every GIS, which is far safer than a plausible-looking projection that is not the one the coordinates are in.

## 0.7.9 - 2026-07-28

### Fixed
- **The SPS geodetic-datum record claimed WGS 84 for grids that are not on it.** H12 was hardcoded to `WGS 84 GRS 1980` for every Transverse Mercator and UTM grid, so an Israeli-grid survey, a British National Grid survey and an RD New survey all announced themselves as WGS 84. It also contradicted the next record: H14 carries the seven-parameter shift **from** the grid's own datum **to** WGS 84, and a grid already on WGS 84 would not need one. H12 now states the CRS's real datum - `WGS 84` for EPSG:32636, `ISRAEL 1993` for EPSG:2039, `OSGB 1936` for EPSG:27700 - taken from the EPSG name rather than assumed. A processor handed one of these files is no longer told a datum-shifted grid is WGS 84.

## 0.7.8 - 2026-07-28

### Fixed
- **A GeoTIFF basemap could be downloaded from the wrong place on Earth, and came out a flat grey rectangle.** Positioning the map tiles needs the survey's projected coordinates converted back to lat/long. `Projection` carries two spellings of the same parameters - the SPS parser fills `centralMeridian`/`latOrigin`/`scaleFactor`/`falseEasting`/`falseNorthing`, an EPSG registry entry fills `lon0`/`lat0`/`k0`/`FE`/`FN` - and the inverse conversion read only the first set. A projection built from an EPSG entry therefore degraded silently to a NULL projection: central meridian 0, false easting 0, false northing 0. An ITM survey coordinate at E=131120, N=568036 resolved to lat 5.14, lon 1.18 - the Gulf of Guinea - so the export downloaded ocean tiles and wrote them into the file. **UTM was unaffected** (that branch keys off the zone number); **every Transverse Mercator grid was affected**, including ITM (EPSG:2039), British National Grid and RD New. Both directions now accept either spelling, pinned by two regression tests.
- **The survey-plan importer never asked which CRS to generate in when the file was lat/long.** It hid the CRS picker for geographic input and silently chose one from the location, so a lat/long CSV of an Israeli survey came out in ITM even when UTM 36N was wanted. The picker is now shown for both coordinate kinds - "the CRS these easting/northing values are in" for projected input, "the CRS to generate the survey in" for geographic - and an explicit choice always wins over the location guess.
- **The GeoTIFF wizard offered resolutions with no relationship to the data.** A fixed 5 units/pixel default and a warning only about pixel COUNT let an export be set to 0.03 units/pixel on a survey with a 30-unit station interval - 998 pixels per station - producing a 3 GB raster that is 99.9 % background. The wizard now seeds the resolution from the survey's own median station spacing, states plainly when the chosen one is far too fine or too coarse and what to use instead, and offers a **Use recommended** button.
- **Blank provider tiles are no longer baked in silently.** A tile server asked for a zoom it has no imagery for answers 200 OK with a flat placeholder. Those are now detected and reported ("BASEMAP HAS NO IMAGERY ... export at a coarser resolution"), instead of the export completing with a featureless basemap and nothing to explain it.

### Changed
- **The GeoTIFF basemap download now reports itself.** Fetching map tiles ran behind a fixed indeterminate sweep with no numbers at all, so a large export was indistinguishable from a hang. It is now a real progress bar - percentage complete, tiles done out of tiles needed, bytes downloaded, and the live download rate: `1 / 56 tiles · 13 KB of ~739 KB · 4.2 KB/s`.
- The total size is written with a `~` because it is an **estimate** - a tile server publishes no manifest, so it is derived from the average size of the tiles fetched so far. The `~` and the rate both disappear when the download ends and the figure becomes measured, at which point the label switches to *Resampling basemap into the survey CRS…* so it is clear the remaining wait is local work, not the network.
- A tile that fails after its retries still advances the bar (and is counted separately), so a partial download can no longer stall the bar short of 100 % and look stuck.

## 0.7.7 - 2026-07-28

### Changed
- **A survey plan restored from the last session now says so.** 0.7.6 reloaded an unfinished plan silently, so points appeared on the SPS Creation map with no explanation of where they came from - indistinguishable from a bug. The plan is still restored (it can represent real work), but the first time the tab is opened it fits the map to it and announces `Restored your last survey plan - N points` with a one-click **Discard**. Nothing appears on that map that the user did not put there without the app saying where it came from.

## 0.7.6 - 2026-07-28

### Added
- **Import a survey plan into SPS Creation.** A column-mapping wizard reads CSV, TSV and GeoJSON: it sniffs the delimiter (comma, tab, semicolon or whitespace), detects whether the first row is a header, guesses which column is the line, the station, the coordinates and the elevation, and lets you correct every one of those guesses against a live preview. Rejected rows are listed with their physical line number instead of being dropped silently.
- **Both coordinate forms, auto-detected.** Lat/long and projected easting/northing are recognised from the values, not from the column names, so a mis-labelled header cannot silently misplace a survey. A `# CRS:` tag in the file selects the CRS on its own; projected data with no tag asks for one and refuses to import until it has it.
- **Imported stations are used exactly as given.** A pre-plot keeps its own station numbers and its own positions - nothing is re-sampled. Where the file's projected coordinates are already in the CRS being generated, they are written through untouched rather than round-tripped via lat/long. Hand-drawn lines keep the previous behaviour: they are vertices, and stations are laid along them at the acquisition interval. Each line shows which of the two it is.
- **The plan is now editable.** Drag a station on the map, edit line, station, latitude, longitude and elevation in a table, reorder or delete points, renumber a line 1..N, sort by station, and fit the map to the plan. Undo covers every one of those, 50 steps deep, and the plan survives a restart.
- **The map shows the geometry, not just the points**: direction arrows per segment, the distance on each segment, numbered station markers, and an independent visibility toggle plus opacity slider for the basemap, the connection lines, the arrows, the labels and the stations. Clicking a station reports its line, number, lat/long, projected E/N, elevation, distance from the line start, distance from the previous station and azimuth. Wheel sensitivity is selectable.
- **Plan-level checks before generation** - duplicate station numbers within a line, duplicate line names, irregular intervals against the line's own median, coincident stations, non-monotonic numbering, missing numbers on a pre-plot, gross positional outliers and implausible elevations. Errors block Generate and name what to fix; a station number repeated across two different lines is reported as information, because SPS numbers are per line.
- **Export the plan itself** as CSV, GeoJSON or KML, before it becomes a survey. The CSV carries the per-segment distance and azimuth and re-imports through both this wizard and the SPS tab.

### Fixed
- **A coordinate CSV written in lat/long parsed to nothing.** The reader accepted `lat` / `lon` column names and mapped them, but the row parser only ever read easting/northing, so every row of a geographic CSV landed in the skipped count and the survey came back empty. Geographic files are now projected into the CRS named by the file's tag, or into the WGS84 UTM zone of their first point when there is no tag - and it says so rather than doing it silently.
- **The 3D wizard's source-line spacing and azimuth never reached the generator.** Both are collected in the wizard and both are read by the worker, but the main process built the worker message field by field and omitted them, so every 3D survey was generated with the default 300 m spacing and an auto-derived bearing no matter what was entered.

### Testing
- `spscreate` had no QA coverage at all. The harness now exports the loaded survey as a real coordinate CSV and imports it straight back through the new wizard, asserting the column guess, the projected-coordinate detection, the CRS adoption, the row count, the table's virtualization, the legend and that the map overlay actually drew. 12/12 steps.
- 56 new unit tests across the CSV/GeoJSON reader-writer, the plan checks, the verbatim generator and the geographic-CSV fix.

## 0.7.5 - 2026-07-21

### Fixed
- **GeoTIFF elevation search radius is derived from the survey, not the rendering.** It defaulted to eight pixels, so asking for a finer resolution shrank the filled area - backwards. It now comes from the median nearest-neighbour station spacing.
- **Station spacing is measured within each record class.** Sources and receivers occupy the same stations, so measuring across both returned the source-to-receiver offset (0.5 m on a production line) rather than the station interval (1.9 m), making the derived radius an order of magnitude too small.
- **Layout markers scale with resolution.** A fixed 1 px marker was invisible on a fine grid; markers now scale with spacing over pixel size, clamped to 1-8 px.
- The positioning-format export picker writes its result to its own status line instead of the one belonging to the older export buttons.

### Changed
- The elevation and layout layers now report what they actually produced - station spacing, search radius, percentage of pixels filled, marker size - and a surface under 5 % filled says so explicitly and names the control that widens it.

### Note
- A sparse elevation surface is not always a fault. A single-line survey inside a square extent leaves most of that extent legitimately far from any station, and the app does NOT extrapolate into it: inventing terrain between lines would produce a client deliverable indistinguishable from measured data.

## 0.7.4 - 2026-07-21

### Added
- **Any-to-any positioning export.** A single *Export as* picker in the SPS tab writes the loaded survey out as **SPS 2.1**, **SEG-P1**, **IOGP P1/11** or **coordinate CSV**, whichever format it was imported from. Import already accepted all five supported formats through one dialog, so the two sides now match.
- SPS 2.1 is exposed as a direct export choice for the first time - the writer existed but was only reachable through *Export reprojected* or the Header Editor save.

### Note
- IOGP P6/11 remains import-only, deliberately. It defines a bin grid (origin, rotation, bin size, inline/crossline numbering), not a point survey, so it cannot be produced from source/receiver geometry.

## 0.7.3 - 2026-07-21

### Fixed
- **Exports stopped working after the first one, and nothing was written.** The audit log asks for a signature the first time an action is recorded, and it did so 500 ms later by opening the full-viewport audit modal - which landed on top of whatever dialog was already open. From then on every click went to that invisible overlay instead of the button underneath, so the GeoTIFF wizard (and any other dialog) appeared dead and produced no file. The prompt now waits until no other dialog is open before asking.

## 0.7.2 - 2026-07-21

### Fixed
- **GeoTIFF basemap tiles are retried before being given up on.** A single dropped request used to leave a permanent white hole in the exported image - it looked cut off - and the only warning was one line of text in a label behind the wizard. Each tile now gets up to 3 attempts with backoff, which resolves the transient throttling and 5xx responses public tile servers return under concurrency.
- When tiles genuinely cannot be fetched, the note now states the count, the percentage and that those areas are BLANK, and the wizard shows that warning in its own status line instead of only behind it.

## 0.7.1 - 2026-07-21

### Added
- **SEG-P1 export** - write an SPS 2.1 survey out as a SEG-P1 point file. Previously read-only, because IOGP deprecated the format in favour of P1/11; added because legacy processing packages still require it. Grid fields are integer decimetres, which the 8-column field width forces (a UTM northing in decimal metres does not fit). Projected easting/northing with blank lat/long. A station too large for the fixed fields is omitted with a stated reason rather than truncated into a wrong position.
- **Invert** toggle in the Trace Workbench - flips trace polarity for display only; the collected samples are never modified, so exports stay as recorded. Works in both side-by-side and overlay, under auto scaling and a manual amplitude window.

### Fixed
- **Axis range boxes clipped their own contents.** They were 52 px, which cut off an amplitude such as -12345.6789 and even a time of 1000.5. Times now get 78 px and amplitudes their own 110 px. Affects the File Viewer and Trace Inspector too, since all three share the same control.

### Testing
- **Cross-format equivalence sweep** (npm run test:crossformat) - the same shots written by the acquisition system in four formats are decoded and compared sample for sample. 360 comparisons: SEG-D rev 2, SEG-D rev 3 and SEG-Y rev 2 are bit-identical; SEG-Y rev 0 agrees within IBM-float quantisation.
- **Malformed-input fuzz sweep** (npm run test:fuzz) - seeded mutation of real files plus hostile headers and text. 2,400 cases across six seeds: no parser throws, no unbounded allocations, no hangs, no prototype pollution.
- npm run test:all chains typecheck, test:core, test:fuzz, test:crossformat and qa.

## 0.7.0 - 2026-07-21

### Added
- **SPS to ESRI Shapefile export** - source and receiver point layers (`.shp` / `.shx` / `.dbf` / `.prj` / `.cpg`), zipped. PointZ geometry, so station elevation survives. "Native" writes the survey's own coordinates untouched with a `.prj` built from its H-records, which involves no coordinate arithmetic at all; choosing a CRS reprojects instead.
- **SPS to GeoTIFF export wizard** - drag the area on the map (or take the whole survey plus a margin), set the ground resolution in units per pixel with a live raster-size readout, then pick any of three layers: **CMP fold**, an **elevation surface** (inverse-distance weighted), and the **survey layout** as a georeferenced picture. Every layer shares one grid, so they stack pixel-for-pixel in GIS.
- **The full offline EPSG registry** - 6,983 coordinate reference systems replacing the previous hand-built list of ~135, searchable by code, by name, or loosely (`utm 36n`). Entirely offline, so CRS search works in the field. Both the reprojection and shapefile CRS controls are now search boxes over it.
- **Seven new projection methods** in the coordinate engine: Lambert Conformal Conic (1SP and 2SP), Mercator (variants A and B), Cassini-Soldner, Albers Equal Area, Lambert Azimuthal Equal Area, and Polar and Oblique Stereographic. With non-metre (feet) grids and non-Greenwich prime meridians, projected-CRS coverage rises from about 68 % to about 97 % of the dataset.
- CRSs the app cannot compute stay **listed and searchable** but are marked and refused with the reason - NTv2/NADCON grid-shift datums (OSGB36, NAD27), westing/southing axes, and the remaining projection methods. Native export still works for those and the `.prj` names the CRS correctly, so the receiving GIS can do the datum shift properly.
- **Basemap layer** for the GeoTIFF export - satellite (Esri World Imagery), streets (OpenStreetMap) or CARTO light/dark tiles, downloaded and **resampled into the survey's own CRS** so the imagery registers against the data layers instead of being pasted in as Web Mercator. Tile zoom is matched to the export resolution and capped at 256 tiles per export. Needs internet at export time.
- Basemap exports carry the provider's attribution in the GeoTIFF's `ImageDescription` **and** in an `ATTRIBUTION.txt` inside the ZIP, and the wizard states plainly that tiles are licensed for display and that redistributing them is the operator's call.
- `npm run gen:epsg` regenerates the shipped registry; `scripts/gen-golden-proj.py` regenerates the PROJ-derived golden test vectors.

### Fixed
- **SPS 2.1 point records read their non-coordinate fields at the legacy layout's column offsets**, which sliced digits straight out of the easting and northing and reported them as recorded field data - a real survey came back with an uphole time of 694 and a "date" of `94786.` taken from the easting `694786.9`. These columns feed the CSV export, so the bad values were already being exported. Now branched on the detected layout and read at the SEG SPS rev 2.1 spec columns.
- **The H19 projection-zone record could not be read back from the app's own output.** The zone was parsed only when the value *started* with digits, but `generateProjHeaders` writes `Zone 36, North`, so SeisConv could not re-read the header it had just written and the UTM zone silently fell back. The compact `36N` / `36S` wording is handled too. A wrong zone means a wrong central meridian, which misplaces the whole survey.

### Verification
- Projection maths is checked against **PROJ**: 580 points across 116 real EPSG CRSs agree to a worst 8 µm forward and 0.36 mm inverse. 48 of those points are frozen into `core/__tests__/golden-proj.ts` so the suite is self-contained.
- Shapefile and GeoTIFF output is read back with independent third-party readers (**pyshp**, **tifffile**, **GDAL/rasterio**) from files produced by the running app on real survey data.
- Core test count 239 to 279.

### Attribution
- Coordinate reference systems come from the **EPSG Geodetic Parameter Dataset**, © IOGP, redistributed under its terms of use with attribution. See the README and Help > SPS.

> **0.6.x** were internal builds and are not documented here; the public history
> jumps from 0.7.0 to 0.5.2.

## 0.5.2 - 2026-07-05

### Fixed
- WiFiSync no-router hotspot **Stop** now works when there is no upstream internet connection.

### Security
- Hardened the elevated helper scripts (hotspot / firewall-port control).

## 0.5.1 - 2026-07-05

### Fixed
- WiFiSync hotspot **Stop** WinRT async-type error on Windows.

## 0.5.0 - 2026-07-05

### Added
- **WiFiSync** built-in tab - a native TypeScript re-implementation of the standalone WiFiSync tool: peer-to-peer file and data sharing over the local WiFi with zero-config LAN discovery, two-way or master/slave roles, per-file SHA verification, atomic and resumable transfers, a no-router Mobile-Hotspot mode (Windows), and a live activity / transfer-history log. Built on the same wire protocol as the original, so the two interoperate.

## 0.4.0 - 2026-07-05

### Added
- **Geometrics Geode** trigger system for Observer's Log - an extensible trigger-system registry so additional systems can be added later.
- SCS trigger **File# sync** - reconciles the log File# with the recorder's real file number.
- **Zoom** (wheel / box / drag-pan) on every Sweeps plot, matching the File Viewer.

### Fixed
- Observer's Log **XLSX export**.

## 0.3.0 - 2026-07-05

### Added
- Observer's Log **auto-numbering** - auto-advance SP and File# on shot trigger, with **Renumber-below** for stuck shots.
- **SCS trigger** Trigger-Watch source - one shot produces one log row.

## 0.2.0 - 2026-07-03

### Added
- **Sweeps** tab - vibroseis sweep designer and QC (sweep laws, phase-continuous segments, tapers, live plots, Klauder wavelet, exports, and designed-vs-measured QC).
- Assisted **NSIS installer** with install-directory choice (per-user by default, elevation option).

### Fixed
- SEG-D reader/writer spec conformance fixes.

## 0.1.0 - 2026-05-24

### Added
- Initial release: cross-platform Electron desktop app.
- Automatic format, revision, sample-encoding, and byte-order detection.
- Format support - SEG-Y (Rev 0/1/2), SEG-D (Rev 2.1/3.0), SEG-2 / Geode `.dat`, Seismic Unix, tape image, and CSV export; single-file and batch conversion.
- Survey geometry - SPS 2.1, SEG-P1, IOGP P1/11, IOGP P6/11, and CRS-tagged coordinate CSV, with survey-grid + Leaflet map, QC checks, CMP fold map, and coordinate reprojection.
- Feature tabs - Converter, Trace Inspector, File Viewer, SPS, SPS Creation, Geometry QC, Velocity, Spectrum Analysis, and Trace Workbench.
- Streaming trace index for multi-gigabyte files; worker-thread parsing.

[0.7.12]: https://github.com/m0shiko8811-beep/SeisConv/releases/tag/v0.7.12
[0.7.11]: https://github.com/m0shiko8811-beep/SeisConv/releases/tag/v0.7.11
[0.7.10]: https://github.com/m0shiko8811-beep/SeisConv/releases/tag/v0.7.10
