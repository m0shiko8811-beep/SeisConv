"""SEG-D reference decode via sedaman, for cross-checking core/formats/segd.ts.

Runs INSIDE the container built by qa/oracle/segd/Dockerfile. It reads exactly
one file, always mounted read-only at /data/input.sgd, and writes exactly one
thing: a JSON object on stdout. It never writes to disk and never touches the
network.

WHY THIS EXISTS. Until now SEG-D had no independent reader here at all, and
qa/conform said so on its own line: "independent read: NO READER EXISTS".
That statement was wrong, and this file is the correction. sedaman
(github.com/andalevor/sedaman, LGPL-3.0, C++20) reads SEG-D Rev 1, Rev 2 and
Rev 3 and is written by an unrelated author in an unrelated language; it has no
relationship of any kind to SeisConv. Its Python bindings, pysedaman, are what
this script drives.

WHAT IS STILL NOT PROVEN. Nothing here has been run. The docker daemon was not
running on the machine where this was written, so this script has never decoded
a byte. qa/conform/conform.mjs reports an unbuilt or unreachable image exactly
the way it does for SEG-Y, and the SEG-D verdict line says NOT RUN rather than
claiming agreement. See qa/oracle/README.md, "What still needs docker".

PRIVACY. The fixtures are real field seismic. sedaman exposes
general_header_client_name(), general_header_survey_name(),
general_header_job_id() and general_header_line_id(); NONE of them is called
here and none may ever be. A survey, site, client or job name must never reach a
console, a log or a commit. This script emits numbers and the sample-matrix
digest, nothing else.

HASH CONTRACT. qa/oracle/hashcontract.py, which is the contract fixed in
qa/oracle/README.md. sedaman hands back C++ doubles; hashcontract.fold casts to
binary32 at one point. For the format code SeisConv writes - 8058, 32 bit IEEE -
that cast is exact, because the value was a binary32 on disk and widening to
binary64 and back is lossless. For a format whose on-disk sample carries more
than 24 significant bits the cast would NOT be exact, and the sample_format_code
reported below is what tells a reader which case applies.
"""

import json
import os
import sys
import traceback

import numpy as np

sys.path.insert(0, "/app")
from hashcontract import fold  # noqa: E402  (after sys.path, deliberately)

PATH = "/data/input.sgd"
# A record with more traces than this is not something SeisConv writes, and an
# unbounded loop over a third-party reader is how a harness hangs.
MAX_TRACES = 500000


def field(obj, name):
    """One scalar field, or None.

    sedaman's pybind surface is wide and its field names are not a published,
    versioned API, so every read here is defensive: a name that moved between
    commits must degrade to a missing key, never to a traceback that a reader
    could mistake for a SeisConv failure. The commit is pinned in the
    Dockerfile, so a missing key means the pin moved and wants looking at.
    """
    if obj is None:
        return None
    try:
        v = getattr(obj, name)
    except Exception:
        return None
    try:
        v = v() if callable(v) else v
    except Exception:
        return None
    if v is None or isinstance(v, bool):
        return int(v) if isinstance(v, bool) else None
    return v if isinstance(v, (int, float)) else None


def return_json(result):
    json.dump(result, sys.stdout, sort_keys=True)


def main():
    if not os.path.exists(PATH):
        return_json({"ok": False, "error": "no file mounted at " + PATH})
        return 3

    import pysedaman

    f = pysedaman.ISEGD(PATH)
    gh = f.general_header()
    try:
        gh2 = f.general_header2()
    except Exception:
        gh2 = None

    result = {
        "ok": True,
        "impl": "sedaman (pysedaman)",
        "sedaman_commit": os.environ.get("SEDAMAN_COMMIT", "unknown"),
        "numpy_version": np.__version__,
        "format": "SEG-D",
        "sample_format_code": field(gh, "format_code"),
        "additional_general_header_blocks": field(gh, "add_gen_hdr_blocks"),
        "scan_types_per_record": field(gh, "scan_types_per_record"),
        "channel_sets_per_scan_type": field(gh, "channel_sets_per_scan_type"),
        "extended_header_blocks": field(gh, "extended_hdr_blocks"),
        "external_header_blocks": field(gh, "external_hdr_blocks"),
        "revision_major": field(gh2, "segd_rev_major"),
        "revision_minor": field(gh2, "segd_rev_minor"),
        "general_trailer_blocks": field(gh2, "gen_trailer_num_of_blocks"),
    }

    try:
        result["general_header_block_3_present"] = f.general_header3() is not None
    except Exception:
        result["general_header_block_3_present"] = None

    base_scan_ms = field(gh, "base_scan_int")

    # Channel set headers: one list per scan type. Only the numbers the
    # comparison needs are taken. description() is skipped on purpose - it is a
    # free-text field that can name a site.
    csds = []
    ch_samp_int_us = None
    try:
        for scan_type in f.channel_set_headers():
            for cs in scan_type:
                ns = field(cs, "number_of_samples")
                si = field(cs, "samp_int")
                csds.append({
                    "channel_set_number": field(cs, "channel_set_number"),
                    "channel_type": field(cs, "channel_type"),
                    "number_of_channels": field(cs, "number_of_channels"),
                    "number_of_samples": ns,
                    "samp_int_us": si,
                    "trace_header_extensions": field(cs, "trc_hdr_ext"),
                    "vertical_stack": field(cs, "vert_stack"),
                })
                if si is not None and ch_samp_int_us is None:
                    ch_samp_int_us = int(si)
    except Exception as exc:
        result["channel_set_read_error"] = type(exc).__name__ + ": " + str(exc)[:200]
    result["channel_sets"] = csds

    # Rev 3 states the sample interval per channel set, in microseconds; Rev 1
    # has only General Header Block #1's base scan interval, in milliseconds.
    # Which one was used is reported, never guessed at silently.
    if ch_samp_int_us is not None:
        result["sample_interval_us"] = ch_samp_int_us
        result["sample_interval_source"] = "channel set descriptor"
    elif base_scan_ms is not None:
        result["sample_interval_us"] = int(round(float(base_scan_ms) * 1000.0))
        result["sample_interval_source"] = "general header block 1 base scan interval"
    else:
        result["sample_interval_us"] = None
        result["sample_interval_source"] = "not available from this reader"

    def take(tr):
        try:
            return np.asarray(tr.samples_as_numpy_array())
        except Exception:
            return np.asarray(tr.samples(), dtype="f8")

    # ITERATION, NOT A HAND-ROLLED LOOP. pysedaman binds __iter__/__next__ on
    # ISEGD, and the binding owns the protocol: has_record() and has_trace() are
    # two separate predicates whose interaction across a record boundary is not
    # documented anywhere, and a hand-rolled `while has_record(): while
    # has_trace():` spins forever if has_record() stays true once the last record
    # is drained. Nothing here has ever been run against real sedaman, so the
    # loop that CANNOT hang is the one to use, with the manual walk kept only as
    # a fallback for a binding that turns out not to be iterable - and that
    # fallback breaks out the moment a record yields no trace.
    rows = []
    overflow = False
    try:
        for tr in f:
            rows.append(take(tr))
            if len(rows) > MAX_TRACES:
                overflow = True
                break
        result["trace_walk"] = "iterator"
    except TypeError:
        result["trace_walk"] = "has_record/has_trace fallback"
        while f.has_record():
            before = len(rows)
            while f.has_trace():
                rows.append(take(f.read_trace()))
                if len(rows) > MAX_TRACES:
                    overflow = True
                    break
            if overflow or len(rows) == before:
                break
    if overflow:
        result["ok"] = False
        result["error"] = "more than " + str(MAX_TRACES) + " traces; refusing to continue"
        result["trace_count"] = len(rows)
        return_json(result)
        return 5

    if not rows:
        result["ok"] = False
        result["error"] = "sedaman returned 0 traces"
        return_json(result)
        return 4

    lengths = {int(r.size) for r in rows}
    result["trace_count"] = len(rows)
    if len(lengths) != 1:
        result["ok"] = False
        result["error"] = "ragged trace lengths - no rectangular sample matrix to hash"
        result["trace_lengths"] = sorted(lengths)[:10]
        return_json(result)
        return 5
    result["samples_per_trace"] = lengths.pop()
    result["sample_dtype_from_reader"] = str(rows[0].dtype)

    fold(result, np.vstack(rows), result["trace_count"], result["samples_per_trace"])
    return_json(result)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        # Never let a traceback reach stdout - stdout is the JSON channel only.
        traceback.print_exc(file=sys.stderr)
        return_json({"ok": False, "impl": "sedaman (pysedaman)",
                     "error": type(exc).__name__ + ": " + str(exc)[:400]})
        sys.exit(4)
