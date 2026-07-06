# Changelog

All notable changes to SeisConv are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-07-05

### Fixed
- WiFiSync no-router hotspot **Stop** now works when there is no upstream internet connection.

### Security
- Hardened the elevated helper scripts (hotspot / firewall-port control).

## [0.5.1] - 2026-07-05

### Fixed
- WiFiSync hotspot **Stop** WinRT async-type error on Windows.

## [0.5.0] - 2026-07-05

### Added
- **WiFiSync** built-in tab - a native TypeScript re-implementation of the standalone WiFiSync tool: peer-to-peer file and data sharing over the local WiFi with zero-config LAN discovery, two-way or master/slave roles, per-file SHA verification, atomic and resumable transfers, a no-router Mobile-Hotspot mode (Windows), and a live activity / transfer-history log. Built on the same wire protocol as the original, so the two interoperate.

## [0.4.0] - 2026-07-05

### Added
- **Geometrics Geode** trigger system for Observer's Log - an extensible trigger-system registry so additional systems can be added later.
- SCS trigger **File# sync** - reconciles the log File# with the recorder's real file number.
- **Zoom** (wheel / box / drag-pan) on every Sweeps plot, matching the File Viewer.

### Fixed
- Observer's Log **XLSX export**.

## [0.3.0] - 2026-07-05

### Added
- Observer's Log **auto-numbering** - auto-advance SP and File# on shot trigger, with **Renumber-below** for stuck shots.
- **SCS trigger** Trigger-Watch source - one shot produces one log row.

## [0.2.0] - 2026-07-03

### Added
- **Sweeps** tab - vibroseis sweep designer and QC (sweep laws, phase-continuous segments, tapers, live plots, Klauder wavelet, exports, and designed-vs-measured QC).
- Assisted **NSIS installer** with install-directory choice (per-user by default, elevation option).

### Fixed
- SEG-D reader/writer spec conformance fixes.

## [0.1.0] - 2026-05-24

### Added
- Initial release: cross-platform Electron desktop app.
- Automatic format, revision, sample-encoding, and byte-order detection.
- Format support - SEG-Y (Rev 0/1/2), SEG-D (Rev 2.1/3.0), SEG-2 / Geode `.dat`, Seismic Unix, tape image, and CSV export; single-file and batch conversion.
- Survey geometry - SPS 2.1, SEG-P1, IOGP P1/11, IOGP P6/11, and CRS-tagged coordinate CSV, with survey-grid + Leaflet map, QC checks, CMP fold map, and coordinate reprojection.
- Feature tabs - Converter, Trace Inspector, File Viewer, SPS, SPS Creation, Geometry QC, Velocity, Spectrum Analysis, and Trace Workbench.
- Streaming trace index for multi-gigabyte files; worker-thread parsing.

[0.5.2]: https://github.com/m0shiko8811-beep/SeisConv/releases/tag/v0.5.2
[0.5.1]: https://github.com/m0shiko8811-beep/SeisConv/releases/tag/v0.5.1
[0.5.0]: https://github.com/m0shiko8811-beep/SeisConv/releases/tag/v0.5.0
[0.4.0]: https://github.com/m0shiko8811-beep/SeisConv/releases/tag/v0.4.0
[0.3.0]: https://github.com/m0shiko8811-beep/SeisConv/releases/tag/v0.3.0
[0.2.0]: https://github.com/m0shiko8811-beep/SeisConv/releases/tag/v0.2.0
[0.1.0]: https://github.com/m0shiko8811-beep/SeisConv/releases/tag/v0.1.0
