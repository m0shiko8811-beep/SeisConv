"""SEG-2 and Seismic Unix reference decode via ObsPy.

Runs INSIDE the container built by qa/oracle/obspy/Dockerfile. It reads exactly
one file, always mounted read-only at /data/input.bin, and writes exactly one
thing: a JSON object on stdout. It never writes to disk and never touches the
network. Usage:

    <entrypoint> seg2      decode the mounted file as SEG-2
    <entrypoint> su        decode the mounted file as Seismic Unix

WHY OBSPY. `core/formats/seg2.ts` and `core/formats/su.ts` are tested largely
against fixtures SeisConv's own writer produced, so a reader and a writer that
share a mistake still pass. ObsPy (LGPL-3.0, github.com/obspy/obspy) is an
independent implementation by unrelated authors, and its SEG-2 reader
(obspy/io/seg2/seg2.py) and SU reader (obspy/io/segy/core.py::_read_su) are the
second opinion this harness needs.

WHAT IS AND IS NOT INDEPENDENT HERE. Every number below that comes out of a
Stream or a Trace was decoded by ObsPy. ObsPy consumes and then DISCARDS the
SEG-2 fixed fields - byte order, revision number, the data format code, the
declared sample count - so they are not available from it at all, and this
script does not re-read them out of the bytes to fill the gap: a field parsed
by this script would be parsed by code written for this harness, which is not an
independent read and must not be printed as though it were. Those fields are
checked by the cited rule table in qa/conform/rules.seg2.json instead.

PRIVACY. The fixtures are real field seismic. SEG-2 free-form headers routinely
carry CLIENT, COMPANY, JOB_ID, OBSERVER and NOTE strings naming a real survey,
site or crew. This script emits the free-form KEY NAMES and never a value.

The format argument is the only thing passed in. The mount target is fixed, so
the container never learns the real file name.
"""

import json
import os
import sys
import traceback
import warnings

import numpy as np

sys.path.insert(0, "/app")
from hashcontract import fold  # noqa: E402  (after sys.path, deliberately)

PATH = "/data/input.bin"


def version_of(name):
    try:
        from importlib.metadata import version as _pkg_version

        return _pkg_version(name)
    except Exception:
        return "unknown"


def uniform_npts(stream):
    """The common sample count, or None when the traces are ragged.

    A ragged file has no rectangular matrix to hash. Refusing is the same
    decision qa/oracle/ours.mjs makes; concatenating a jagged array would
    produce a digest that means nothing.
    """
    counts = {int(tr.stats.npts) for tr in stream}
    return counts.pop() if len(counts) == 1 else None


def read_seg2():
    import obspy

    st = obspy.read(PATH, format="SEG2")
    ns = uniform_npts(st)
    if ns is None:
        return {"ok": False, "impl": "obspy.io.seg2",
                "error": "ragged trace lengths - no rectangular sample matrix to hash"}

    # Key NAMES only. A SEG-2 value can name a survey, a client or a crew.
    keys = set()
    for tr in st:
        keys.update(getattr(tr.stats, "seg2", {}).keys())

    # SAMPLE_INTERVAL is in SECONDS in a conformant SEG-2 file and ObsPy puts it
    # straight into stats.delta. Report microseconds so the number is comparable
    # with every other format in this harness.
    delta = float(st[0].stats.delta)
    result = {
        "ok": True,
        "impl": "obspy.io.seg2",
        "obspy_version": version_of("obspy"),
        "numpy_version": np.__version__,
        "format": "SEG-2",
        "trace_count": len(st),
        "samples_per_trace": int(ns),
        "sample_interval_us": int(round(delta * 1e6)),
        "sample_dtype": str(st[0].data.dtype),
        "free_form_keys": sorted(keys),
    }
    matrix = np.vstack([tr.data for tr in st])
    return fold(result, matrix, result["trace_count"], result["samples_per_trace"])


def read_su():
    import obspy

    # byteorder is left unset on purpose. ObsPy auto-detects it
    # (obspy/io/segy/segy.py::autodetect_endian_and_sanity_check_su) from the
    # header arithmetic alone, so the byte order it reports is a real second
    # opinion about the written file rather than an echo of what we asked for.
    st = obspy.read(PATH, format="SU", unpack_trace_headers=True)
    ns = uniform_npts(st)
    if ns is None:
        return {"ok": False, "impl": "obspy.io.segy._read_su",
                "error": "ragged trace lengths - no rectangular sample matrix to hash"}

    su = getattr(st[0].stats, "su", None)
    endian = getattr(su, "endian", None) if su is not None else None
    hdr = getattr(su, "trace_header", None) if su is not None else None

    def hdr_int(name):
        try:
            return int(getattr(hdr, name))
        except Exception:
            return None

    result = {
        "ok": True,
        "impl": "obspy.io.segy._read_su",
        "obspy_version": version_of("obspy"),
        "numpy_version": np.__version__,
        "format": "SU",
        "trace_count": len(st),
        "samples_per_trace": int(ns),
        # ObsPy decodes the 240 bytes with the SEG-Y rev 1 trace-header table,
        # so these two are that table's names for bytes 115-116 and 117-118.
        "sample_interval_us": hdr_int("sample_interval_in_ms_for_this_trace"),
        "header_samples_per_trace": hdr_int("number_of_samples_in_this_trace"),
        "trace_id_code": hdr_int("trace_identification_code"),
        "byte_order": {">": "big", "<": "little"}.get(endian, str(endian)),
        "sample_dtype": str(st[0].data.dtype),
    }
    matrix = np.vstack([tr.data for tr in st])
    return fold(result, matrix, result["trace_count"], result["samples_per_trace"])


READERS = {"seg2": read_seg2, "su": read_su}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in READERS:
        json.dump({"ok": False, "error": "usage: <entrypoint> seg2|su"}, sys.stdout)
        return 2
    if not os.path.exists(PATH):
        json.dump({"ok": False, "error": "no file mounted at " + PATH}, sys.stdout)
        return 3
    # ObsPy's SEG-2 reader warns on every single read, and warns again on a
    # non-zero DELAY or an unparseable date. Warnings belong on stderr; stdout
    # is the JSON channel and nothing else may reach it.
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        result = READERS[sys.argv[1]]()
        # Message text only, and only from ObsPy's own warning classes - a
        # warning that quoted a path would be a leak.
        result["reader_warnings"] = sorted({str(w.message)[:200] for w in caught})
    json.dump(result, sys.stdout, sort_keys=True)
    return 0 if result.get("ok") else 4


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        # Never let a traceback reach stdout - stdout is the JSON channel only.
        # The class and message go to stdout as structured JSON; the traceback
        # goes to stderr, where qa/conform/conform.mjs redacts it before it is
        # printed.
        traceback.print_exc(file=sys.stderr)
        json.dump({"ok": False, "impl": "obspy",
                   "error": type(exc).__name__ + ": " + str(exc)[:400]}, sys.stdout)
        sys.exit(4)
