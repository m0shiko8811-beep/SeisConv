# SeisConv Privacy Policy

Effective date: 2026-09-08. Describes SeisConv version 0.8.1.

SeisConv is a free, open source desktop application for converting and
viewing seismic data (SEG-Y, SEG-D, SEG-2, SU) and working with SPS survey
geometry, built by Moshe Fridin. **Your seismic data never leaves your
computer, except to another machine you control if you choose to send it
there yourself over your own local network with WiFiSync.** SeisConv does
not upload your files to any server, and does not transmit or share their
contents with anyone else.

## What SeisConv stores on your computer

SeisConv keeps its own settings and working data in its own per-user
application-data folder (on the direct-download build, `%APPDATA%\seisconv`;
the Microsoft Store build uses Windows' own per-app storage location for the
same files) - never anywhere else, never on a server:

- App preferences such as theme and zoom level.
- Your Observer's Log entries and saved templates, so a log survives closing
  and reopening the app.
- An in-progress SPS survey-plan draft, autosaved so it isn't lost switching
  tabs.
- WiFiSync settings - the shared folder path, the peers you've approved, and
  the hotspot name and password if you set one - stored as plain JSON in that
  folder.
- A local WiFiSync history (filename, time, size, and which peer) for your
  own reference.
- The result of the last manual "Check for updates" click (version, release
  notes, date), if you've ever run one.

None of this is sent anywhere. It is the only copy; SeisConv keeps nothing
elsewhere, and removing it later is a normal file or uninstall operation like
any other app's local data.

Files you explicitly convert or export (SEG-Y/SEG-D/SU conversions, SPS
files, GeoTIFF exports, log exports) are written only to the folder you
choose, through Windows' own save dialog.

## When SeisConv talks to the network, and why

SeisConv is built to work fully offline in the field. A handful of features
reach the network, only when you use them:

- **Interactive maps.** The real-map view in the SPS tools loads map tiles
  from Esri (ArcGIS Online) and OpenStreetMap as you pan and zoom, the same
  way any map works. This tells those providers which tiles you're viewing,
  i.e. roughly where in the world - nothing about your survey or your files.
- **GeoTIFF basemap export.** If you choose to bake a basemap into a GeoTIFF
  export, SeisConv downloads the needed tiles from the same providers to
  build the image, and writes their attribution into the exported file (see
  NOTICE for the providers' own terms).
- **Observer's Log clock sync.** The "Sync clock" button queries a public
  time server (`pool.ntp.org` by default, or one you choose) over standard
  NTP, purely to read the time offset. Nothing about you or your survey is
  sent.
- **Check for updates.** Clicking "Check for updates" in Help asks GitHub's
  public releases API for the latest published version and its release
  notes; nothing is downloaded or installed automatically, and nothing runs
  on its own - no startup check, no background timer. The Microsoft Store
  build of SeisConv contains no update-check code at all, since the Store
  handles updates itself.

## WiFiSync stays on your local network

WiFiSync lets two SeisConv installations exchange files directly, machine to
machine, over a shared Wi-Fi hotspot or local network, for a crew moving
files between a field laptop and a base laptop with no internet around. It
finds other copies of SeisConv on the same network and moves files only to
and from peers you have explicitly approved; an unapproved machine on the
same hotspot cannot list or read your shared folder. WiFiSync never reaches
the internet and never uses a relay or cloud server of any kind.

## What SeisConv never does

No telemetry, no usage analytics, no crash reporting, no advertising, and no
auto-updater that installs anything by itself. There is no user account, no
login, and no license server to phone home to. Because SeisConv does not
collect any personal data, there is nothing to retain and no data-access
request process to describe.

## Feedback

"Send Feedback" in the app opens your own default email client with a
message addressed to `moshef@gii.co.il`, pre-filled with what you typed.
SeisConv does not send anything itself; whether the email goes anywhere is
entirely up to you.

## Contact

Questions about this policy or about SeisConv: `moshef@gii.co.il`.

## License

SeisConv is free and open source software licensed under the GNU Affero
General Public License v3.0 (AGPL-3.0-or-later).
Source: https://github.com/m0shiko8811-beep/SeisConv

Copyright (C) 2026 Moshe Fridin.
