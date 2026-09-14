# Output conformance: does what SeisConv WRITES conform to the standard?

`qa/oracle` removed the blind spot on the **reading** side: it decodes the same
real field SEG-Y twice, once with `core/formats/segy.ts` and once with segyio,
and diffs the two answers.

Nothing did the same for the **writing** side. `npm run test:crossformat`
compares SeisConv's outputs against each other, which proves self consistency,
not conformance. Every file an operator converted and handed to a client was
unverified against the standard it claims to be. This harness closes that for
SEG-Y, SEG-D, SEG-2 and Seismic Unix.

```sh
npm run qa:conform
```

## The rule that keeps this honest

**No rule without a citation.** Every check applied here is a row in
`qa/conform/rules.segy.json` or `qa/conform/rules.segd.json` carrying the
document, the section, the table row and the page it came from, plus the
sentence itself as `citation.quote`. Every one of those rows was read out of a
PDF on this machine with `pdftotext -f <page> -l <page> -layout`. A rule that
could only be recalled rather than read is not in the file; it is listed under
`uncovered` instead.

That is the whole point. Encoding remembered byte offsets would produce a
validator that agrees with SeisConv because both came from the same imperfect
memory, which is the exact blind spot this is meant to remove. The same
principle is why the EBCDIC table used to decode the textual header comes out of
SEG-Y rev 2.0 Appendix F and **not** out of `core/binary.ts`: a wrong table
decodes its own wrong encoding perfectly and proves nothing.

It matters most where the independent reader is weakest. On SEG-Y a wrong rule
row is caught by segyio disagreeing with it. On SU there is no standard document
at all, so the citation and the independent read are carrying different halves of
the job and `rules.su.json` says which is which in its `_authority` block.

The run prints the number of rules it actually applied, per format, so a pass
reads "conformed against 315 cited rules", never a bare "conforms".

## The three layers

For each fixture, and for each revision the writer can emit:

1. **Structural.** The declared layout must close exactly on the real file size.
   For SEG-Y that is `3600 + ext*3200 + traces * (240 + addHdr*240 + ns * bps)
   == size`, with the rev-2 override chain honoured: the same arithmetic
   `qa/oracle/oracle.py` already uses to pick a byte order, run here against the
   file SeisConv wrote. For SEG-D it is a walk rather than one multiplication,
   because SEG-D lets every channel set differ - see "The SEG-D structural walk"
   below. A file whose own arithmetic does not close is malformed whatever its
   fields say.
2. **Rule table.** Every cited row that applies to the revision the written file
   declares. A failure prints the rule id, the field, expected, actual, the
   citation and the quote.
3. **Independent read.** The **written** file is decoded by a second, unrelated
   implementation inside a sealed container, and its sample matrix hash is
   compared against the source's. The hash contract is the one already fixed in
   `qa/oracle/README.md`, NaN and negative-zero normalisation included, reused
   exactly rather than reinvented: `qa/oracle/hash.mjs` is the single Node-side
   implementation, imported by both `qa/oracle/ours.mjs` and this harness, and
   `qa/oracle/hashcontract.py` is its Python twin inside the new images.

Layers 1 and 2 need no container and always run. Layer 3 needs docker, and it
now **exists for all four formats**, in three images:

| Format | Reference implementation | Directory | Image |
|--------|--------------------------|-----------|-------|
| SEG-Y | segyio (Equinor, LGPL-3.0) | `qa/oracle` | `seisconv-segy-oracle:1` |
| SEG-D | sedaman (LGPL-3.0, C++20) | `qa/oracle/segd` | `seisconv-segd-oracle:1` |
| SEG-2, SU | ObsPy (LGPL-3.0) | `qa/oracle/obspy` | `seisconv-obspy-oracle:1` |

### SEG-D used to say NO READER EXISTS, and that was wrong

This file used to state that no independent SEG-D implementation was available
and that nothing but SeisConv had ever decoded these bytes. **That claim does not
survive checking.** At least seven independent open-source SEG-D readers exist.
The one wired in here is [sedaman](https://github.com/andalevor/sedaman), LGPL-3.0,
C++20, by an unrelated author, which reads SEG-D **Rev 1, Rev 2 and Rev 3** - and
Rev 1 and Rev 3 are exactly the two revisions `writeSEGD` emits. The survey behind
that choice, and the alternatives that were rejected and why, are in
`qa/oracle/README.md`.

What replaces the old line is **not** a claim that SEG-D is now cross-checked.
The image has never been built, because the docker daemon was down when it was
wired, so a run without a container prints

```
independent read: NOT RUN (no container) - seisconv-segd-oracle:1
```

which is the same thing SEG-Y prints and means the same thing: a cross-check that
exists did not run today. It is not agreement, and the `uncovered` note in
`rules.segd.json` and this README both say so until a container has actually
decoded a written file.

## What SeisConv's writers are actually called

`conform.mjs` imports `writeSEGY` and `parseSEGY` from `core/formats/segy.ts`,
`writeSEGD` and `parseSEGD` from `core/formats/segd.ts`, `writeSEG2` and
`parseSEG2` from `core/formats/seg2.ts`, and `writeSU` from `core/formats/su.ts`,
directly, and runs under `tsx` - the same route `qa/oracle/ours.mjs` uses to
import the real parser. Nothing here re-implements any part of any writer, and
nothing here is permitted to change one to make a check pass.

`detectSU` is the one core function this harness deliberately does **not**
import. SU carries no byte-order marker, so deciding the order is part of what is
under test; a layout resolved by the code being checked would check nothing. The
harness runs the stride arithmetic in both orders itself, and ObsPy's SU reader
autodetects a third time, independently.

## Reuse, not a parallel harness

Everything below is `qa/oracle`'s and is used unchanged:

* the container isolation flags, in **one** function, flag for flag:
  `--network none`, `--read-only`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, and one read-only bind mount at a FIXED
  target so the container never learns a real file name. `dockerArgs` takes the
  image and the mount target as parameters, because those differ between the
  three images; the flags are not parameters, because they must not differ. The
  targets are `/data/input.sgy` for segyio, `/data/input.sgd` for sedaman and
  `/data/input.bin` for ObsPy, and none of them carries a real name;
* the image `seisconv-segy-oracle:1` and `oracle.py` inside it, untouched. That
  image is already built and pinned somewhere, so `oracle.py` deliberately keeps
  its own inline copy of the hash contract rather than being refactored to import
  the shared one - editing it would put the source out of step with an image that
  already exists;
* the three-layer redaction: every segment of every fixture path, the per-machine
  `forbiddenTerms` denylist, and a catch-all for anything shaped like an absolute
  host path. Fixtures are "fixture A" through "fixture F" and nothing else;
* fixture resolution through `qa/local-paths.mjs`, environment variable first,
  then the git-ignored `qa/local-paths.json`;
* the exit code contract;
* the skip-and-exit-0 convention when nothing is configured.

Every format reuses all of it and adds no second mechanism: the same resolver,
the same redaction, the same `mkdtemp`, the same verdict printer and the same
applied-rule counting. `printVerdicts` is one function all four formats call, so
a failure cannot come to be reported one way for one format and another way for
another, and `compareMatrix` is one function SEG-D, SEG-2 and SU all call for the
same reason. The hash contract is one file, `qa/oracle/hash.mjs`, imported by both
`qa/oracle/ours.mjs` and this harness; extracting it from `ours.mjs` was verified
by capturing that script's JSON for fixtures A and B before the move and
confirming it byte-identical after.

### One thing this harness must never print

SEG-2 free-form headers routinely carry `CLIENT`, `COMPANY`, `JOB_ID`, `OBSERVER`
and `NOTE` strings naming a real survey, site or crew, and `guard()` redacts
paths, not file CONTENT. So the SEG-2 string walk captures **keyword names only,
never values**; `oracle_obspy.py` returns the key names and never a value; and a
keyword that does not look like a keyword is printed as
`<not a printable keyword>` rather than shown, because a free-form section that
failed to parse can hand back any bytes at all. `oracle_segd.py` is under the same
rule and never calls sedaman's `general_header_client_name`,
`general_header_survey_name`, `general_header_job_id` or
`general_header_line_id`.

The written files go to a fresh `mkdtemp` directory under the OS temp directory
and are deleted when the run ends. Nothing is written into the repository.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | every applied rule held and every available cross-check agreed, or every fixture was skipped |
| 1 | at least one disagreement: a **mandatory** rule failed, the layout did not close, or the independent read disagreed |
| 2 | an oracle image needed by a live fixture is not built, or the docker daemon is unreachable, and nothing else failed |
| 3 | the harness itself failed |

Priority matters: a mandatory failure wins over a missing container, so a run
that cannot reach docker still exits 1 when a rule failed. With no fixture
configured it SKIPs and exits 0, the same convention the file-backed suites in
`npm run test:core` use.

Exit 2 now covers every format, because every format has a container. Only the
images a live fixture actually needs are counted: a run with SEG-D fixtures alone
does not return 2 because the ObsPy image is missing.

No image is ever built silently. If one is missing the run prints the command
that builds it, and image build stays the only step that uses the network:

```sh
docker build -t seisconv-segy-oracle:1 qa/oracle
docker build -t seisconv-segd-oracle:1  -f qa/oracle/segd/Dockerfile  qa/oracle
docker build -t seisconv-obspy-oracle:1 -f qa/oracle/obspy/Dockerfile qa/oracle
```

The two newer images take `qa/oracle` as their build **context** and their own
directory only for the `-f` Dockerfile, so the one shared copy of the hash
contract (`qa/oracle/hashcontract.py`) can be baked into both rather than
transcribed a third and fourth time.

`qa/oracle/compare.mjs` reports "image not built" for any non-zero
`docker image inspect`. This harness separates the two cases and says which,
because "the daemon is not running" and "you never built the image" need
different actions. Both still exit 2. When the daemon is down it says so **once**,
not once per image, because that is one fact about the machine and not three
facts about three images.

## Mandatory and recommended

Each rule row carries a `level`.

* **mandatory** - the standard states the requirement outright ("This field is
  mandatory for all versions of SEG-Y", "must be the same as the values recorded
  in the Binary File Header"). A failure drives exit 1.
* **recommended** - the standard states a preference ("is the preferred
  encoding", "strongly recommended"), or the check is deliberately stricter than
  the standard and says so in its `checkNote`. Printed in full, never fatal.

A few rows carry `levelByRevision`, because a requirement that rev 1 calls
mandatory rev 2.0 downgrades. The trace-header sample count is the clearest
case: rev 1 says it **must** match the binary header when the fixed-length flag
is set, rev 2.0 says the field **is ignored** and separately that correct values
are strongly recommended. Same check, different weight, both cited.

The SEG-D table adds a third reason for `recommended`, and it is the important
one: **a row whose citation is weaker than the file it is judging is never
allowed to fail a run.** Every such row says why in `citationCaveat`, and the
caveat is printed under the failure. See "SEG-D Rev 1 has no document" below.

## Fixtures

Paths are per machine and are never committed. They resolve through
`qa/local-paths.mjs`, exactly as `qa/oracle/compare.mjs` resolves them.

| Label | Env var | `local-paths.json` key | What it is |
|-------|---------|------------------------|------------|
| fixture A | `SEISCONV_QA_SEGY` | `segy` | big-endian SEG-Y |
| fixture B | `SEISCONV_QA_LE` | `le` | little-endian SEG-Y |
| fixture C | `SEISCONV_ORACLE_IBM` | `oracleIbm` | IBM-float SEG-Y, format code 1 |
| fixture D | `SEISCONV_QA_SEGD_REV2` | `segdRev2` | vendor SEG-D declaring revision 2 |
| fixture E | `SEISCONV_QA_SEGD_REV3` | `segdRev3` | vendor SEG-D declaring revision 3 |
| fixture F | `SEISCONV_QA_SEG2` | `seg2` | vendor SEG-2 |

Fixture F falls back through the same corpus in the same shape: the first file
with a `.dat`, `.seg2` or `.sg2` extension whose first two bytes are `55 3A` or
`3A 55`, sorted so the pick is deterministic, two bytes read per candidate. The
File Descriptor Block identifier is the test rather than the extension, because
SEG-2 is written as `.dat` as often as anything else and a file name settles
nothing.

There is no SU fixture and there is not meant to be one. `writeSU` is driven from
fixtures A, B, C and F, so SU output is exercised from four real sources in two
source families, and each one reuses the source sample matrix that section had
already produced rather than parsing a multi-megabyte file twice.

Fixture C falls back the same way `qa/oracle/compare.mjs` does: if neither the
env var nor the key is set, the first file whose data sample format code is 1 is
picked out of the already-configured crossformat corpus (`SEISCONV_XFMT_DIR` /
`xfmtDir`), walking in sorted order so the pick is deterministic. That fallback
matters here more than it does in `qa/oracle`, because an IBM-float source is the
one that exercises IBM to IEEE conversion on the WRITE path.

Fixtures D and E fall back through the same corpus in the same shape: the first
`.segd` or `.sgd` whose General Header Block #2 byte 11 reads 2, and the first
whose byte 11 reads 3, sorted so the pick is deterministic, one byte read per
candidate. Nothing about a directory layout is hardcoded; the revision is read
out of the file. A source declaring revision 2 and one declaring revision 3 are
both fed to both writers, so the four combinations of source revision and
written revision all appear.

Note that SeisConv's own older SEG-D exports are NOT vendor files and are not
what these keys should point at. `parseSEGD` detects them separately
(`isLegacySeisConvSEGD`), and a harness that measured SeisConv's output against
SeisConv's output would be back to proving self consistency.

## What SEG-D coverage means, and what it does not

`rules.segd.json` holds **59 rows**. 39 apply to a file declaring SEG-D Rev 3
(37 rev-3 rows plus the 2 layout rows), 22 to one declaring Rev 1 (20 plus the
same 2). Across fixtures D and E that is **122 applied rule checks**, alongside
SEG-Y's 147, and the RESULT block prints the two separately because they do not
mean the same thing.

What it means:

* **Every SEG-D rule row quotes a sentence from SEG-D Rev 3.0 or SEG-D Rev 2.1**,
  with the section, the byte row, and the printed and PDF page. For both
  documents those two page numbers are equal, verified against the footers.
* **The structural layer re-derives the file size from the file's own declared
  fields** and requires it to land exactly on the real size. That is the check
  most likely to catch a writer that miscounts a block.
* **The record is checked for its shape, not for its content.**

What it does not mean:

* **No independent implementation has read these bytes YET.** A reader now
  exists and is wired in - sedaman, in `qa/oracle/segd` - but the image has never
  been built, so as things stand SEG-D can still only say "these bytes match the
  sentences quoted below". A field SeisConv writes correctly-shaped but
  semantically wrong would pass every row here.
* **Nothing has yet checked that the samples survived the conversion.** For
  SEG-Y the sample-matrix hash comes back from segyio today. For SEG-D the
  comparison is written and the source-side matrix is computed on every run, but
  until the container runs there is no second opinion about a sample value, and
  the rule table never claims one.
* **Two vendor files from one acquisition is two samples, not many.**

### SEG-D Rev 1 has no document

There is **no SEG-D Rev 1 PDF on this machine** - only Rev 2.1, Rev 3.0 and
Rev 3.1 - and SeisConv's `segd1` writer declares major revision 1. This is the
same hole SEG-Y rev 0 has, and it is handled the same way: nothing is invented.
What is different is that Rev 2.1 carries a chapter, section 2.2, listing what
Rev 1 changed, so some rev-1 rows can cite a sentence that is genuinely about
Rev 1. Each rev-1 row is therefore graded by where its sentence sits:

| Tier | Where the sentence is | How it is used |
|------|----------------------|----------------|
| A | speaks about Rev 1 outright: Rev 2.1 section 2.2 "Changes Introduced in Rev 1", section 5.1's "as was also required in SEG-D, Rev 1", section 2.1's corrections to the Rev 1 document | graded as the sentence states it, `mandatory` where it says must or set to |
| B | a Rev 2.1 field-table definition that sections 2.0 and 2.1 do NOT list as introduced in Rev 2.1 or Rev 2.0 | `recommended` only, never fatal, and the row carries `citationCaveat` which is printed under any failure |
| C | sections 2.0 or 2.1 list it as introduced in Rev 2.1 or Rev 2.0 | **not applied to rev-1 output at all**, and listed under `uncovered` |

Tier C is the one that keeps this honest, and it is not hypothetical: the
trace-header-extension count in the lower nibble of Channel Set Descriptor byte
29, the 15-extension maximum, the fractional receiver line and point numbers,
trace edit code 03 and the sensor type byte are all Rev 2.0 additions. SeisConv's
rev-1 output populates several of them. None of them is judged.

There is a fourth case the tiers do not cover: a field defined in a Rev 2.1
table that **neither** document's list of changes mentions at all, so nothing
says when it appeared. The Extended Channel Set Number in descriptor bytes 27-28
is one. Where such a field is only an escape hatch it is simply not admitted for
a rev-1 file, which is why `SEGD1-CSD-02-CHANNEL-SET-NUMBER` does not accept FF.

`SEGD-LAYOUT-CLOSES` is the one deliberate exception to "Tier B is never fatal",
and it says so in its own `citationCaveat`: what it checks is not a value the
standard prefers but the file's own arithmetic against its own size, which a
malformed record contradicts under any revision's reading, and the block sizes
it uses are the ones without which no other rev-1 row could be reached at all.

### What the first SEG-D run found

The SEG-D slice does not pass, and that is the point of having built it. On both
fixtures, with no writer touched and no rule weakened:

| Rule | Level | What the written file does |
|------|-------|----------------------------|
| `SEGD3-GH3-BLOCK-PRESENT` | mandatory | the rev-3 output carries no General Header Block #3, which Rev 3.0 section 5.1 requires |
| `SEGD3-GH1-12-ADDITIONAL-GENERAL-HEADER-BLOCKS` | mandatory | byte 12 declares 1 additional block; Rev 3 requires 2 or greater |
| `SEGD3-GH2-32-HEADER-BLOCK-TYPE` | mandatory | byte 32 of General Header Block #2 is 0, not `0216` |
| `SEGD3-THE1-32-BLOCK-TYPE` | mandatory | byte 32 of Trace Header Extension #1 is 0, not `4016` |
| `SEGD3-CSD-69-DESCRIPTION-NO-NULLS` | mandatory | all 27 description bytes are zero, which that row forbids outright |
| `SEGD3-CSD-13-END-TIME-FORMULA` | recommended | TE is one whole sampling interval short of `TF + NS * SR` |
| `SEGD3-THE1-10-DEPTH-INDEX` | recommended | depth index 0, on a point Rev 3.0 contradicts itself about (see below) |
| `SEGD3-CSD-30-VERTICAL-STACK`, `SEGD1-CSD-30-VERTICAL-STACK` | recommended | vertical stack 0 declares "intentionally set to real zero" while the samples are not zero |

That is five mandatory rules and four recommended ones, each failing on both
fixtures, which the RESULT block counts as 10 mandatory and 8 recommended
failures. Five mandatory rules failing means `npm run qa:conform` exits **1**,
and it should: a mandatory failure outranks a missing container in the exit-code
priority, so the exit code says "a rule failed", not "docker is down". Note that
every one of those five is a Rev 3.0 block-identity or required-block rule -
exactly the class of defect no reader would notice until a client's system
refused the file. The rev-1 side of the writer produced no mandatory failure.

Fixing any of it is a writer change and writers are out of scope for this
harness. Rows are never weakened to make output pass; that would put the
validator back into agreement with the thing it is supposed to check.

## What a pass does NOT mean

* **It covers the rules encoded, and the count is printed.** It is not a
  certificate. 147 SEG-Y rule checks over three fixtures, 122 SEG-D checks over
  two, 14 SEG-2 checks over one and 32 SU checks over four written files are
  exactly that, not "conformant". The SEG-Y table holds 37 rows: 23 apply to a
  file declaring rev 1, 26 to one declaring rev 2.0, and 12 of those to both.
  The SEG-D table holds 59: 22 apply to a Rev 1 file, 39 to a Rev 3 one, 2 of
  those to both. The SEG-2 table holds 24 rows, all applicable, of which only 14
  were reachable on the current output - the other 10 report SKIP because the
  record never resolved far enough to read them, which is itself the finding.
  The SU table holds 8.
* **Where the container is unavailable, no independent implementation read the
  file at all.** The structural and rule layers still ran and the report says
  `independent read: NOT RUN`. Specification conformance and interoperability
  are different claims and this harness never blurs them.
* **A container that was never built is not a cross-check.** Every
  `NOT RUN (no container)` line in the report means no second implementation read
  those bytes at all. That is the state of every format in this tree today.
* **One fixture from one acquisition is one sample, not many.** Six fixtures
  drawn from three corpora is not broad coverage of four formats.
* **A `recommended` failure is still a failure of something the standard asked
  for.** It does not fail the run; it should still be read.
* **The values in the file are not judged**, only their form. Whether a
  coordinate is the right coordinate cannot be decided from the bytes.

## What is NOT covered

Also listed, with reasons, in the `uncovered` block at the end of each rule
table.

* **SEG-Y rev 0 output.** `writeSEGY(pd, 0)` declares revision zero, which the
  later documents describe only as "traditional SEG Y conforming to the 1975
  standard". That document is not on this machine, so there is nothing to cite,
  and rev 0 output is not exercised at all.
* **SEG-Y rev 2.1 output.** SeisConv declares major 2 minor 0, so rev 2.1 rules
  apply to nothing it writes. Rev 2.1 moved "Maximum number of additional
  240-byte trace headers" from bytes 3507-3510 to 3507-3508 and put a new Survey
  type field in 3509-3510. A file declaring 2.1 would need its own rows.
* **SEG-2 beyond the point the record stops resolving.** Ten of the 24 SEG-2
  rows report SKIP on the current output, because the byte-order defect below
  stops the walk before any Trace Descriptor Block can be reached. Those ten
  rows are written, cited and will apply the moment the record resolves; they
  are not passing today, they are unreached.
* **SU's CWP-specific header bytes.** The trailing 60 bytes of an SU trace header
  are CWP's own fields, not SEG-Y's, and `segy.h` is not on this machine. Not one
  of them is judged. See `rules.su.json` `uncovered`.
* **SEG-D Rev 3.1.** `seg_d_rev3.1.pdf` is on this machine, but SeisConv declares
  3.0, so its additions apply to nothing SeisConv writes.
* **SEG-D optional structure.** Extended and external headers, the general
  trailer, skew fields, every optional Rev 3 header block, extended recording
  mode, several scan types and several channel sets. The structural walk
  accounts for all of them when a file declares them; SeisConv declares none, so
  none of their rules exists here.
* **SEG-D channel type for a rev-1 file.** Rev 2.1 prints that code table as bit
  columns which `pdftotext -layout` interleaves into text that cannot be paired
  back up. Rev 3.0 prints the same information as a clean hexadecimal list, so
  the rev-3 row exists and the rev-1 one does not. A rule read out of a mangled
  extraction is a rule read out of memory.
* **SEG-D array forming and gain control method.** Both documents list the
  defined codes; neither says a value outside the list is forbidden. SeisConv
  writes zero in both. Encoding a prohibition the standard does not state would
  be inventing a rule.
* **The rev-1 timestamp fields.** Three BCD digits of Julian day cannot fit in
  one byte, so the field must span byte 12's lower nibble and byte 13. Rev 3.0's
  index column says exactly that; Rev 2.1's, as extracted, puts all three digits
  in byte 13, which cannot be read literally. Rather than carry the Rev 3.0 split
  back onto a Rev 1 file, the rev-1 timestamp is not checked. The rev-3 one is.
* **SEG-Y or SEG-2 sources converted to SEG-D.** The SEG-D fixtures are vendor
  SEG-D, so what runs is SEG-D in, SEG-D out.
* **Extended textual headers.** `writeSEGY` emits none, so the variable-count
  (-1) layout path and the `((SEG: EndText))` stanza scan are unimplemented; a
  file declaring -1 reports the layout as unresolvable rather than passing.
* **Fields whose correctness cannot be decided from the bytes**: the
  prestack-only mandatory fields in binary header bytes 3213-3216, ensemble trace
  numbering, and coordinate and elevation values.

## The SEG-D structural walk

SEG-Y's layout is one multiplication because every trace is the same size. SEG-D
is not: each channel set declares its own channel count, sample count and
extension count, so the walk steps through the record instead.

```
32 * (1 + additional general header blocks)            byte 12 upper nibble, or block #2 bytes 23-24 when it is F
  + scanTypes * (channelSets * csdSize + skew * 32)    bytes 28, 29, 30; csdSize is 96 for Rev 3, 32 for Rev 1
  + (extendedBlocks + externalBlocks) * 32             bytes 31, 32
  + for each channel set, for each of its channels:
        20 + traceHeaderExtensions * 32 + ns * bps     extensions from demux byte 10, per trace
  + generalTrailerBlocks * 32                          block #2 bytes 13-16 (Rev 3) or 13-14 (Rev 1)
  == the real file size
```

`ns` comes from Channel Set Descriptor bytes 13-16 in Rev 3 and from Trace
Header Extension bytes 8-10 in Rev 1, which is where each revision's own
document puts it. `bps` comes from the General Header Block #1 format code:
"8058 32 bit IEEE" is four bytes per sample. A format code whose sample is not a
whole number of bytes, or a general trailer whose size is declared unknown
(`FFFFFFFF`), makes the walk report itself unresolvable with the reason. It
never guesses a width, and it never passes by default.

## An inconsistency inside the SEG-D Rev 2.1 document

Rev 2.1 says three different things about which byte of the Demux Trace Header
holds the count of Trace Header Extension blocks:

| Where | What it says |
|-------|--------------|
| section 2.2 item 15 (printed page 10) | byte 10 is the **Trace Edit** byte |
| section 5.2 ground rule 6 (printed page 22) | the extension count is "in Byte 11 of the Trace Header" |
| section 2.1 item 9 (printed page 6) | "the Trace Header Extension field in Byte **10** of the Trace Header will also be redefined as a 4 bit value" |
| section 8.6, the field table (printed page 45) | byte 10 Trace Header Extensions, byte 11 Sample Skew, byte 12 Trace edit |
| section 8.5, Channel Set Descriptor byte 29 (printed page 44) | the count "Must match byte **10** of the Demux Trace Header" |

The field tables and two of the loose sentences agree on byte 10, and SEG-D Rev
3.0 settles it the same way in both its section 8.17 table and its section 5.2
ground rule 5. **Byte 10 is the extension count and byte 12 is the trace edit**,
which is what the harness reads, and the affected rows say so in `checkNote`.
The rev-1 trace-edit row is held at `recommended` for exactly this reason: a run
must not fail on a byte the standard names twice.

## A contradiction inside SEG-D Rev 3.0

Three sentences in Rev 3.0 disagree about the depth index in Trace Header
Extension #1 byte 10. Section 8.0's preamble (printed page 87) says location
indexes "should be recorded as 0 if they are unknown/undetermined unless
specified otherwise". The byte 10 row (printed page 117) specifies otherwise:
"0 is not allowed". The closing note of the same section, one page later, says
"016 is commonly used for indexes (receiver line/point, re-shoot, depth and
group indexes) to indicate not set".

`SEGD3-THE1-10-DEPTH-INDEX` is therefore `recommended`, all three sentences are
quoted in its citation, and its `checkNote` says plainly that it is deliberately
not fatal. A reader sees the finding; the run does not die on a point the
document argues with itself about.

## An inconsistency inside the SEG-Y rev 2.0 document

Worth knowing before reading the extended-field rules. SEG-Y rev 2.0's Table 2
defines bytes **3273-3280** as the extended sample interval and **3269-3272** as
the extended number of samples per trace, with 3281-3288 and 3289-3292 being the
*original field recording* variants (printed page 9, PDF page 13). But the same
table's row for bytes 3503-3504 names **3281-3288 and 3289-3292** as the fields
the fixed-length flag refers to (printed page 10, PDF page 14). The two rows
contradict each other. SEG-Y rev 2.1 corrects the 3503-3504 cross-reference to
3273-3280 and 3269-3272 (printed page 10, PDF page 14 of `seg_y_rev2.1.pdf`).

The rule rows follow the field definitions, which rev 2.1 confirms, and each
affected row says so in its `checkNote`.

## What SEG-2 coverage means

`rules.seg2.json` holds **24 rows**, all of which apply to a file declaring
revision 1, which is what `writeSEG2` declares. Every row quotes a sentence from
`seg_2.pdf` with its section and page, and for that document the printed page
number and the `pdftotext` page index are **equal**, verified against the footers
of pages 1 through 6.

Two things about this document are worth knowing before reading a quote from it:

* **Its typeface defeats `pdftotext` in one specific way.** Some lowercase `l`
  comes out as a capital `I`, so `Iow` inside a quote is the word `low`. It is
  left as extracted rather than corrected, because correcting a quote is editing
  evidence. The byte-order sentence spells the same word both ways in one line,
  which is how the artefact was identified.
* **The document has its own typographic errors**, and they are quoted as
  printed: `byes` for `bytes` in the Trace Descriptor Block size sentence, and
  `detected with an asterisk` on page 8 where page 7 says `denoted`.

SEG-2 also numbers its own bytes from **zero**, unlike SEG-Y and SEG-D. The
`bytes` field of every SEG-2 row uses the document's numbering so a citation can
be checked against the page without an off-by-one translation.

### What the first SEG-2 run found

The SEG-2 slice does not pass, and that is the point of having built it. With no
writer touched and no rule weakened, on the one vendor fixture:

| Rule | Level | What the written file does |
|------|-------|----------------------------|
| `SEG2-FDB-04-INTEGER-BYTE-ORDER` | mandatory | the file opens `3A 55`, which the standard defines as **low byte last**, and then writes every integer after it **low byte first** |
| `SEG2-FDB-32-POINTERS-CLEAR-THE-SUBBLOCK` | mandatory | a Trace Descriptor Block begins inside the region bytes 4-5 declare as the Trace Pointer Subblock |
| `SEG2-LAYOUT-CLOSES` | mandatory | read as the file declares itself, the record does not close on the file size |
| `SEG2-FDB-02-REVISION` | recommended | bytes 2-3 read as 256, not 1 |

All four are the **same underlying defect** seen from four sides, and the first
row is the one that names it. The evidence is arithmetic rather than opinion: read
low byte last, as the file's own mark demands, the record collapses; read low byte
first it resolves exactly, 24 traces closing on 386,624 of 386,624 bytes. A
24-trace record does not land on its own file size by chance. A real Geometrics
Geode file from the same corpus opens `55 3A` and is little-endian throughout, so
the vendor hardware and the standard agree with each other and not with this
output. Every conformant reader mis-reads the whole file: read big-endian, bytes
6-7 give 6,144 traces instead of 24 and bytes 4-5 give a 32,768-byte pointer
subblock instead of 128.

`SEG2-FDB-32-POINTERS-CLEAR-THE-SUBBLOCK` is worth separating out because it is a
**second, independent defect that is currently latent behind the first**. Bytes
4-5 are defined as the size of the Trace Pointer Subblock alone, which starts at
byte 32; `writeSEG2` puts `32 + 4N` there, the size of the fixed header plus the
pointer array. Correct the byte order and that row still fails, by exactly 32
bytes, and the File Descriptor Block's own free-format string section would still
be claimed by the first trace. The vendor file gets this right: it declares
M = 4,224 and puts its first trace pointer at 4,600, leaving room for the
`ACQUISITION_DATE` and `ACQUISITION_TIME` strings in between.

Ten further rows - every Trace Descriptor Block row and every string-format row -
report **SKIP**, not PASS, because the walk never reaches a Trace Descriptor
Block. Among them is `SEG2-TDB-32-STRING-LIST-WALKS`, which is the row most
likely to fail next: SEG-2 section C requires every free-form string to begin
with a two-byte offset to the next one and the list to end with a zero offset,
and `writeSEG2`'s free-form section is plain newline-separated lines with no
offsets at all. That is unverified until the record resolves, and it is written
down here as a prediction rather than a finding.

Fixing any of it is a writer change and writers are out of scope for this
harness. Rows are never weakened to make output pass.

## What SU coverage means, and what authority it rests on

**SU has no standard document, and none is being pretended.** SEG has never
published one and there is no SU specification PDF on this machine. So
`rules.su.json` names two authorities and says which applies to every row:

1. **For the position and meaning of a trace-header field**: SEG-Y rev 1.0,
   quoted exactly the way `rules.segy.json` quotes it, because the leading bytes
   of an SU trace header are the SEG-Y trace header. That is a **premise, not a
   citation** - no SEG document says SU uses the SEG-Y trace header - so every
   row resting on it is `recommended` and carries a `citationCaveat`. It is the
   same scheme as the Tier B SEG-D Rev 1 rows.
2. **For the container**: the file's own arithmetic against its own declared
   sample count. `SU-LAYOUT-CLOSES` is the only mandatory row in the table, on
   the same basis `SEGD-LAYOUT-CLOSES` is the one mandatory exception in the
   SEG-D Rev 1 tier scheme: a declared sample count that does not divide the file
   into whole equal records contradicts itself under any reading.

Because the rule table is weak here by construction, **the independent read
matters more for SU than for any other format in this harness, not less**. ObsPy
opening the file at all is the closest thing to a conformance statement SU can
have. That makes the unbuilt container the biggest single gap in the SU slice.

`SU-BYTE-ORDER-DECIDABLE` is the row that carries the most information. SU has no
byte-order marker of any kind, so both sides have to decide the order from
arithmetic alone, independently, and the harness reports `INCONCLUSIVE` rather
than `FAIL` if the stride closes in both orders - a file that closes both ways has
not broken a rule, it has failed to contain one. On the current output it closes
big-endian only, which is decidable, and `writeSU` does emit big-endian.

## Files

| File | Purpose |
|------|---------|
| `rules.segy.json` | the cited SEG-Y rule table, 37 rows, plus its `uncovered` list |
| `rules.segd.json` | the cited SEG-D rule table, 59 rows, plus its `uncovered` list and the Rev 1 tier scheme |
| `rules.seg2.json` | the cited SEG-2 rule table, 24 rows, plus its `uncovered` list |
| `rules.su.json` | the SU rule table, 8 rows. Read its `_authority` block first: SU has no standard document and this table is graded accordingly |
| `ebcdic-appendix-f.json` | EBCDIC to ASCII byte mapping, extracted from SEG-Y rev 2.0 Appendix F |
| `extract-ebcdic.mjs` | regenerates the above from the PDF, so a reviewer can re-run it |
| `conform.mjs` | the harness: writes with the real writers, then applies the layers each format has |

The specification PDFs stay outside the repository. Only the extracted tables
are committed, because they are small, reviewable, and carry their citations.

### Regenerating the EBCDIC table

```sh
node qa/conform/extract-ebcdic.mjs "<path to seg_y_rev2.0.pdf>"
```

The extractor refuses to write anything unless every row that names its own
character ("Latin capital letter H", "Digit seven", "Space") has an ASCII column
equal to that character's real code point. On the current PDF that self-check
covers 74 rows and 159 EBCDIC codes survive; one code is dropped as ambiguous
because `pdftotext` rendered two different ASCII targets for it, and dropping is
the only honest thing to do with a row that cannot be read cleanly.

## Quotes and dashes

`citation.quote` is transcribed with plain hyphens and plain ASCII where the PDF
uses typographic dashes or the plus-or-minus glyph (written as `+/-`). In the
SEG-D quotes the multiplication sign in the channel-set formula is written as
`*`. Nothing else in a quote is altered.

SEG-D prints hexadecimal constants with a subscript 16, which `pdftotext`
renders inline, so `3016` inside a SEG-D quote means 30 hexadecimal and `FFFF16`
means FFFF hexadecimal. That is what the page says and it is left as the page
says it; `rules.segd.json` explains the convention in `_quotesAreTranscribed`
and the affected rows give the decimal in their `checkNote`.

Page numbers come in pairs: `pagePrinted` is the number printed on the page,
`pagePdf` is the 1-based index `pdftotext -f/-l` takes. For `seg_y_rev1.0.pdf`
the offset is 3; for `seg_y_rev2.0.pdf` it is 4. For **both** `seg_d_rev2.1.pdf`
and `seg_d_rev3.0.pdf` the offset is 0, verified against the page footers, so a
reviewer can open a SEG-D citation with the printed number directly.
