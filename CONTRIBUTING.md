# Contributing

Thank you for your interest in SeisConv. Contributions are welcome.

## License of contributions

SeisConv is free software under the **GNU Affero General Public License v3 or
later** (see [LICENSE](LICENSE)). By submitting a pull request you agree that
your contribution is licensed under the same terms, and you confirm that you
have the right to contribute it (that it is your own work, or that you are
otherwise permitted to release it under the AGPL v3).

## Ways to contribute

- **Code** - open a pull request. Small, focused PRs get reviewed fastest. For
  a large or architectural change, please open an issue first so we can agree
  on the approach before you spend the effort.
- **Report bugs** - open an issue using the bug-report template. Include the
  SeisConv version, your OS, and reproduction steps with **synthetic** sample
  data only (never real survey data, client names, or real coordinates).
- **Suggest features** - open an issue using the feature-request template.
- **Report security issues** - see [SECURITY.md](SECURITY.md). Do **not** file
  security problems as public issues.

## The four gates - all must be green

Run these from the repository root before you open a pull request. A change
that breaks any of them will not be merged until it is fixed:

```
npm run typecheck    # tsc --noEmit
npm run build        # esbuild: main / preload / worker / renderer
npm run test:core    # core unit tests
npm run qa           # Playwright drives the built Electron app, every tab
```

`npm run qa` launches a real Electron window, so it needs a display. On a
headless Linux machine run it under `xvfb-run`. If you genuinely cannot run the
QA gate in your environment, say so in the pull request and a maintainer will
run it for you - do not simply skip it in silence.

## Code conventions

- `core/` is pure TypeScript: no DOM, no Electron. It has to keep running in
  Node, in the worker, and in the browser. Add unit tests for anything you put
  there.
- The renderer is sandboxed (context isolation, no node integration). Use the
  in-app modals and toasts, not `window.prompt` / `confirm` / `alert`.
- Bound every parser (max traces, max samples, line and length caps). Never
  allocate from a count taken straight out of an input file. Malformed input
  should be collected into errors or skipped items, never thrown.
- Never let a non-finite number reach a canvas draw call.
- For any visual or behavioural change, build the app and actually look at it.
  "It compiles and the tests pass" is necessary, not sufficient.
- **Changing a control means regenerating the reference documentation.** The user
  manual has one source of truth, `renderer/src/manual.ts`. If you add, rename or
  change a control, update its topic there and re-run `npm run gen:manual` (which
  rewrites `MANUAL.md`) and `npm run manual` (which regenerates Part III of the PDF
  manual). Never hand-edit `MANUAL.md` or a Part III chapter.

## A note on data privacy

When attaching files or screenshots to an issue or a pull request, make sure
they contain no confidential survey data, client identifiers, real-world
coordinates, credentials, or personal information. Use synthetic or clearly
public sample data.
