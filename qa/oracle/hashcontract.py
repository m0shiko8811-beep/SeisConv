"""The sample-matrix hash contract, for the Python side of every oracle image.

The contract is DEFINED in qa/oracle/README.md, "The hash contract", and was
fixed before any comparison was ever run. This module is one transcription of
it, shared by the container scripts that were added after the SEG-Y one:

  qa/oracle/obspy/oracle_obspy.py   SEG-2 and Seismic Unix, via ObsPy
  qa/oracle/segd/oracle_segd.py     SEG-D, via sedaman

qa/oracle/oracle.py keeps its own inline copy of the same arithmetic and is
deliberately NOT changed to import this file: its image, seisconv-segy-oracle:1,
is already built and pinned, and editing the script would silently put the
source out of step with the image somebody already has. The two are line-for-
line comparable and the Node side, qa/oracle/hash.mjs, is the third.

Steps, verbatim from the README:
  1. every sample decoded to IEEE-754 binary32
  2. trace-major (C) order: all of trace 0's samples, then all of trace 1's
  3. every NaN rewritten to the canonical quiet NaN 0x7FC00000, and -0.0 to +0.0,
     both counted and reported so the normalisation is never silent
  4. serialised as LITTLE-ENDIAN binary32 regardless of host byte order
  5. SHA-256 over the resulting byte stream
"""

import hashlib

import numpy as np

CANON_NAN = np.uint32(0x7FC00000)
NEG_ZERO = np.uint32(0x80000000)


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


def fold(result, matrix, trace_count, samples_per_trace):
    """Apply steps 1 to 5 to `matrix` and fold the answer into `result`.

    `matrix` is any array-like of shape (traces, samples). It is cast to
    binary32 once, here: a reader that hands back float64 (sedaman does) is
    narrowed at this single point rather than in each caller, and a reader that
    is already float32 is unchanged by the cast.
    """
    flat = np.ascontiguousarray(matrix, dtype="<f4").reshape(-1)
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

    grid = bits.reshape(trace_count, samples_per_trace) \
        if trace_count * samples_per_trace == bits.size else None
    mid = trace_count // 2
    result["middle_trace_index"] = mid
    if grid is not None:
        result["trace0"] = preview(grid[0])
        result["trace_mid"] = preview(grid[mid])
    return result
