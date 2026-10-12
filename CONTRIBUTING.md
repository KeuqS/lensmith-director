# Contributing to Lensmith Director

Thanks for helping. This tool moves a real mouse cursor, so a few rules matter more here than in
most projects.

## The rule that matters most: tests never move the real cursor

**No test, build step or CI job may post a real mouse or keyboard event, open a visible browser
window that takes over the machine, or touch the keychain.** A run takes the machine over: events
land on whatever window is under the cursor.

- Test the cursor wrapper against a fake helper that speaks the same protocol (see
  `tests/cursorChoreographer.test.ts`).
- CLI tests (`tests/cli.test.ts`) may only exercise argument validation that fails before an event
  is posted. Never call `cursor move` or `cursor click` with valid arguments in a test.
- Inject fakes for the page, the choreographer and `/usr/bin/security` (see `tests/drive.test.ts`
  and `tests/keychainText.test.ts`). The one real-browser test runs headless and uses a fake
  choreographer.
- Verifying real motion or a real click is a deliberate, announced, attended act on a machine
  nobody else is using. Say so in your pull request if you did it.

## Prerequisites

- macOS with Apple's Command Line Tools (`xcode-select --install`) for the Swift helpers. The
  TypeScript builds and tests on other platforms.
- Node.js 18 or newer (`engines` in `package.json`; CI uses Node 20).
- Google Chrome, only if you run `drive` or `demo` by hand.

## Build, test, lint

```bash
npm ci
npm run build              # tsc -> dist/
npm run build:native:mac   # swiftc -> bin/ (macOS only)
npm test                   # vitest; run `npm run build` first, tests exercise dist/
npm run lint               # biome
npm run format             # biome, applies fixes
npx playwright install chromium   # needed once for the headless real-browser test
```

`dist/` and `bin/` are build artifacts and are not committed.

## Pull requests

- Branch from `main`, use a descriptive branch name, and open a pull request. CI must be green.
- Commit specific files; do not commit `node_modules/`, `dist/`, `bin/` or credentials. A
  `detect-secrets` baseline is checked in and CI fails on any new finding.
- Keep changes small and focused. Add or update tests with the change.
- If you change what the tool can do with input or secrets, update `SECURITY.md` in the same pull
  request.
- Company contributors commit with their `@ynetplus.ca` address.

## Vendored code

Nothing is vendored today. If you copy third-party source into this repository, keep it verbatim,
record its origin, commit and licence in `NOTICE.md` in the same pull request, and make sure the
licence is compatible with Apache-2.0.

## Licence of contributions

This project is licensed under the Apache License 2.0. By submitting a contribution you agree it is
licensed under the same terms (inbound = outbound), as described in section 5 of the licence.

## Security issues

Do not open a public issue. See [SECURITY.md](./SECURITY.md).
