# SeisConv SEG-Y oracle - an INDEPENDENT reference decoder (Equinor's segyio).
#
# The image exists so a second implementation can decode the same real field
# SEG-Y that core/formats/segy.ts decodes, and so the two answers can be
# diffed. It deliberately contains nothing else.
#
# NETWORK POLICY: the network is used HERE, at image build time, and nowhere
# else. Every `docker run` in qa/oracle/compare.mjs passes --network none and
# --read-only, and bind-mounts exactly one file read-only. See qa/oracle/README.md.
#
# Base image pinned by digest so a rebuild cannot silently pick up a different
# python:3.12-slim. Resolved with `docker pull python:3.12-slim` on 2026-09-09.
FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

# No .pyc writes (the container runs --read-only), unbuffered stdout so the
# JSON arrives whole even when the process is short-lived.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# ONLY these two. No test runner, no shell tooling, no network client.
# Versions are not pinned here; oracle.py reports the versions it actually ran
# with in its JSON, which is what the comparison record needs.
RUN pip install --no-cache-dir segyio numpy

COPY oracle.py /app/oracle.py

# No CMD arguments: the fixture is always mounted at the fixed path
# /data/input.sgy, so the container never learns the real file name.
ENTRYPOINT ["python", "/app/oracle.py"]
