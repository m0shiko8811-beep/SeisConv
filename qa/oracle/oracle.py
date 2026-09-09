"""SEG-Y reference decode via segyio, for cross-checking core/formats/segy.ts.

Runs INSIDE the container built by qa/oracle/Dockerfile. It reads exactly one
file, always mounted read-only at /data/input.sgy, and writes exactly one thing:
a JSON object on stdout. It never writes to disk and never touches the network.

The JSON shape is the contract shared with qa/oracle/ours.mjs. Keep the two in
step: qa/oracle/compare.mjs diffs them key by key.

HASH CONTRACT (identical on both sides, see qa/oracle/README.md):
  1. decode every trace to IEEE-754 binary32
  2. trace-major (C) order: all of trace 0, then all of trace 1, ...
  3. normalise -0.0 to +0.0, and every NaN to the canonical quiet NaN 0x7FC00000
     (both counted and reported, so the normalisation is never silent)
  4. serialise as little-endian binary32
  5. SHA-256 over those bytes
"""

import hashlib
import json
import os
import sys
import traceback

import numpy as np
import segyio

try:  # segyio does not expose __version__ on every release
    from importlib.metadata import version as _pkg_version

    SEGYIO_VERSION = _pkg_version("segyio")
except Exception:  # pragma: no cover
    SEGYIO_VERSION = getattr(segyio, "__version__", "unknown")

PATH = "/data/input.sgy"
CANON_NAN = np.uint32(0x7FC00000)
NEG_ZERO = np.uint32(0x80000000)

# Bytes per sample keyed by the SEG-Y data sample format code (bytes 3225-3226).
# Used only for the file-size consistency check that picks the byte order.
BPS = {1: 4, 2: 4, 3: 2, 4: 4, 5: 4, 6: 8, 7: 3, 8: 1, 9: 8, 10: 4, 11: 2, 12: 8, 15: 3, 16: 1}


def binfield(name):
    """segyio.BinField member by name, or None on a segyio that lacks it."""
    return getattr(segyio.BinField, name, None)


def read_bin(f, name):
    key = binfield(name)
    if key is None:
        return None
    try:
        return int(f.bin[key])
    except Exception:
        return None


def probe(endian):
    """Open the file asserting `endian`, and report what segyio makes of it.

    segyio does NOT auto-detect byte order, so both orders are tried and the one
    whose header arithmetic closes exactly on the real file size wins. That test
    is independent of anything SeisConv reported.
    """
    out = {"endian": endian, "opened": False, "consistent": False, "error": None}
    try:
        with segyio.open(PATH, "r", ignore_geometry=True, endian=endian) as f:
            fmt = read_bin(f, "Format")
            ns = len(f.samples)
            tc = int(f.tracecount)
            ext = int(getattr(f, "ext_headers", 0) or 0)
            out.update(opened=True, format=fmt, samples_per_trace=ns, trace_count=tc,
                       ext_headers=ext, sample_interval_us=read_bin(f, "Interval"),
                       dtype=str(f.dtype))
            bps = BPS.get(fmt or 0, 0)
            size = os.path.getsize(PATH)
            predicted = 3600 + ext * 3200 + tc * (240 + ns * bps)
            out["file_size"] = size
            out["predicted_size"] = predicted
            out["consistent"] = bool(bps and predicted == size)
    except Exception as exc:  # segyio raises on a non-integer trace count
        out["error"] = "{}: {}".format(type(exc).__name__, exc)
    return out


def canon_dec(v):
    """Full-precision, format-identical decimal for one binary32 value.

    9 significant digits round-trip binary32 exactly. The exponent is padded to
    two digits so Node's toExponential and Python's %e agree character for
    character; the hex bit pattern beside it is the authoritative comparison.
    """
    if np.isnan(v):
        return "NaN"
    if np.isinf(v):
        return "Infinity" if v > 0 else "-Infinity"
    return "{:.8e}".format(float(v))


def preview(bits_row, n=8):
    """First n and last n samples of one trace, as bit pattern plus decimal."""
    def one(u):
        v = np.frombuffer(np.uint32(u).astype("<u4").tobytes(), dtype="<f4")[0]
        return {"hex": "{:08x}".format(int(u)), "dec": canon_dec(v)}
    head = [one(u) for u in bits_row[:n]]
    tail = [one(u) for u in bits_row[-n:]]
    return {"first8": head, "last8": tail}


def main():
    if not os.path.exists(PATH):
        json.dump({"ok": False, "error": "no file mounted at /data/input.sgy"}, sys.stdout)
        return 3

    attempts = [probe("big"), probe("little")]
    chosen = None
    for a in attempts:
        if a["opened"] and a["consistent"]:
            chosen = a  # 'big' is tried first, so it wins a tie
            break
    if chosen is None:
        for a in attempts:
            if a["opened"]:
                chosen = a
                break
    if chosen is None:
        json.dump({"ok": False, "error": "segyio could not open the file in either byte order",
                   "attempts": attempts}, sys.stdout)
        return 4

    endian = chosen["endian"]
    little = endian == "little"

    # The declared revision is two single bytes (3501 major, 3502 minor; 0-based
    # 3500/3501). Read them raw so both sides talk about the same quantity
    # regardless of which segyio release is installed - segyio splits the field
    # into SEGYRevision/SEGYRevisionMinor in some versions and not in others.
    with open(PATH, "rb") as fh:
        fh.seek(3500)
        rev_raw = fh.read(2)
    rev_major = rev_raw[1] if little else rev_raw[0]
    rev_minor = rev_raw[0] if little else rev_raw[1]

    with segyio.open(PATH, "r", ignore_geometry=True, endian=endian) as f:
        m = f.trace.raw[:]  # shape (traces, samples)
        seg_rev = read_bin(f, "SEGYRevision")
        seg_rev_minor = read_bin(f, "SEGYRevisionMinor")
        result = {
            "ok": True,
            "impl": "segyio",
            "segyio_version": SEGYIO_VERSION,
            "numpy_version": np.__version__,
            "byte_order": "little" if little else "big",
            "trace_count": int(f.tracecount),
            "samples_per_trace": int(len(f.samples)),
            "sample_interval_us": read_bin(f, "Interval"),
            "data_format_code": read_bin(f, "Format"),
            "revision_major": int(rev_major),
            "revision_minor": int(rev_minor),
            "ext_headers": int(getattr(f, "ext_headers", 0) or 0),
            "native_dtype": str(f.dtype),
            "segyio_bin_revision": seg_rev,
            "segyio_bin_revision_minor": seg_rev_minor,
        }

    # --- hash contract, steps 1-5 ---------------------------------------
    flat = np.ascontiguousarray(m, dtype="<f4").reshape(-1)
    bits = np.frombuffer(flat.tobytes(), dtype="<u4").copy()

    nan_mask = np.isnan(np.frombuffer(bits.tobytes(), dtype="<f4"))
    n_nan = int(nan_mask.sum())
    bits[nan_mask] = CANON_NAN
    negzero = bits == NEG_ZERO
    n_negzero = int(negzero.sum())
    bits[negzero] = np.uint32(0)

    result["normalised_nan"] = n_nan
    result["normalised_neg_zero"] = n_negzero
    result["sample_matrix_sha256"] = hashlib.sha256(bits.astype("<u4").tobytes()).hexdigest()
    result["sample_matrix_values"] = int(bits.size)

    tc = result["trace_count"]
    ns = result["samples_per_trace"]
    grid = bits.reshape(tc, ns) if tc * ns == bits.size else None
    mid = tc // 2
    result["middle_trace_index"] = mid
    if grid is not None:
        result["trace0"] = preview(grid[0])
        result["trace_mid"] = preview(grid[mid])

    json.dump(result, sys.stdout, sort_keys=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Never let a traceback reach stdout - stdout is the JSON channel only.
        traceback.print_exc(file=sys.stderr)
        json.dump({"ok": False, "error": "oracle crashed, see stderr"}, sys.stdout)
        sys.exit(5)
