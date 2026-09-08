# Changelog

All notable changes to SeisConv are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.1] - 2026-09-08

### Changed

- **The 0.8.0 entry below states that AGC and Equalise traces (RMS) hide a weak
  or dying geophone, and that is wrong.** The entry is left standing below as
  published, and corrected here in the open rather than edited away. A dying
  element loses signal and keeps its noise floor. Both laws divide each trace
  by that trace's own level, so on a failing channel it is the noise floor that
  gets stretched toward full scale: the channel does not go quiet under them,
  and it is not painted as healthy. What the two laws actually destroy is the
  amplitude evidence. After either of them, brightness cannot compare one
  channel against another in any direction, and only the per-trace attribute
  profile, measured on the stored samples, still carries that information. The
  wording has been corrected in every place the product made the claim: the
  gain-law note under the picker and the display-state strip in the File
  Viewer, the Attributes and Trace Workbench Scale tooltips, the in-app manual
  and the generated `MANUAL.md`, the getting-started chapter of the PDF manual,
  the README, and the source comments in the renderer and in
  `core/dsp/gain.ts`.

### Fixed

- **The per-trace attribute profile was painted into a box 3.6 times taller
  than the picture drawn inside it.** The strip renders a 172 px tall bitmap
  and its own rule set that height, but the generic `.canvas{height:60vh}` is
  declared later in the same sheet at equal specificity and therefore won.
  Measured on a 1180 px window: a 1476x172 bitmap stretched into a 1478x619
  box, so every line, dot and label in the panel was drawn 3.6 times too tall.
  A more specific `canvas.sec-attr` selector now wins and the strip draws 1:1.
  Nothing about the drawing itself changed.
- **A run of one or two measured traces in the attribute profile read as a
  broken line, or disappeared from the panel altogether.** A single value drew
  as a 1.8 px square and a pair as a bare dash, so a genuine isolated
  measurement looked like a stroke fault rather than a reading. Such a run is
  now ringed, and only where the scan bounded it, so a sampling gap in a
  1-in-N scan is not dressed up as an isolated measurement. Separately, below
  the trace density at which individual dots can be drawn, the dot pass was
  skipped entirely; an isolated value is a move with no line after it and
  strokes nothing, so a trace that WAS measured left no pixels at all in the
  panel whose whole purpose is to show a channel misbehaving. Short runs now
  collapse to one mark per pixel column, drawn as a bar from the lowest to the
  highest value that landed in that column, because at that density the
  outlier is the entire reason to look at the panel.

## [0.8.0] - 2026-09-08

A viewer release. The theme running through it is that a picture of seismic data
is a claim about that data, and the display was previously free to make claims
nobody could check: it could hide a dying geophone, close a spread gap up, or be
screenshotted with no record of the settings that produced it.

### Added

- **Six display gain laws, with Seismic Unix `sugain` semantics and in SU's own
  order:** None (true amplitude), Fixed gain, Time gain t^n, Exponential time
  gain, Amplitude compression, and Equalise traces (RMS). This exists because
  the viewer previously offered only the two extremes, a flat multiplier and
  AGC. AGC normalises every window of every trace to the same level, so a weak
  or dying geophone is painted exactly as healthy as a good one, which is fatal
  for spread QC. The time laws apply a correction that depends only on time and
  is identical on every trace, so late arrivals brighten while the relative
  amplitude between channels survives and a bad channel still reads as bad. The
  picker states in plain words what the selected law does, and says outright
  that Equalise hides a weak geophone.
- **Nine colour maps, up from four.** Viridis is now matplotlib's full 256-entry
  table; the previous one interpolated in a straight line between the two ends of
  that table, so it was not viridis at all and had none of the perceptual
  uniformity that is the whole reason to use it. Added Crameri's `berlin` and
  `vik` perceptually uniform diverging maps, where equal steps in amplitude look
  like equal steps in colour and zero sits at one unambiguous centre, and two
  positive-black greys for the paper-section convention. Every table's source is
  cited beside it, and matplotlib's `berlin` was compared entry by entry against
  Crameri's own file as a provenance check.
- **A colour-vision check**, using the Machado, Oliveira and Fernandes (2009)
  simulation matrices. About one man in twelve has a colour deficiency, so a
  section that only works in full colour is a real limitation. Offered as a
  snapshot you open and close rather than a display mode, because it is a check
  on the picture, not a way of reading data.
- **Near-trace (common-offset) gather.** Every viewer in the app showed one
  record, so a source degrading slowly down the line, or coupling that worsens
  as the crew moves, was invisible. This takes one chosen channel out of every
  record in the open file's folder and draws them side by side, one column per
  record. It obeys the File Viewer's own display controls rather than
  duplicating them, lists every record that contributed no column together with
  the reason, and names the grid it resampled onto when a folder mixes sample
  intervals. Driven across all 116 records of a real field folder.
- **Reduced time**, following Seismic Unix's `sureduce`: shift every trace by
  its offset divided by a reducing velocity, so refracted first breaks flatten
  into a straight horizontal line. Against a straight line a timing slip or a
  station planted at the wrong stake reads as an obvious step, where on the raw
  hyperbola it is a kink that is easy to miss. The shift is interpolated rather
  than rounded to the nearest sample, because rounding would inject up to half a
  sample of fake step into the very line being read.
- **Trace spacing by a geometry header** (offset, channel, shotpoint or CDP).
  The section positioned trace i at even spacing by array index, so a spread
  gap, a dropped station or a channel that never reached the file was silently
  closed up and the record looked perfect. Positioned by its own header value,
  the gap is drawn as a gap. There is deliberately no "Station" option: the
  SEG-Y fixed trace header carries no receiver-station field, and relabelling
  the channel number as a station would be a lie.
- **Per-trace attribute profile:** peak, RMS and a separate pre-first-break
  noise RMS, drawn under the section on its own trace axis and printed for the
  hovered trace. These are numbers that do not depend on the display
  normalisation, which is the point, since per-trace scaling and AGC are exactly
  what hide a weak channel. They are the trace-health scan's own evidence read
  back out, not a second computation that could disagree with it.
- **A raw scale basis**, where full scale is the sample value itself. It is the
  only basis under which an absolute amplitude claim is defensible.
- **A display clip percentile and a wiggle excursion control**, and a colour bar
  that follows the map actually in use. The bar previously hardcoded one map, so
  on a Seismic or Gray panel it disagreed with the picture it was explaining, and
  the primary Variable Density display carried no bar at all, so a colour there
  could not be turned back into a number.
- **A permanent display-state strip on every viewer**, stating the whole
  transform chain between the stored samples and the pixels: mode, polarity
  flip, reduced time, trace spacing, colour map, AGC, gain law, scale basis,
  clip and the sample value at which the picture saturates, and how much of the
  record the display flattened. It also reports the file's declared SEG-Y
  impulse polarity in the standard's own words rather than as "normal" or
  "reverse", terms that mean opposite things in different parts of the world.
  With the strip in the frame, a screenshot is a QC record instead of an
  unlabelled assertion.
- **Display-only polarity flip** beyond the Trace Workbench, so a channel
  suspected of being wired in reverse can be checked without touching the stored
  samples or anything Convert writes.
- **A Scale control on the Trace Inspector**, computed over the whole trace, so
  zooming no longer renormalises the picture and two zoom levels can be
  compared.
- **Save the display on screen as a PNG**, on the File Viewer section, the Trace
  Inspector, the Trace Workbench, the Velocity panel, the whole Spectrum family
  and the near-trace gather. A screenshot of a seismic panel is only defensible
  as evidence if it says what was done to the data, so the export is the panel's
  own redraw rather than a crop of the window: the display-state strip, both
  axes with their labels and units, and the colour bar all come out of the same
  code that drew them on screen, at three times the screen resolution, with a
  footer carrying the file name, the panel's name and the time of export. PNG
  only, because the wiggle modes draw one-pixel lines and a lossy codec rings
  around those edges in a way that reads as data.
- **The SPS survey grid can be saved as an image too.** Every other data canvas
  in the app could already do it, and a map that cannot say which survey or
  which projection it shows is not evidence, so the grid's footer states the
  survey's station and line counts, the layout, the coordinate system the
  eastings and northings are in, the bearing the picture is turned to, which
  layers are actually plotted, and any load flags. A fold heatmap and a station
  plot of the same survey look nothing alike. Grid view only: the map view is a
  web map, not a canvas.
- **Reset display**, one button that puts every display setting back to the
  state a freshly opened file shows and fits the view with them: mode, colour
  map, gain law and its exponent, dB gain, AGC with its window and statistic,
  clip, excursion, scale basis and its percentile, trace spacing, reduced time
  and its velocity, and the display-only polarity flip. Display settings now
  survive paging through a folder, which is what comparing records needs, but
  that removed the accidental reset an open used to give for free; this is the
  missing half. The defaults are read from each control's own default rather
  than retyped elsewhere, so the button and the opening state cannot drift
  apart. There is no confirmation question: the action is undoable from the
  toast for a few seconds, which is cheaper than a question in front of every
  press. Health flags, first-break picks and which record is on screen are
  deliberately untouched, being annotation and navigation rather than display.
- **Keyboard shortcuts for the File Viewer display controls.** The controls had
  grown past what a trackpad in a truck is good for and none of them had a key.
  PageUp and PageDown page the block of traces, `F` fits the record, bare `+`
  and `-` zoom the data (Ctrl `+` and Ctrl `-` still zoom the whole interface,
  unchanged), `A` toggles AGC, `M` steps the display mode, `C` steps the colour
  map, `D` shows and hides the Display panel and `R` resets it. One table drives
  the handler, the tooltips and the manual together, so each control's tooltip
  names its own key and the in-app manual lists them all, and a rebind cannot
  leave a stale hint anywhere. Every key works the existing control, so a key
  and a mouse click do the same thing and a disabled control still does nothing.
  Nothing fires while the focus is in a text box.
- **The vibratory polarity the file declares is now stated**, not just the
  impulse polarity. The SEG-Y field had been decoded, carried through the worker
  and shown in the file summary, but it never reached the display-state strip,
  so a reader looking at a vibrator record saw only half of how the recorded
  numbers relate to the ground. It is now a clause on the same sentence as the
  impulse polarity, because that is one fact, and it is written as the wedge in
  plain English rather than as a raw code: code 3 reads that the seismic signal
  lags the pilot sweep by 67.5 to 112.5 degrees. A file that never filled the
  field in reads as unknown, exactly like the impulse code, and a format with no
  vibratory field at all says nothing rather than being made to look silent
  about a field it never had.

### Fixed

- **The first velocity pick landed about five pixels from the click.** Adding
  the first row to the pick list made the panel need a scrollbar, the scrollbar
  took ten pixels of width, and every canvas below it reflowed narrower, so the
  semblance image moved sideways under the cursor. Later picks were fine,
  because the scrollbar was already there. The stored velocity was always
  correct; it was the picture that moved.
- **A pan on the velocity panel planted a stray pick**, and a double-click
  placed a pick and then asked to delete it instead of fitting the view. Picks
  are the whole output of that panel, so a drag that silently created one was a
  data-quality problem.
- **The Trace Workbench aligned collected traces by sample number, not by
  time.** The bench exists to compare traces from different files, so the
  collection can mix sample intervals, and a 1 ms trace and a 0.5 ms trace
  drifted apart by half the elapsed time, growing with depth, which is exactly
  where first breaks are compared. A comment claimed the opposite.
- **The saturation level was reported ten times too high at +20 dB.** The
  colour bar and the state strip inverted the display mapping without dividing
  by the display gain, so both quoted a sample value that did not saturate.
- **The SEG-Y binary header's impulse-polarity bytes 3257-3260 were never
  decoded**, so the one polarity statement the file itself makes was not
  available to report.
- **Each gain law now keeps its own exponent.** The shared exponent box decided
  which law it belonged to by testing whether its value fell inside that law's
  range, and the ranges overlap, so switching from Time gain to Exponential
  silently gave exp(2t) where the picker promised exp(1t), and returning to Time
  gain destroyed the exponent the user had set.
- **The axis-range boxes reported an amplitude range of "0" to "0"** on data
  that actually ran from 0 to about 2.8e-4. The edges were rounded to two
  decimals, which erases any amplitude below 0.005 and tells a field engineer
  the range is zero. They now follow the same convention the state strip and the
  hover read-out already used: two decimals from 1 upward, three significant
  digits below 1, exponent form below 1e-3.
- **Click-to-add picked the trace next door.** The cursor was read back through
  a second rounding step instead of through the inverse of the map the painter
  actually uses, so the right half of every trace's column band resolved to the
  next trace, and on a section zoomed out far enough to be drawn decimated it
  could name a trace that was never on screen at all. The hover read-out, the
  first-break seed and drag placement and the '+ Workbench' click now share one
  answer with the pixels.
- **Paging through a folder threw the view away.** The File Viewer re-fitted and
  cleared the axis boxes on every refresh, so stepping Prev/Next through a
  hundred records meant re-zooming a hundred times, which defeats the point of
  comparing them. The window now survives navigation and is reset only where it
  was asked for, on a fresh Open and on Clear. Because the next record can be
  shorter, a kept window is never restored blind: it is clamped to the traces
  and samples that record really has, and the label says what had to be done,
  including when nothing usable survived and the view fell back to a fit.
- **A typed axis range kept overriding the zoom that came after it.** Typing a
  range, then wheel-zooming, then paging to the next record snapped back to the
  typed numbers. A typed range now applies when it is typed and stops overriding
  afterwards, and the boxes are refilled with the window actually painted, so
  they can no longer show a range the display is ignoring.
- **The Trace Inspector, Spectrum and Velocity panels threw their view away
  too**, so the same comparison could not be made twice. The Inspector's time
  window now survives stepping traces and stepping files, carried in
  milliseconds so that it means the same time on a trace with a different sample
  interval. Spectrum and Velocity keep their windows in physical units, which
  mean the same thing on the next record, clamped to what the new data cover.
  Amplitude still re-fits per trace on purpose: the Scale control is what makes
  amplitude comparable, and a raw amplitude window pinned on one trace would
  clip a stronger neighbour.
- **On a header-spaced section the wiggles were scaled to the average trace
  spacing**, not to the neighbour each trace actually has. Where offsets bunched
  up the wiggles overlapped into a blob, and where the spread opened out they
  shrank to threads, so the display was least readable exactly where the
  geometry was most irregular. The excursion now follows the distance to the
  nearest distinct neighbour, read off the same positions the forward map and
  the hit test share. It stays symmetric about the trace, because a different
  width to the left and to the right would draw a peak and a trough of equal
  sample value at different widths and the waveform shape would depend on where
  the neighbours sit. Nothing moves on an evenly spaced record.
- **The display-state strip was cut off mid-word**, so it could read as a code
  with its meaning severed, and on some records a whole clause vanished with no
  sign it had ever existed. A half sentence looks like information and is not.
  The strip now drops whole trailing clauses rather than trimming characters,
  and says how many it dropped, so whatever is on screen is always a complete,
  true statement. On a panel that can be saved as an image the count points at
  the export, which reprints in full every line the screen had to cut; on a
  panel with no image export it says instead that widening the window will show
  them, which is the only recovery a reader there actually has. Long
  single-sentence warnings were split into clauses that can stand alone for the
  same reason, so the near-trace gather's resampling warning and the attribute
  profile's caveat now survive on a narrow window instead of disappearing whole.
- **A double-click on the SPS survey grid placed a pick.** The click handler
  fired on both clicks of the double-click before the fit ran, so fitting the
  view opened the station inspector on the way. This was the same defect the
  Velocity panel had.
- **Export file names now go through the same sanitiser as the conversion
  paths.** The image and spreadsheet exports passed their name straight to the
  save dialog, while the converter ran its output names through a sanitiser
  first, so control characters and bidirectional override characters were not
  stripped there. Not exploitable, since the destination directory comes from
  the native dialog and the final name is shown before anything is written, but
  it broke the naming discipline the rest of the app follows. The extension is
  reattached verbatim, so the enforced suffix is untouched.

### Changed

- **One interaction model on every data canvas:** cursor-anchored wheel zoom,
  drag to pan and double-click to fit, with one shared zoom step. Five separate
  implementations had drifted apart, leaving the Spectrum with no pan and no
  fit, the Velocity panel with no pan at all, and the Sweeps plots with no wheel
  zoom. Each viewer keeps its own zoom arithmetic, clamp and fit; only the
  plumbing is shared.
- Time axes are labelled at round numbers on every panel, and timestamps are
  written in one unambiguous format with the UTC offset.
- The File Viewer toolbar was compacted so the section itself starts higher on
  the page, and the display controls moved into a panel that only needs to be
  open while they are being changed, because the state strip reports them
  permanently.
- The SPS survey grid was the last data canvas with its own pan and zoom
  listeners, with its own wheel factor, its own drag guard and its own
  double-click fit. It now goes through the same interaction plumbing as every
  other canvas and inherits the shared zoom step and the shared
  click-versus-drag guard. Only the plumbing is shared: the grid keeps its own
  transform, and its zoom stays uniform in x and y on purpose, because it is a
  map of ground positions.
- **Colour mapping no longer allocates per pixel.** Every colour map returned a
  fresh three-element array for each cell, and at the section's size cap that is
  four million short-lived arrays per redraw, on a machine that is often a
  laptop in a field vehicle. Each map is now written once as a function that
  puts the colour straight into the destination buffer, with the readable
  per-value API a thin wrapper around the same code so that the two cannot
  drift. Measured at the 2000x2000 cap over three redraws: 234 ms per redraw
  down to 43, and 409 garbage collections down to 6, five of which are module
  load. The output is byte identical.
- **The Trace Inspector no longer re-sorts the whole trace on every pan tick.**
  Its default scale basis is computed over the whole trace, so it cannot change
  while the time window moves, yet it was recomputed twice on every mouse move
  of a drag. The whole-trace bases are now remembered against the samples they
  were computed from, while the window-dependent basis stays live because it
  genuinely does move with a pan. Measured over a 40-move drag on a real record:
  80 recomputations before, 0 during the drag after.
- **Real dataset names and local machine paths were removed from the repo.** The
  QA harness, the core test runner and the developer scripts carried the owner's
  own corpus in their fallback values, which is on this project's own forbidden
  list. All of them now resolve their inputs through an environment variable,
  then a git-ignored local configuration file, then a generic placeholder under
  a data root that no longer defaults to anybody's disk.
  `qa/local-paths.example.json` is the file a contributor copies, a missing
  input names its own key and the three ways to point it at real data instead of
  failing as though a format were broken, and an unconfigured machine states a
  skip rather than reporting a false pass.
- The documentation was brought back in line with the product. The README
  claimed four colour maps and described the gain as a slider plus AGC, both of
  which were false, and neither it nor the in-app manual mentioned any of the
  work above.

## [0.7.13] - 2026-09-03

### Fixed

- **A file recorded in the standard 24-bit SEG-D format was decoded as 20-bit.**
  Format code 8036 is the code SEG-D defines for 24-bit two's-complement
  demultiplexed samples, and it was falling through to the 20-bit branch. The
  samples came out wrong, with no error and nothing to indicate anything had
  happened. Non-standard vendor codes for the same thing were already handled;
  the standard one was not.

### Changed

- Every claim this project makes about a standard has been checked against the
  published document rather than from memory, and the source is now cited beside
  the claim. Five statements were wrong: a SEG-D revision 2.1 writer was
  advertised and does not exist, all SEG-Y revision 2 sample codes were claimed
  where five are decoded, the base scan interval was described as revision 1
  codes when every revision encodes it as a binary value, SEG-2 was called
  little-endian throughout when the standard takes byte order from the file
  descriptor block, and Seismic Unix big-endian was called canonical when the
  reference implementation writes host-native order.
- Two claims that could not be verified, because the documents are paywalled,
  are now marked as unverified instead of asserted: a detail of the IOGP P1/11
  version history, and the exact publication month of SEG-D revision 3.0.
- **The EPSG attribution now meets the dataset's terms of use.** It acknowledges
  IOGP ownership, states that a subset is incomplete without the elements
  Guidance Note 7-1 Annex A lists as essential, and passes on the obligation to
  inform anyone you give the data to. That is a licence condition, not a
  courtesy.
- The README credits the people whose real problems shaped this software, and
  names where that work happened, with an explicit statement that SeisConv is
  its author's own work and carries no institutional endorsement.

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
