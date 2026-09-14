# Oracles: cross-checking SeisConv against independent implementations

This directory holds **three** sealed reference decoders, one per implementation.
The SEG-Y one came first and the rest of this file is mostly about it; the two
that were added later, and the survey that produced them, are at the bottom under
"The other two oracles".

| Format | Reference implementation | Licence | Directory | Image | Built? |
|--------|--------------------------|---------|-----------|-------|--------|
| SEG-Y | [segyio](https://github.com/equinor/segyio) (Equinor) | LGPL-3.0 | `qa/oracle` | `seisconv-segy-oracle:1` | yes |
| SEG-D | [sedaman](https://github.com/andalevor/sedaman) | LGPL-3.0 | `qa/oracle/segd` | `seisconv-segd-oracle:1` | **no, never built** |
| SEG-2, SU | [ObsPy](https://github.com/obspy/obspy) | LGPL-3.0 | `qa/oracle/obspy` | `seisconv-obspy-oracle:1` | **no, never built** |

`qa/oracle/compare.mjs` uses the first. `qa/conform/conform.mjs` uses all three,
to read back the files SeisConv **writes**.

## SEG-Y oracle: cross-checking our parser against segyio

`core/formats/segy.ts` is unit-tested largely against fixtures that SeisConv's own
writer produced. A reader and a writer that share a mistake, for example in IBM
float decoding or in byte-order detection, still make those tests pass. This
harness removes that blind spot: it decodes the same real SEG-Y file twice, once
with SeisConv's parser and once with [segyio](https://github.com/equinor/segyio)
(Equinor's, an independent implementation), and diffs the two answers.

A disagreement here is a real signal. Agreement here is worth more than any
number of self-consistent fixtures.

Scope is deliberately narrow: file-level facts plus the decoded sample matrix.
It is **not** a per-trace-header comparator.

## Isolation, and why every flag is there

The fixtures are real field seismic. They must never leave the machine, and the
reference implementation is third-party code that has no business reading
anything else on the disk.

* **Network at image build time only.** `pip install` runs once, inside
  `docker build`. Every `docker run` passes `--network none`, so the container
  has no interface at all and cannot exfiltrate a sample, a header, or a name.
* **`--read-only`.** The container's root filesystem is read-only. It writes
  nothing to disk. Its only output channel is JSON on stdout. (`oracle.py` also
  sets `PYTHONDONTWRITEBYTECODE=1` so nothing even tries to write a `.pyc`.)
* **One bind mount, read-only, at a fixed target.** The single
  `--mount type=bind,source=<fixture>,target=/data/input.sgy,readonly` is the
  only path the container can see. The repository is not mounted. The user
  profile is not mounted. No drive root is mounted. The target name is fixed, so
  the container never learns the real file name.
* **`--cap-drop ALL` and `--security-opt no-new-privileges`.** Decoding a file
  needs no capability and no privilege escalation.
* **Base image pinned by digest.** `python:3.12-slim@sha256:78387bc3...` so a
  rebuild cannot silently pick up different bits.
* **Nothing but `segyio` and `numpy`** is installed. No shell tooling, no test
  runner, no network client.

`qa/oracle/compare.mjs` additionally redacts every known fixture path, file name
and parent directory name out of any child-process output before printing, and
refers to fixtures only as "fixture A", "fixture B", "fixture C". Real survey,
site and job names must never reach a console, a log or a commit.

## Build the image (the only step that uses the network)

```sh
docker build -t seisconv-segy-oracle:1 qa/oracle
```

Run it once. `compare.mjs` refuses to run and prints this line if the image is
missing, rather than building it silently, so the network step stays explicit.

## Run the cross-check

```sh
npm run qa:oracle
```

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | every fixture agreed, or every fixture was skipped |
| 1 | at least one disagreement |
| 2 | the oracle image is not built yet |
| 3 | the harness itself failed |

With no fixture configured it SKIPs and exits 0, the same convention the
file-backed suites in `npm run test:core` use.

## Fixtures

Paths are per machine and are never committed. They resolve through the shared
`qa/local-paths.mjs` resolver: environment variable first, then the git-ignored
`qa/local-paths.json`. See `qa/README.md` and `qa/local-paths.example.json` for
the key names. Nothing is hardcoded and nothing is invented.

| Label | Env var | `local-paths.json` key | What it is for |
|-------|---------|------------------------|----------------|
| fixture A | `SEISCONV_QA_SEGY` | `segy` | the standing big-endian QA SEG-Y |
| fixture B | `SEISCONV_QA_LE` | `le` | the standing little-endian QA SEG-Y |
| fixture C | `SEISCONV_ORACLE_IBM` | `oracleIbm` | an IBM-float (data format code 1) SEG-Y |

Fixture C exists because the headline question is about **IBM float**, and both
standing QA fixtures happen to be IEEE float32 (format 5). If neither the env
var nor the key is set, `compare.mjs` looks for the first file whose data sample
format code is 1 under the already-configured crossformat corpus
(`SEISCONV_XFMT_DIR` / `xfmtDir`), walking in sorted order so the pick is
deterministic. If there is no such file, fixture C skips.

## What is compared

Both sides emit the same JSON shape and `compare.mjs` diffs it key by key:

* `trace_count`
* `samples_per_trace`
* `sample_interval_us`
* `data_format_code` (binary header bytes 3225 to 3226)
* `revision_major` (the declared revision)
* `byte_order` as each side **detected** it, independently
* `sample_matrix_sha256`, plus the first 8 and last 8 decoded values of trace 0
  and of the middle trace

The sample matrix hash is the one that matters. Everything else is there so a
hash mismatch is interpretable.

### Byte order is detected independently on both sides

SeisConv auto-detects byte order from the binary header. **segyio does not
auto-detect at all**: it must be told `endian='big'` or `endian='little'`. To
keep the reference genuinely independent, `oracle.py` does not ask SeisConv. It
opens the file both ways and picks the order whose header arithmetic closes
exactly on the real file size:

```
3600 + ext_headers * 3200 + trace_count * (240 + samples_per_trace * bytes_per_sample) == file size
```

Both attempts, and their outcome, are reported. That makes `byte_order` a real
cross-check rather than an echo.

### The hash contract

Decided and fixed **before** any comparison was run, and implemented identically
in `ours.mjs` and `oracle.py`:

1. **dtype**: every sample is decoded to IEEE-754 **binary32** (float32). Both
   implementations already produce float32 natively, so nothing is widened or
   narrowed to make them agree.
2. **order**: trace-major, C order. All of trace 0's samples, then all of trace
   1's, and so on. Ragged files have no rectangular matrix; `ours.mjs` checks
   `nSamples` uniformity and refuses to hash rather than concatenating a jagged
   array.
3. **endianness of the hashed buffer**: **little-endian** binary32, explicitly,
   regardless of host byte order. The Node side falls back to a byte-by-byte
   `writeUInt32LE` on a big-endian host.
4. **NaN handling**: every NaN (exponent all ones, non-zero mantissa) is
   rewritten to the canonical quiet NaN `0x7FC00000`. NaN payload bits are not a
   property of the file, so comparing them would produce noise, not signal.
5. **negative zero**: `-0.0` (`0x80000000`) is rewritten to `+0.0`. SeisConv's
   `ibm2f` returns `+0` for a sign-bit-set zero; another implementation may
   return `-0.0`. The two are numerically equal and this is the only place they
   differ in bits.
6. **infinities are left alone.** They are exact and directly comparable.
7. SHA-256 over the resulting byte stream.

The counts of both rewrites, `normalised_nan` and `normalised_neg_zero`, are
part of the compared output, so the normalisation can never hide a difference
silently: if one side normalised something and the other did not, the diff says
so before the hash is even reached.

### About the printed sample values

Each printed sample carries two fields:

* `hex`: the exact binary32 bit pattern. **This is the authoritative
  comparison.**
* `dec`: the value as nine significant decimal digits in exponential form
  (`toExponential(8)` on the Node side, `"%.8e"` on the Python side, with the
  exponent padded to two digits so the two agree character for character). Nine
  significant digits round-trip binary32 exactly, so this is full precision, not
  a rounded display.

The decimal is for humans. If `hex` matches, the values are identical.

## What a difference means

A `sample_matrix_sha256` mismatch on real data is a genuine finding and must not
be explained away. Note in particular that **IBM single precision to IEEE
binary32 is exact in the normal range**: an IBM hex float has a 24-bit fraction
which normalises to at most 24 significant bits, and binary32 holds 24. So there
is no legitimate "rounding difference" to hide behind. If the hashes differ,
dump the raw four IBM bytes and both decoded bit patterns for the first
differing sample and classify it by hand.

A header field mismatch usually means the two implementations disagree about the
file layout, which is worth understanding before touching the sample decode.
Two known and legitimate classes of disagreement:

* **segyio refuses the file entirely** (`RuntimeError: trace count inconsistent
  with file size`). segyio 1.9.14, as installed by this image, derives the trace
  stride as `240 + ns * bps`. A SEG-Y **rev 2** file that declares additional
  240-byte trace headers in binary header bytes 3507 to 3510 has a wider stride,
  and that segyio cannot walk it. SeisConv handles this
  (`SegyMeta.addHdrBytes`). The harness reports this as **NO CROSS-CHECK**, not
  as a SeisConv failure, and it does not count as a disagreement. It is the
  reference that is short here, not the parser under test. Before believing that
  in any given case, confirm the stride closes exactly on the file size and that
  the per-trace sequence numbers run 1..N.
* **`samples_per_trace` disagreement.** segyio takes the sample count from the
  binary header; SeisConv prefers the per-trace header value and falls back to
  the binary header. On a conformant file they are the same.

## What this harness does NOT cover

* **Per-trace headers.** Deliberately out of scope. Only the file-level fields
  listed above and the sample matrix are compared.
* **Little-endian sample decoding, cross-checked.** If the only little-endian
  fixture is one segyio cannot open, byte order was verified on big-endian files
  only. The `byte_order` field will say `little` on the SeisConv side with
  nothing to compare it to.
* **IBM float in a little-endian file.** `core/formats/segy.ts` calls
  `ibm2f(b, p)` with no byte-order flag, on the stated grounds that IBM hex
  float is byte-order-agnostic. That is true of the IBM encoding itself but not
  of a SEG-Y rev 2 file that declares little-endian byte order, where the
  four-byte sample field is stored byte-swapped. There is no fixture combining
  format code 1 with little-endian byte order, so this path is **unverified**,
  which is not the same as broken.
* **Breadth.** One file per fixture slot. A corpus of files from the same
  acquisition is one independent sample, not many.

## Files

| File | Runs where | Purpose |
|------|-----------|---------|
| `Dockerfile` | build host | pinned image with only segyio and numpy |
| `oracle.py` | inside the container | decode with segyio, emit JSON on stdout |
| `ours.mjs` | host, under `tsx` | decode with the real `core/formats/segy.ts`, emit the same JSON |
| `compare.mjs` | host | resolve fixtures, run both sides, diff, redact, exit non-zero on mismatch |

`ours.mjs` imports `core/formats/segy.ts` directly and runs under `tsx`, the same
route `npm run test:core` uses to load core modules. It does not reimplement any
part of the decode.

The hash contract itself now lives in `qa/oracle/hash.mjs`, which `ours.mjs`
imports. The arithmetic was moved out of `ours.mjs` unchanged and the move was
verified by capturing that script's JSON output for two fixtures before it and
confirming it byte-identical after. `qa/conform/conform.mjs` imports the same
module, so the source-side matrix for SEG-2, SEG-D and SU is produced by the same
code that produces it for SEG-Y.

`oracle.py` deliberately keeps its own inline copy of the same arithmetic and was
NOT refactored to import `hashcontract.py`. Its image is already built and pinned;
editing the script would silently put the source out of step with an image
somebody already has. The three transcriptions - `oracle.py`, `hash.mjs` and
`hashcontract.py` - are line-for-line comparable, and the contract they all
implement is the one written down above.

---

# The other two oracles

## Does an independent SEG-D reader exist? Yes, and the claim that none did was wrong

`qa/conform` used to print `independent read: NO READER EXISTS` on every SEG-D
line, on the stated grounds that no independent SEG-D implementation was
available and that nothing but SeisConv had ever decoded those bytes. **That did
not survive checking.** At least seven independent open-source SEG-D readers
exist. The survey, so the choice can be argued with:

| Tool | Reads SEG-D | Revisions | Licence | Containerisable | Verdict |
|------|-------------|-----------|---------|-----------------|---------|
| [sedaman](https://github.com/andalevor/sedaman) | yes | **Rev 1, 2, 3 read** (Rev 2 write) | LGPL-3.0 | yes, CMake + pybind11 | **chosen** |
| [pysegd](https://pypi.org/project/pysegd/) 4.0.1 | yes (read + write) | **undocumented** | LGPL-3.0 | easiest of all, `pip install`, wheel only | rejected: revision coverage is not stated anywhere and its repo link 404s |
| Seismic Unix [`segdread`](https://github.com/JohnWStockwellJr/SeisUnix/blob/master/src/Sfio/main/segdread.c) | yes | **Rev 0/1 only** - the source branches on `rev[0] <= 1` and has no Rev 2 or Rev 3 path, no General Header Block 3 | BSD-3-clause + EAR99 | awkward: `segdread` is not in the default build target, it needs the separate `make sfinstall` step, and `make install` prompts interactively | rejected: cannot adjudicate the Rev 3 half of what `writeSEGD` emits |
| [pysegd3](https://pypi.org/project/pysegd3/) | yes | Rev 3 only | GPL-3.0 | `pip install`, one unverified dependency | rejected: Rev 3 only, so it would need pairing with something else |
| [drsudow/SEG-D](https://github.com/drsudow/SEG-D) | yes | self-inconsistent: `setup.py` says rev 3.1, the README says rev 2.1 | MIT | needs cython | rejected: unmaintained since 2016 and cannot state its own coverage |
| [segdio](https://github.com/geo-stack/segdio) | partial | Rev 2.1, 24 and 32 bit | MIT | yes | rejected: a fork of the above, and Rev 2.1 only |
| [OpenSeaSeis](https://github.com/JohnWStockwellJr/OpenSeaSeis) `csSegdReader` | yes | a `thisIsRev0` flag, no revision enum | CSM | heavy C++/Java with shell build scripts | rejected: build weight for no extra coverage |

Confirmed negatives, each checked against a primary source rather than assumed:

* **Madagascar has no `sfsegdread`.** There is no `Msegd*` in `system/seismic`,
  it is absent from the [program guide](https://ahay.org/wiki/Guide_to_madagascar_programs),
  and [issue 47](https://github.com/ahay/src/issues/47) is an open feature request
  proposing to borrow SU's. The `segd.h` in `trip/iwave/sucore/include` is SU's
  header vendored in, a header with no reader program behind it.
* **ObsPy has no SEG-D module.** The [package index](https://docs.obspy.org/packages/index.html)
  lists `obspy.io.seg2` and `obspy.io.segy` and nothing for SEG-D.
* **segyio is SEG-Y and Seismic Unix only**, by its own README.
* **[segpy](https://github.com/sixty-north/segpy) is SEG-Y only.**
* **No Rust crate**: `crates.io` returns zero results for `segd`.
* **Julia**: neither `SeisIO.jl` nor `SegyIO.jl` reads SEG-D.

**sedaman was chosen** because it is the only candidate that documents read
support for both revisions `writeSEGD` emits, Rev 1 and Rev 3, and because it has
no licence friction: LGPL-3.0, a plain `git clone`, no registration, no signed
agreement, no interactive prompt. It is C++20 by an unrelated author, so it shares
no lineage, no language and no code with SeisConv.

The cost is that it has to be **compiled**. `qa/oracle/segd/Dockerfile` is a
two-stage build: a builder stage installs `build-essential`, `cmake` and `git`,
clones sedaman at the pinned commit `fb22fa29539741e21d804cbf8e4b540c1b4b467c`
(master as of 2024-06-24; the project has no releases and no tags, so `master`
would make every rebuild a different reference implementation, which is the one
thing a reference implementation may not be), initialises its single submodule
**after** that checkout so pybind11 is the revision that commit recorded, builds
only the `pysedaman` target, and copies the resulting `.so` into a runtime stage
that has numpy and nothing else. That submodule, pybind11, is **BSD-3-Clause**, and it is
compiled into the `pysedaman` module, so its licence ships in the image alongside
sedaman's LGPL-3.0. The apt packages are not version-pinned, which is a real
reproducibility gap and is stated in the Dockerfile rather than papered over.

## SEG-2 and Seismic Unix: ObsPy

[ObsPy](https://github.com/obspy/obspy) reads both, and both claims were checked
against the source at tag 1.5.1 rather than taken on trust:

* **SEG-2**: `obspy/io/seg2/seg2.py`, pure Python, called as
  `obspy.read(path, format="SEG2")`. It reads the File Descriptor Block, derives
  the byte order from the block id, reads the trace pointer array, validates each
  Trace Descriptor Block id, and supports **all five** data format codes; anything
  else raises `SEG2InvalidFileError`. It consumes and then discards the fixed
  fields, so byte order, revision and the data format code cannot be got back out
  of it - which is why `oracle_obspy.py` does not report them. A field parsed by
  this harness would be parsed by code written for this harness, which is not an
  independent read.
* **SU**: `obspy/io/segy/core.py::_read_su`, called as
  `obspy.read(path, format="SU")`. Byte order is left unset on purpose so ObsPy
  **autodetects** it, which makes the order it reports a real second opinion
  rather than an echo. It decodes the 240 bytes with the SEG-Y rev 1 trace-header
  table, so it does not judge SU's CWP-specific trailing 60 bytes either.

ObsPy 1.5.1 is **pinned by version**, unlike segyio. It has to be: SEG-2 data
format code 3 support arrived in 1.2.0 and unreleased master already raises the
floor to numpy 2.2, so "whatever pip resolves today" is not a reference anybody
can reproduce.

PyPI ships obspy 1.5.1 as a cp312 manylinux **x86_64** wheel and publishes no
linux aarch64 wheel, so on an arm64 host the build needs `--platform linux/amd64`
or pip falls back to the sdist and tries to compile obspy's `libsegy` C extension,
which the slim image has no compiler for. `obspy.io.segy` is not pure Python - it
loads `libsegy` at import - so that wheel is not optional for the SU half.

matplotlib, scipy, lxml, sqlalchemy, decorator and requests come in as hard
dependencies and are left in place. None of them is imported when reading SEG-2 or
SU, but uninstalling a declared dependency would make the container something
other than a stock ObsPy.

## Build the two new images

Both take `qa/oracle` as the build **context** and their own directory only for
the `-f` Dockerfile, so the one shared copy of the hash contract
(`hashcontract.py`) can be baked into both rather than transcribed twice more.

```sh
docker build -t seisconv-segd-oracle:1  -f qa/oracle/segd/Dockerfile  qa/oracle
docker build -t seisconv-obspy-oracle:1 -f qa/oracle/obspy/Dockerfile qa/oracle
```

Both pin the **same** `python:3.12-slim` digest the SEG-Y image pins, so all three
oracles stand on identical base bits. That digest was resolved on 2026-09-09 and
is reused rather than re-resolved, because the daemon was not running when these
were written and a digest nobody verified today would be a worse claim than one
already in the tree with a date on it.

## What still needs docker

**Neither new image has ever been built and neither script has ever decoded a
byte.** The docker daemon was not running on the machine where they were written.
Everything below is unverified, and `qa/conform/conform.mjs` reports
`NOT RUN (no container)` rather than anything resembling agreement until it is.

Run, in order, and expect the following:

1. `docker build -t seisconv-obspy-oracle:1 -f qa/oracle/obspy/Dockerfile qa/oracle`
   * **Unverified**: that cp312 manylinux wheels exist for numpy, scipy,
     matplotlib and lxml themselves. They normally do; it was not checked.
   * **Unverified**: that ObsPy imports cleanly under `--read-only` with no
     writable `HOME` or `/tmp`. It should, because matplotlib is never imported on
     the SEG-2 or SU read path, and matplotlib's font cache is the usual cause of
     that failure. If it does fail, the fix is a build-time warm-up so the cache
     lives in an image layer, **not** a quiet `--tmpfs /tmp`: the flag set is
     identical across all three images on purpose, and any deviation has to be
     written down here with its reason.
2. `docker build -t seisconv-segd-oracle:1 -f qa/oracle/segd/Dockerfile qa/oracle`
   * **Unverified**: that sedaman's CMake configure succeeds. Its top-level
     `CMakeLists.txt` does `add_subdirectory(tests)`, which runs at configure time
     even though only the `pysedaman` target is built; if the tests directory
     needs a package the image lacks, this is the line that will say so.
   * **Unverified**: that the submodule URL resolves. It is declared relative
     (`../../pybind/pybind11`), so it resolves against the sedaman remote to
     `github.com/pybind/pybind11`.
   * **Unverified**: that `libstdc++.so.6` copied from the builder is the right
     move, and that every pysedaman field name `oracle_segd.py` reads still
     exists at the pinned commit. Every field read is defensive and degrades to a
     missing key rather than a traceback, so a name that moved shows up as a null
     in the JSON, and `conform.mjs` prints a null as a note rather than counting
     it as a disagreement - a binding quirk must never read as "SeisConv
     disagrees with sedaman".
   * **Unverified**: sedaman's trace-iteration contract. `oracle_segd.py` uses
     `for tr in f:` and lets the pybind binding own the protocol, precisely
     because the interaction of `has_record()` and `has_trace()` across a record
     boundary is documented nowhere and a hand-rolled nested loop can spin for
     ever. The manual walk is kept as a fallback for a binding that turns out not
     to be iterable, and it breaks out the moment a record yields no trace. Every
     `docker run` additionally carries a 600 s timeout, so a wedged container ends
     the cross-check rather than the run.
3. `npm run qa:oracle` - should behave exactly as before; `ours.mjs` changed
   only by importing the hash contract instead of defining it.
4. `npm run qa:conform` - the three `NOT RUN (no container)` lines become real
   verdicts.

**One prediction, written down before the fact so it can be wrong.** ObsPy will
very likely **refuse** the SEG-2 file SeisConv currently writes, and the reason is
already visible without a container: the written file's byte-order mark says low
byte last while every integer after it is low byte first, so ObsPy will read
6,144 traces where there are 24. If instead it reads the file and disagrees about
the samples, or reads it and agrees, that is new information and this paragraph
was wrong. Note that when a reference implementation refuses a written file the
harness reports `NO CROSS-CHECK`, not a failure - the same treatment segyio gets
when it cannot walk a rev-2 stride - because the exit code should be driven by the
cited rule that catches the defect, not by a third party's tolerance. In this case
`SEG2-FDB-04-INTEGER-BYTE-ORDER` already fails on the citation alone.

**A second cliff, which will not fire today.** ObsPy's SU byte-order autodetector
unpacks the sample count at bytes 115-116 as a SIGNED 16-bit integer and rejects
anything at or below zero, even though the field is unsigned. A written SU file
with more than 32,767 samples per trace would therefore fail autodetection in both
orders and `_read_su` would raise, while `SU-LAYOUT-CLOSES` on this side would pass
because the harness reads the field unsigned. None of the four sources driving
`writeSU` here comes near it - they carry 2,001 and 4,000 samples - so it is
written down as a known edge rather than as a finding.

