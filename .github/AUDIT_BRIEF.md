# Scheduled audit brief

A cloud agent runs this twice a week and reports back. It starts with zero context, so
everything it needs is here.

SeisConv is a free, open source Windows desktop seismic toolkit written by Moshe Fridin, a
working lead seismic field engineer. AGPL v3. It ships as an unsigned NSIS installer plus PDF
manuals on GitHub Releases.

Read `README.md`, `CHANGELOG.md` and the code before asserting anything.

## Job, in priority order

### 1. Truth

Check every factual and numeric claim in the README against the code: counts of formats, tabs,
colour maps, gain laws, tests, manual pages, CRS coverage, pixel oracle states, and every
absolute statement of the form "the only", "always", "never".

Produce a table: claim, `file:line`, verdict, and the `file:line` of the evidence.

Run `npm ci` then `npm run test:core` and use the real number rather than trusting the README.
A wrong number on a public page costs more than an ugly one.

Absolutes deserve special suspicion. "The only feature that touches the internet" was false for
months because a second feature was advertised twelve lines further down the same file.

### 2. Figures against captions

Every image sits under a heading and a caption. Read the images and confirm each one shows what
its surrounding text claims.

This has failed before: a four tile contact sheet once sat under a heading reading "Twelve tabs,
one application". Check counts, check that a before and after pair really is the same record, and
check that no text in a figure is cut through the middle of a word.

### 3. Sync with the live remote

Is the latest Release the current installer. Are the attached manual PDFs current. Do
`package.json`, `package-lock.json`, `CHANGELOG.md`, `CITATION.cff`, the git tag and the installer
filename all agree on one version. Does the README's download link resolve.

### 4. Marketing and positioning

Judged as a product page, not as documentation, and judged for its actual audience: field crews,
party chiefs, observers and processing geophysicists.

- Does the first screen say what this is, what it costs, and what to click.
- Is the opening a claim a working geophysicist would nod at, or is it a feature list.
- Is anything oversold. **Understating is the house style.** Flag any sentence that promises more
  than the code delivers, and prefer the weaker true claim every time.
- Are the community health files present and current: LICENSE, NOTICE, SECURITY.md,
  CODE_OF_CONDUCT.md, CONTRIBUTING.md, issue and PR templates.
- Discoverability: About text, topics, and whether the README's own words match what someone
  would actually search for.

### 5. Links and rot

Every external link resolves. Every relative link and in-page anchor resolves. Every image path
exists. No link points at a moved or renamed heading.

## What you may fix, and what you may not

**Fix, on a branch, and open a pull request:** typos, broken relative links, stale numbers where
you have the evidence in hand, a caption that contradicts its own figure, a dead anchor, a
formatting break.

**Do not fix, report instead:** anything about the product's voice or positioning, anything that
changes what the software claims to do, anything requiring a judgement about Moshe's own work,
and anything you are not certain about.

## Hard limits

- **Never push to `main`.** Work on a branch and open a pull request. Nothing you do reaches
  visitors without a human merging it.
- **Never create, edit or delete a release or a tag.**
- **Never change repository settings**, visibility, About, topics or the social preview.
- **Never touch `.git/hooks/`.**
- Never commit anything under `design/promo/candidates*`, `design/readme-options/` or
  `design/_retracted/`. The last one holds a figure with a false claim baked into its pixels and
  must never be published.
- No em dashes anywhere, in code, prose or commit messages.

## Privacy, absolute

Published files and published pixels carry no real survey names, client names, coordinates,
station or line numbers, dataset filenames, or machine paths. If you find one, **report its
location without reproducing the value.**

Two deliberate exceptions that must NOT be flagged as leaks: `moshef@gii.co.il` is the project
contact address, and the README Acknowledgements section names an institute immediately followed
by a disclaimer. Those two belong together and neither is a mistake.

## The report

Email the full report to `m0shiko8811@gmail.com` and write it into the session as well. Lead with
what is WRONG, since that is the answer he wants first. Then what you fixed and the pull request
link. Then what you checked and found correct, briefly.

State plainly what you verified against the live remote versus what you assumed, and say when you
could not check something rather than passing over it. If you found nothing wrong, say that in
one line and do not pad it.
