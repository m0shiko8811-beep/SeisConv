# SeisConv SEG-D oracle - an INDEPENDENT reference decoder (sedaman).
#
# This image is the answer to a claim this repository used to make and that
# turned out to be false. qa/conform printed "independent read: NO READER
# EXISTS" on every SEG-D line, on the stated grounds that no independent SEG-D
# implementation was available. There are several. sedaman
# (https://github.com/andalevor/sedaman, LGPL-3.0) reads SEG-D Rev 1, Rev 2 and
# Rev 3 - which is exactly the pair of revisions SeisConv's writeSEGD emits,
# Rev 1 and Rev 3 - and is C++20 by an unrelated author with no relationship to
# SeisConv of any kind. See qa/oracle/README.md for the alternatives that were
# considered and why this one was chosen.
#
# BUILD CONTEXT IS qa/oracle, NOT THIS DIRECTORY, so the one shared copy of the
# hash contract can be baked in rather than transcribed a third time:
#
#   docker build -t seisconv-segd-oracle:1 -f qa/oracle/segd/Dockerfile qa/oracle
#
# NETWORK POLICY: the network is used HERE, at image build time, and nowhere
# else. Every `docker run` in qa/conform/conform.mjs passes --network none and
# --read-only, and bind-mounts exactly one file read-only at the fixed target
# /data/input.sgd, so the container never learns the real file name. The flags
# are the same set qa/oracle/compare.mjs uses, produced by one function.
#
# Base image pinned by digest, the SAME digest qa/oracle/Dockerfile pins, so the
# oracle images stand on identical bits. That digest was resolved with
# `docker pull python:3.12-slim` on 2026-09-09; it is reused rather than
# re-resolved because the docker daemon is not running on this machine and a
# digest nobody verified today would be a worse claim than one already in the
# tree with a date on it.
#
# NOT YET BUILT. The daemon was down when this was written, so this Dockerfile
# has never been run. What is unverified, and the exact commands, are listed in
# qa/oracle/README.md under "What still needs docker".
#
# sedaman is a C++20 source library with no wheel and no distro package, so
# unlike segyio and obspy it has to be compiled. The toolchain is installed in a
# BUILDER stage and does not survive into the final image.
#
# The commit is pinned. sedaman has no releases and no tags; "master" would make
# every rebuild a different reference implementation, which is the one thing a
# reference implementation may not be. fb22fa29 is master as of 2024-06-24,
# "updated pybind and fixed modifying of trace header from python".

# ---------------------------------------------------------------- builder
FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea AS builder
ARG SEDAMAN_COMMIT=fb22fa29539741e21d804cbf8e4b540c1b4b467c
ENV DEBIAN_FRONTEND=noninteractive

# g++ 12 on bookworm is what gives C++20, which sedaman's CMakeLists requires
# (CMAKE_CXX_STANDARD 20, CMAKE_CXX_STANDARD_REQUIRED ON). The apt packages are
# NOT version-pinned; that is a real reproducibility gap and it is stated rather
# than papered over. The base image digest is pinned, so the package set is at
# least the one that bookworm-slim resolved to on the build date recorded in the
# image labels.
RUN apt-get update \
 && apt-get install --no-install-recommends -y build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pybind11 comes in as sedaman's one git submodule (extern/pybind11, declared
# with a URL relative to the sedaman repository, so it resolves to
# github.com/pybind/pybind11). Checking the pinned commit out FIRST and
# initialising submodules after it means the pybind11 revision is the one that
# commit recorded, not whatever pybind11's stable branch points at today.
RUN git clone https://github.com/andalevor/sedaman /src/sedaman \
 && cd /src/sedaman \
 && git checkout "${SEDAMAN_COMMIT}" \
 && git submodule update --init --recursive

# Only the pysedaman target is built. sedaman's CMakeLists also declares
# sedaman, sedaman_static and add_subdirectory(tests); building just the python
# module keeps the toolchain's work down, and if the tests subdirectory ever
# fails to CONFIGURE this is the line that will say so.
RUN cmake -S /src/sedaman -B /src/build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /src/build --target pysedaman -j"$(nproc)" \
 && mkdir -p /out \
 && find /src/build -name 'pysedaman*.so' -exec cp {} /out/ \; \
 && test -n "$(ls -A /out)"

# ---------------------------------------------------------------- runtime
FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea
ARG SEDAMAN_COMMIT=fb22fa29539741e21d804cbf8e4b540c1b4b467c

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    SEDAMAN_COMMIT=${SEDAMAN_COMMIT}

# numpy only. No compiler, no git, no shell tooling, no network client: the
# builder stage is discarded and what lands here is the compiled module, numpy
# and two scripts.
RUN pip install --no-cache-dir numpy

# libstdc++ from the builder's g++ 12 is newer than the runtime image's, and the
# module is linked against it. Copying the runtime library only - not the
# compiler - keeps the final image free of a toolchain while still letting the
# module load.
COPY --from=builder /usr/lib/x86_64-linux-gnu/libstdc++.so.6 /usr/lib/x86_64-linux-gnu/libstdc++.so.6
COPY --from=builder /out/ /app/

COPY hashcontract.py /app/hashcontract.py
COPY segd/oracle_segd.py /app/oracle_segd.py

# No CMD arguments: the fixture is always mounted at the fixed path
# /data/input.sgd, so the container never learns the real file name.
ENTRYPOINT ["python", "/app/oracle_segd.py"]
