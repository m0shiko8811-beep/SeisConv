# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in SeisConv, please report it
**privately**. Do not open a public issue, pull request, or discussion for
security problems.

Preferred reporting channel:

- Use GitHub's **private vulnerability reporting** for this repository:
  [**Report a vulnerability**](https://github.com/m0shiko8811-beep/SeisConv/security/advisories/new).
  The report stays private between you and the maintainer until a fix is
  published, and GitHub handles the disclosure workflow.
- If you cannot use GitHub, email **m0shiko8811@gmail.com** with `SeisConv
  security` in the subject line.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal sample file or input is ideal - **do not send
  real survey data or client coordinates**; use synthetic data).
- The SeisConv version (see the About / Audit panel) and your OS.

## Supported versions

Only the latest released version receives security fixes. There are no
long-term support branches.

| Version | Supported |
| ------- | --------- |
| 0.8.x   | Yes       |
| < 0.8   | No        |

## Scope

SeisConv is an offline desktop application. The most relevant security surface
is **parsing untrusted input files** (SEG-Y, SEG-D, SEG-2, SU, Tape Image, SPS,
positioning formats). Parser-level denial-of-service (memory/CPU exhaustion
from malformed files) and any sandbox-escape in the Electron renderer are
in scope.

## Response

We aim to acknowledge a valid report within a reasonable time and to address
confirmed vulnerabilities in a future release. There is no bug-bounty program.

## Disclosure

Please allow a reasonable period to investigate and remediate before any public
disclosure.
