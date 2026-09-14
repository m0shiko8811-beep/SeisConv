# SeisConv SEG-2 and Seismic Unix oracle - an INDEPENDENT reference decoder
# (ObsPy, LGPL-3.0, github.com/obspy/obspy).
#
# The image exists so a second implementation can decode the SEG-2 that
# core/formats/seg2.ts wrote and the SU that core/formats/su.ts wrote, and so
# the two answers can be diffed. Nothing is installed beyond obspy and the
# dependencies pip pulls in with it, which are named and explained below.
#
# BUILD CONTEXT IS qa/oracle, NOT THIS DIRECTORY, so the one shared copy of the
# hash contract can be baked in rather than transcribed a third time:
#
#   docker build -t seisconv-obspy-oracle:1 -f qa/oracle/obspy/Dockerfile qa/oracle
#
# NETWORK POLICY: the network is used HERE, at image build time, and nowhere
# else. Every `docker run` in qa/conform/conform.mjs passes --network none and
# --read-only, and bind-mounts exactly one file read-only at the fixed target
# /data/input.bin, so the container never learns the real file name. The flags
# are the same set qa/oracle/compare.mjs uses, produced by one function.
#
# Base image pinned by digest, the SAME digest qa/oracle/Dockerfile pins, so the
# two oracle images stand on identical bits. That digest was resolved with
# `docker pull python:3.12-slim` on 2026-09-09; it is reused rather than
# re-resolved because the docker daemon is not running on this machine and a
# digest nobody verified today would be a worse claim than a digest that is
# already in the tree with a date on it.
#
# PLATFORM: linux/amd64. PyPI ships obspy 1.5.1 as
# obspy-1.5.1-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl and
# publishes NO linux aarch64 wheel, so on an arm64 host pip would fall back to
# the sdist and try to compile obspy's libsegy C extension, which this slim
# image has no compiler for. On an arm64 host, add --platform linux/amd64 to the
# build command above.
FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

# No .pyc writes (the container runs --read-only), unbuffered stdout so the
# JSON arrives whole even when the process is short-lived.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# obspy is PINNED by version, unlike qa/oracle's segyio. It has to be: obspy's
# SEG-2 data format code 3 support arrived in 1.2.0 and its unreleased master
# already raises the floor to numpy>=2.2, so "whatever pip resolves today" is
# not a reference implementation anybody can reproduce. oracle_obspy.py reports
# the version it actually ran with, which is what the comparison record needs.
#
# obspy pulls matplotlib, scipy, lxml, sqlalchemy, decorator and requests as
# hard dependencies. None of them is imported when reading SEG-2 or SU - every
# matplotlib import in obspy sits inside a plotting function, and neither
# obspy.io.seg2 nor obspy.io.segy touches it - but pip installs them anyway.
# They are left in place: uninstalling a declared dependency to shave the image
# would make this container something other than a stock obspy.
RUN pip install --no-cache-dir "obspy==1.5.1"

# The hash contract, shared with qa/oracle/segd. Copied from the build context
# root (qa/oracle), which is why the build command above passes -f.
COPY hashcontract.py /app/hashcontract.py
COPY obspy/oracle_obspy.py /app/oracle_obspy.py

# The fixture is always mounted at the fixed path /data/input.bin. The ONE
# argument this entrypoint takes is the format name, "seg2" or "su" - a format
# name leaks nothing, and SEG-2 and SU are both content-sniffable formats that
# obspy would otherwise have to guess at (its own _is_su calls itself "rather
# shaky"), so the format is stated rather than detected.
ENTRYPOINT ["python", "/app/oracle_obspy.py"]
