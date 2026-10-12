#!/usr/bin/env node
// keep-open-harness.mjs — CR-LENSMITH-A002-4 Technical Spec item 3 / Acceptance
// Metric 3.
//
// Spawned as a REAL, separate OS process by
// tests/driveKeepOpen.test.ts — it exercises the ACTUAL, PRODUCTION
// `holdOpen()` export from the built `dist/commands/drive.js` (not a
// reimplementation), wired to a real `process.once("SIGINT", ...)`, exactly
// as `registerDriveCommand`'s own CLI action wires it.
//
// What this deliberately does NOT do: launch Playwright or the real
// `CursorChoreographer`. `drive`'s own CLI action launches Chromium
// `headless: false` unconditionally and drives the real OS cursor — both are
// explicitly out of scope for this dispatch (no live cursor, no
// machine-window authorization needed for Technical Spec items 1-4). The
// keep-open MECHANISM under test here — hold the process open, keep a log
// readable, exit cleanly on SIGINT — has nothing to do with either of those;
// it is pure process/signal control flow, which is exactly why it can be
// proven this way, as a real subprocess, without a live cursor.
//
// Usage: node keep-open-harness.mjs <heartbeat-log-path>
//
// Behavior:
//   1. Writes an "alive" line to the heartbeat log every 100ms, BEFORE and
//      DURING the holdOpen() wait — this is the "log is readable N seconds
//      after the step sequence would otherwise have completed" file a
//      SEPARATE process (the test) reads while this one is still running.
//   2. Calls the real `holdOpen()`, which prints its own access-instructions
//      line to stdout and waits for SIGINT.
//   3. On SIGINT, holdOpen resolves; this script writes one final "exiting"
//      line and exits 0 — mirroring `registerDriveCommand`'s own
//      finally-block cleanup running to completion after holdOpen resolves.

import { appendFileSync } from "node:fs";
import { holdOpen } from "../../dist/commands/drive.js";

const logPath = process.argv[2];
if (!logPath) {
	console.error("usage: keep-open-harness.mjs <heartbeat-log-path>");
	process.exit(2);
}

const heartbeat = setInterval(() => {
	appendFileSync(logPath, `alive ${Date.now()}\n`);
}, 100);
appendFileSync(logPath, `alive ${Date.now()}\n`);

await holdOpen("http://localhost:4173/keep-open-harness-fake-page", {
	log: (message) => console.log(message),
	onInterrupt: (callback) => process.once("SIGINT", callback),
});

clearInterval(heartbeat);
appendFileSync(logPath, "exiting\n");
process.exit(0);
