import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// CR-LENSMITH-A002-4 Technical Spec item 3 / Acceptance Metric 3 / Invariant
// 3: "--keep-open genuinely keeps the process alive and the log readable
// past what would otherwise be drive's exit — proven by reading the log from
// a SEPARATE process while drive is still running, not by inspecting it
// after drive already exited."
//
// This file IS that separate process. It spawns
// tests/fixtures/keep-open-harness.mjs — a real Node subprocess that calls
// the ACTUAL, PRODUCTION `holdOpen()` export from `dist/commands/drive.js`
// (built by `npm run build`, which `npm test` always runs first per this
// repo's own test_cmd) — reads the heartbeat log it writes WHILE the
// subprocess is still alive (before sending SIGINT), confirms the process is
// still running at that point, then sends SIGINT and confirms a clean exit.
//
// No Playwright, no real browser, no `CursorChoreographer`, no OS cursor
// event anywhere in this file — see the harness's own header comment for why
// that's the correct, scope-respecting way to prove this specific mechanism.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.join(__dirname, "fixtures", "keep-open-harness.mjs");
const DIST_DRIVE_PATH = path.join(__dirname, "..", "dist", "commands", "drive.js");

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls until the heartbeat log has at least `minLines` "alive " entries, up
 * to `timeoutMs`. A single fixed `sleep()` before checking is flaky across
 * environments — the harness's first line only lands once `node` has
 * finished starting AND resolved `dist/commands/drive.js`'s own import chain
 * (which pulls in `playwright` at module scope), and that startup cost varies
 * a lot between a warm local machine and a cold CI runner. Polling removes
 * the dependency on guessing a fixed delay that happens to be long enough
 * everywhere.
 */
async function waitForHeartbeatLines(
	logPath: string,
	minLines: number,
	timeoutMs: number,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (existsSync(logPath)) {
			const content = readFileSync(logPath, "utf-8");
			const aliveLines = content.split("\n").filter((line) => line.startsWith("alive "));
			if (aliveLines.length >= minLines) return content;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`timed out after ${timeoutMs}ms waiting for >=${minLines} heartbeat line(s) in ${logPath}`,
			);
		}
		await sleep(50);
	}
}

describe("`drive --keep-open` process mechanism (real subprocess, no browser/cursor)", () => {
	let dir: string;
	let child: ChildProcessWithoutNullStreams | undefined;

	afterEach(() => {
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
		child = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("dist/commands/drive.js has been built (npm run build ran) — precondition for every test below", () => {
		expect(existsSync(DIST_DRIVE_PATH)).toBe(true);
	});

	it("stays alive and its heartbeat log is readable from THIS separate process while still running, then exits cleanly on SIGINT", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-keep-open-"));
		const logPath = path.join(dir, "heartbeat.log");

		child = spawn("node", [HARNESS_PATH, logPath], { stdio: ["ignore", "pipe", "pipe"] });

		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		// Wait (polling, not a fixed sleep — see waitForHeartbeatLines' own
		// comment) for the harness to: start, write at least a couple of
		// heartbeat lines, print holdOpen's access-instructions line, and
		// settle into its SIGINT wait — all BEFORE this (separate) process
		// reads anything.
		const liveContent = await waitForHeartbeatLines(logPath, 2, 15_000);

		// The process must still be running — holdOpen has not resolved because
		// no SIGINT has been sent yet. Read from THIS process while the child
		// is still alive — the literal "separate process reading it live" the
		// Invariant requires, not an after-the-fact inspection.
		expect(child.exitCode).toBeNull();
		expect(child.signalCode).toBeNull();
		expect(liveContent).not.toContain("exiting");

		// holdOpen's own access-instructions line reached this process's stdout
		// while the child was still alive — the literal thing `--keep-open`
		// exists to print (page URL + how to close it).
		expect(stdout).toContain("keep-open-harness-fake-page");
		expect(stdout).toContain("SIGINT");

		// Now interrupt it.
		child.kill("SIGINT");
		const exitCode: number | null = await new Promise((resolve) => {
			child?.once("exit", (code) => resolve(code));
		});

		expect(exitCode).toBe(0);

		// Read again, now that it has exited — proves the SIGINT path ran the
		// same cleanup the production `finally` block relies on (the harness's
		// own "exiting" line, written after holdOpen resolved).
		const finalContent = readFileSync(logPath, "utf-8");
		expect(finalContent).toContain("exiting");
	});

	it("without SIGINT, the process does not exit on its own within a short window (it genuinely holds open, not a disguised timeout)", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-keep-open-notimeout-"));
		const logPath = path.join(dir, "heartbeat.log");

		child = spawn("node", [HARNESS_PATH, logPath], { stdio: ["ignore", "ignore", "ignore"] });

		// Long enough to comfortably clear `node` + the import chain's startup
		// cost on a slow CI runner (see waitForHeartbeatLines' comment) while
		// still far short of anything holdOpen itself would ever time out on
		// (it doesn't — that's the point).
		await sleep(3_000);

		expect(child.exitCode).toBeNull();
		expect(child.signalCode).toBeNull();
	});
});
