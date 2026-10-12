# NOTICE

Lensmith Director is © 2026 YNET Plus Inc., licensed under the Apache License, Version 2.0 (see `LICENSE`).

## Third-party code

**None vendored.** Every source file in this repository is original work by YNET Plus Inc.

The native macOS helper (`src/native/cursor-choreographer/main.swift`) uses only Apple's
public CoreGraphics and Foundation frameworks — the same public automation surface used by
long-standing open-source tools such as `cliclick`, Hammerspoon and PyAutoGUI. No code is
copied from them.

## Dependencies

Installed from the npm registry and under their own licences; none is vendored into this tree.
Licences below were measured from each package's `package.json` and licence file in `node_modules`
(2026-10-11), not copied from documentation.

Direct runtime dependencies:

| Package | Version measured | Licence |
|---|---|---|
| `commander` | 12.1.0 | MIT |
| `playwright` | 1.62.1 | Apache-2.0 (its own dependency `playwright-core` 1.62.1 is also Apache-2.0) |

`playwright` drives the browser. It does not bundle a browser for this tool: `drive` and `demo`
launch the Google Chrome installed on the machine and never fall back to Playwright's Chromium.

Build-time and test-only development dependencies (not part of what the tool runs):

| Package | Version measured | Licence |
|---|---|---|
| `typescript` | 5.9.3 | Apache-2.0 |
| `vitest` | 4.1.10 | MIT |
| `@biomejs/biome` | 2.5.8 | MIT OR Apache-2.0 |
| `@types/node` | 20.19.43 | MIT |

## Sibling project

Lensmith Director is the *director* half of Lensmith. The *engine* half —
[`ynetplus/lensmith`](https://github.com/ynetplus/lensmith) — records and renders, and carries
its own `NOTICE.md` with its own third-party attribution. The two repositories share a brand and
nothing else: no source is copied between them. Where this repository re-states a fact that was
first measured in the engine's tree (for example the cursor coordinate space), the comment says
so at the point of use.
