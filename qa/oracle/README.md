# SEG-Y oracle: cross-checking our parser against segyio

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
