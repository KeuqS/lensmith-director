# Lensmith Director — Project Documentation Index

> **Lensmith Director** drives a running application and directs a demo recording of it: it decides
> what to show, moves the real macOS cursor to it, clicks it, and hands a recording engine the
> instructions for what to emphasise.
>
> This repository is the **director**. The **engine** that records and renders is a separate
> project, [`lensmith`](https://github.com/ynetplus/lensmith). The two share a brand and nothing
> else — no source is copied between them.

**Read [`README.md`](./README.md) before running anything.** This tool moves the real mouse cursor
and synthesises real clicks; the README states plainly what that means and what permission macOS
requires.

---

## Build and test

This product has no database, no UI, no hosted service and no
deploy target.

- **design_system:** none — CLI-only, no user-facing UI surface
- **test_cmd:** `npm test` (run `npm run build` first — the CLI
  tests exercise the built `dist/`, not the TypeScript source)
- **build_cmd:** `npm run build` (TypeScript) and `npm run build:native:mac` (the Swift helper)
- **lint_cmd:** `npm run lint` (biome)
- **migration_tool:** none — no database, no persistence; the CLI reads and writes only the local
  files the operator names on the command line
- **deploy_method:** none — no hosted service; the operator builds and runs it on their own machine
- **local_test_url:** none — the CLI has no server and no health endpoint
- **platform:** macOS only. The TypeScript builds and tests anywhere; the cursor commands need the
  native helper, and the native helper needs macOS.

Additional context:

- **Tech stack:** Node.js + TypeScript, `commander` (CLI), `vitest` (tests), `biome` (lint/format),
  and a single-file Swift helper compiled with plain `swiftc -O` (no SwiftPM — it has no
  dependencies beyond CoreGraphics and Foundation)
- **CLI entrypoint:** `src/cli.ts` → builds to `dist/cli.js` (`bin: lensmith-director`)
- **Native helper:** `src/native/cursor-choreographer/main.swift` →
  `bin/lensmith-cursor-choreographer` via `npm run build:native:mac`
- **Build artifacts:** `dist/` and `bin/` are gitignored and rebuilt from source every time
- This file and the README are the complete in-repo context.

---

## Repository rules

- **Feature branches, always.** `feature/<change-id>-<short-description>`; open a pull request.
  Nothing lands on `main` except through a green CI run on that pull request.
- **Commit specific files.** Never `git add -A`. Never commit `.env`, `node_modules/`, `dist/`,
  `bin/`, or any other build artifact or cache.
- **English only**, in every file.
- **No credentials in code**, ever — including in tests and fixtures. A `detect-secrets` baseline
  is committed and CI fails on any new finding.
- **Public-safe by default.** Assume every file in this repository may be read by anyone. Keep
  private tooling paths, internal ticket identifiers and other projects' names out of it.

## Working on the cursor code — the one rule that matters

**Never post a mouse event on a machine somebody is using, and never post one without saying so
first.** A run takes the machine over completely: events land on whatever window is under the
cursor, so a stray click can go anywhere.

In practice:

- `cursor position` is read-only and safe at any time. Everything else is not.
- Automated tests must never move the cursor. The wrapper is tested against a fake helper that
  speaks the same protocol without touching the OS (`tests/cursorChoreographer.test.ts`), and CLI
  tests only exercise argument validation, which fails before an event is posted.
- Verifying real motion or a real click is a deliberate, announced, attended act — not something a
  test run or a build step does on its own.

## Where the design decisions are written down

`src/lib/timing.ts` and the Swift helper's header comment carry the measured findings behind this
tool: why motion is posted as events rather than warped, why `devicePixelRatio` is not applied, why
the helper is long-lived, and why fast moves followed by a pause beat slow, elegant ones.

They are stated as facts with their measurements because each was expensive to learn. Read them
before changing timing, easing or the event mechanism. Do not re-derive them; if you believe one is
wrong, measure it and replace the note with the new measurement.

## Getting started in a new session

1. Read this file, then `README.md`.
2. `npm install && npm run build && npm run build:native:mac && npm test`
3. `node dist/cli.js --help` to see the current command surface.
