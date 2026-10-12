import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AccessibilityTrustError,
	CursorChoreographer,
	CursorChoreographerError,
	CursorDeliveryError,
	POSITION_TOLERANCE_PX,
} from "../src/lib/cursorChoreographer.js";

// These tests drive the wrapper against a FAKE helper that speaks the same
// NDJSON protocol as the Swift binary. That is deliberate on two counts:
//   1. they run on any platform, in CI, with no Accessibility permission; and
//   2. they post ZERO real input events — this machine is not taken over by a
//      test run. The real binary's behaviour is verified separately, on a
//      machine window, and recorded in the CR report.

const FAKE_HELPER = `#!/usr/bin/env node
"use strict";
// A stand-in for lensmith-cursor-choreographer: same protocol, no OS events.
let x = 100;
let y = 200;
let warm = false;
let buffer = "";

process.stdout.write(JSON.stringify({ type: "ready", warm }) + "\\n");

function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let message;
    try { message = JSON.parse(line); } catch (_) {
      send({ type: "error", cmd: "?", message: "malformed" });
      continue;
    }
    switch (message.cmd) {
      case "position":
        send({ type: "ok", cmd: "position", x, y });
        break;
      case "warm":
        warm = true;
        send({ type: "ok", cmd: "warm", warm: true });
        break;
      case "move": {
        if (message.x === 999999) {
          send({ type: "error", cmd: "move", message: "simulated helper failure" });
          break;
        }
        const fromX = x;
        const fromY = y;
        x = message.x;
        y = message.y;
        send({
          type: "ok",
          cmd: "move",
          steps: Math.max(2, Math.round((message.durationMs / 1000) * 120)),
          elapsedMs: message.durationMs,
          fromX,
          fromY,
          x,
          y,
        });
        break;
      }
      case "click":
        send({ type: "ok", cmd: "click", x, y });
        break;
      case "quit":
        send({ type: "ok", cmd: "quit" });
        process.exit(0);
        break;
      default:
        send({ type: "error", cmd: message.cmd, message: "unknown command" });
    }
  }
});
`;

const DEAD_HELPER = `#!/usr/bin/env node
"use strict";
// Dies before saying "ready" — the shape of a binary that cannot run at all.
process.stderr.write("cannot start\\n");
process.exit(3);
`;

/**
 * A fake helper whose "move" reply ALWAYS reports landing `driftPx` away
 * (in x) from wherever it was actually asked to go — [[BF-2]]'s exact shape:
 * a "success" reply describing a move that never actually reached the
 * requested target. Used to positive-control `moveTo()`'s divergence check
 * ([[CR-LENSMITH-A002-3]] Technical Spec item 1 / Acceptance Metric 1) and,
 * with `driftPx: 0`, to prove the happy path is unaffected.
 */
function moveDriftHelperSource(driftPx: number): string {
	return `#!/usr/bin/env node
"use strict";
let x = 100;
let y = 200;
let buffer = "";
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    const message = JSON.parse(line);
    switch (message.cmd) {
      case "position": send({ type: "ok", cmd: "position", x, y }); break;
      case "warm": send({ type: "ok", cmd: "warm", warm: true }); break;
      case "move": {
        const fromX = x, fromY = y;
        x = message.x + (${driftPx});
        y = message.y;
        send({ type: "ok", cmd: "move", steps: 60, elapsedMs: message.durationMs, fromX, fromY, x, y });
        break;
      }
      case "click": send({ type: "ok", cmd: "click", x, y }); break;
      default: send({ type: "error", cmd: message.cmd, message: "unknown command" });
    }
  }
});
`;
}

/**
 * A fake helper whose "move" reply matches the requested target exactly, but
 * whose "click" reply always drifts `driftPx` away (in x) from wherever the
 * cursor actually is — simulating [[BF-2]]'s "narrower but real form": a
 * stray system event moving the cursor between the dwell and the click, a
 * failure mode invisible even with Accessibility granted. Used to
 * positive-control `click()`'s own divergence check.
 */
function clickDriftHelperSource(driftPx: number): string {
	return `#!/usr/bin/env node
"use strict";
let x = 100;
let y = 200;
let buffer = "";
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    const message = JSON.parse(line);
    switch (message.cmd) {
      case "position": send({ type: "ok", cmd: "position", x, y }); break;
      case "warm": send({ type: "ok", cmd: "warm", warm: true }); break;
      case "move": {
        const fromX = x, fromY = y;
        x = message.x; y = message.y;
        send({ type: "ok", cmd: "move", steps: 60, elapsedMs: message.durationMs, fromX, fromY, x, y });
        break;
      }
      case "click": send({ type: "ok", cmd: "click", x: x + (${driftPx}), y }); break;
      default: send({ type: "error", cmd: message.cmd, message: "unknown command" });
    }
  }
});
`;
}

describe("CursorChoreographer (against a fake helper — no real events)", () => {
	let dir: string;
	let helperPath: string;
	let choreographer: CursorChoreographer | undefined;

	function writeHelper(name: string, source: string): string {
		const target = path.join(dir, name);
		writeFileSync(target, source);
		chmodSync(target, 0o755);
		return target;
	}

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-choreo-"));
		helperPath = writeHelper("fake-helper", FAKE_HELPER);
	});

	afterEach(() => {
		choreographer?.stop();
		choreographer = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	async function startFake(): Promise<CursorChoreographer> {
		const instance = new CursorChoreographer({ helperPath });
		await instance.start();
		choreographer = instance;
		return instance;
	}

	it("starts, reports running, and reads a position", async () => {
		const instance = await startFake();
		expect(instance.isRunning).toBe(true);
		await expect(instance.position()).resolves.toEqual({ x: 100, y: 200 });
	});

	it("moves and reports where it started, where it landed, and how many events it posted", async () => {
		const instance = await startFake();
		const result = await instance.moveTo(600, 200, 500);
		expect(result.from).toEqual({ x: 100, y: 200 });
		expect(result.to).toEqual({ x: 600, y: 200 });
		expect(result.steps).toBe(60);
		expect(result.warnings).toEqual([]);
		await expect(instance.position()).resolves.toEqual({ x: 600, y: 200 });
	});

	it("moves to negative coordinates without clamping (a second display can sit at a negative origin)", async () => {
		const instance = await startFake();
		const result = await instance.moveTo(-1878, -1050, 500);
		expect(result.to).toEqual({ x: -1878, y: -1050 });
	});

	it("attaches timing warnings to a move that is too slow to register", async () => {
		const instance = await startFake();
		const result = await instance.moveTo(300, 200, 2500);
		expect(result.warnings.join(" ")).toContain("below");
	});

	it("rejects a non-positive duration before posting anything", async () => {
		const instance = await startFake();
		await expect(instance.moveTo(600, 200, 0)).rejects.toThrow(CursorChoreographerError);
		await expect(instance.moveTo(600, 200, -1)).rejects.toThrow(/positive/);
		// The cursor never moved, because the command was never sent.
		await expect(instance.position()).resolves.toEqual({ x: 100, y: 200 });
	});

	it("clicks at the current position", async () => {
		const instance = await startFake();
		await instance.moveTo(400, 400, 500);
		await expect(instance.click()).resolves.toEqual({ x: 400, y: 400 });
	});

	it("surfaces a helper-side error as a rejected promise, and stays usable", async () => {
		const instance = await startFake();
		await expect(instance.moveTo(999999, 0, 500)).rejects.toThrow("simulated helper failure");
		await expect(instance.position()).resolves.toEqual({ x: 100, y: 200 });
	});

	it("fails start() immediately when the helper dies before reporting ready", async () => {
		const deadPath = writeHelper("dead-helper", DEAD_HELPER);
		const instance = new CursorChoreographer({ helperPath: deadPath });
		const began = Date.now();
		await expect(instance.start()).rejects.toThrow(CursorChoreographerError);
		// Not the 10s ready timeout — the exit is observed and reported at once.
		expect(Date.now() - began).toBeLessThan(5000);
	});

	it(
		"kills the already-spawned process before throwing when its stdout/stdin pipes are " +
			"unexpectedly missing — CR-LENSMITH-A002-9 round 2 audit finding: a real OS process must " +
			"never be dropped (reference cleared) without being killed, even on this defensive branch " +
			"that stdio: ['pipe','pipe','pipe'] should make unreachable in production",
		async () => {
			const killCalls: unknown[][] = [];
			const fakeChild = Object.assign(new EventEmitter(), {
				stdout: null,
				stdin: null,
				stderr: null,
				kill: (...args: unknown[]) => {
					killCalls.push(args);
					return true;
				},
			}) as unknown as ChildProcess;
			const spawnFn = (() => fakeChild) as unknown as typeof spawn;

			const instance = new CursorChoreographer({ helperPath: "/unused", spawnFn });

			await expect(instance.start()).rejects.toThrow(/Failed to open a pipe/);
			expect(killCalls).toHaveLength(1);
			expect(instance.isRunning).toBe(false);
		},
	);

	it("refuses commands once stopped", async () => {
		const instance = await startFake();
		instance.stop();
		expect(instance.isRunning).toBe(false);
		await expect(instance.position()).rejects.toThrow(CursorChoreographerError);
	});

	it("dwells for at least the requested time", async () => {
		const instance = await startFake();
		const began = Date.now();
		await instance.dwell(120);
		expect(Date.now() - began).toBeGreaterThanOrEqual(110);
	});
});

// [[BF-2]] / [[CR-LENSMITH-A002-3]]: the Swift helper's own comment on the
// achieved-position readback says it exists "so the caller can assert the
// motion actually happened" — until this CR, nothing did. These tests prove
// `moveTo()`/`click()` now compare the helper's reported achieved position
// against what was requested/expected and reject on divergence, using fake
// helpers authored to report exactly that divergence (never a real OS event).
describe("CursorChoreographer — achieved-vs-requested delivery verification (BF-2)", () => {
	let dir: string;
	let choreographer: CursorChoreographer | undefined;

	function writeHelper(name: string, source: string): string {
		const target = path.join(dir, name);
		writeFileSync(target, source);
		chmodSync(target, 0o755);
		return target;
	}

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-choreo-delivery-"));
	});

	afterEach(() => {
		choreographer?.stop();
		choreographer = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	async function startWithHelper(source: string): Promise<CursorChoreographer> {
		const helperPath = writeHelper("fake-helper", source);
		const instance = new CursorChoreographer({ helperPath });
		await instance.start();
		choreographer = instance;
		return instance;
	}

	it("moveTo() throws CursorDeliveryError when the achieved position diverges past tolerance (positive control)", async () => {
		const instance = await startWithHelper(moveDriftHelperSource(5));
		const error = await instance.moveTo(600, 200, 500).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CursorDeliveryError);
		const delivery = error as CursorDeliveryError;
		expect(delivery.requested).toEqual({ x: 600, y: 200 });
		expect(delivery.achieved).toEqual({ x: 605, y: 200 });
		expect(delivery.message).toContain("600");
		expect(delivery.message).toContain("605");
	});

	it("moveTo() does not throw when the achieved position matches exactly (negative control — today's behavior, unchanged)", async () => {
		const instance = await startWithHelper(moveDriftHelperSource(0));
		const result = await instance.moveTo(600, 200, 500);
		expect(result.to).toEqual({ x: 600, y: 200 });
	});

	it(`moveTo() accepts a divergence of exactly ${POSITION_TOLERANCE_PX}px — the tolerance boundary is INCLUSIVE`, async () => {
		const instance = await startWithHelper(moveDriftHelperSource(POSITION_TOLERANCE_PX));
		const result = await instance.moveTo(600, 200, 500);
		expect(result.to).toEqual({ x: 600 + POSITION_TOLERANCE_PX, y: 200 });
	});

	it(`moveTo() rejects a divergence of ${POSITION_TOLERANCE_PX}px plus a hair — strictly past the boundary throws`, async () => {
		const instance = await startWithHelper(moveDriftHelperSource(POSITION_TOLERANCE_PX + 0.01));
		await expect(instance.moveTo(600, 200, 500)).rejects.toThrow(CursorDeliveryError);
	});

	it("a divergent moveTo() never establishes a baseline for a subsequent click() to be checked against", async () => {
		// The underlying (simulated) OS move genuinely happened — just not to
		// the requested target — so the fake's internal position DOES change
		// to the divergent point. What must NOT happen is `#expectedPosition`
		// getting set to that unverified point: if it had been (i.e. if the
		// throw happened AFTER the assignment instead of before), a later
		// click() would be silently checked against a position that was
		// itself never verified as reached.
		const instance = await startWithHelper(moveDriftHelperSource(5));
		await expect(instance.moveTo(600, 200, 500)).rejects.toThrow(CursorDeliveryError);
		// No prior successful moveTo() ever established a baseline, so this
		// click() has nothing to diverge from and must not throw for THAT
		// reason — it simply reports wherever the (simulated) cursor actually
		// is, which is the drifted point the failed move actually reached.
		await expect(instance.click()).resolves.toEqual({ x: 605, y: 200 });
	});

	it("click() throws CursorDeliveryError when its achieved position diverges from the last moveTo() (positive control — the stray-event failure mode)", async () => {
		const instance = await startWithHelper(clickDriftHelperSource(5));
		await instance.moveTo(600, 200, 500);
		const error = await instance.click().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CursorDeliveryError);
		const delivery = error as CursorDeliveryError;
		expect(delivery.requested).toEqual({ x: 600, y: 200 });
		expect(delivery.achieved).toEqual({ x: 605, y: 200 });
	});

	it("click() does not throw when its achieved position matches the last moveTo() (negative control)", async () => {
		const instance = await startWithHelper(clickDriftHelperSource(0));
		await instance.moveTo(600, 200, 500);
		await expect(instance.click()).resolves.toEqual({ x: 600, y: 200 });
	});

	it("click() with no preceding moveTo() this session has nothing to diverge from, and does not throw (matches today's standalone `cursor click`)", async () => {
		const instance = await startWithHelper(clickDriftHelperSource(5));
		// FAKE_HELPER-style helpers start at (100, 200); clickDriftHelperSource
		// reports (105, 200) for a click with no prior move — accepted, because
		// there is no established baseline yet in this session.
		await expect(instance.click()).resolves.toEqual({ x: 105, y: 200 });
	});
});

// [[CR-LENSMITH-A002-3]] Technical Spec item 4: RN-040 §5c already established
// that revoking a live Accessibility grant mid-session to test the REAL
// `AXIsProcessTrusted()` call is not safely doable. These tests do NOT and
// cannot exercise that real macOS API call — they prove the LOGIC PATH using
// `CursorChoreographer`'s injectable `isTrusted` seam: untrusted -> a loud,
// specific, named error -> no command reaches the helper process at all. The
// real Swift-side check (`main.swift`'s `ensureAccessibilityTrusted`) stays
// verified only by measurement on a real machine (see BF-2's own report).
describe("CursorChoreographer — Accessibility-trust seam (logic path only, not the real API call)", () => {
	let dir: string;
	let helperPath: string;
	let choreographer: CursorChoreographer | undefined;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-choreo-trust-"));
		const target = path.join(dir, "fake-helper");
		writeFileSync(target, FAKE_HELPER);
		chmodSync(target, 0o755);
		helperPath = target;
	});

	afterEach(() => {
		choreographer?.stop();
		choreographer = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	async function startUntrusted(): Promise<CursorChoreographer> {
		const instance = new CursorChoreographer({ helperPath, isTrusted: () => false });
		await instance.start();
		choreographer = instance;
		return instance;
	}

	it("moveTo() throws AccessibilityTrustError naming System Settings, and never reaches the helper", async () => {
		const instance = await startUntrusted();
		const error = await instance.moveTo(600, 200, 500).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AccessibilityTrustError);
		expect((error as Error).message).toContain("System Settings");
		expect((error as Error).message).toContain("Accessibility");
		// The fake helper's internal position never changed — proof the "move"
		// command was never sent, not just that the promise rejected.
		await expect(instance.position()).resolves.toEqual({ x: 100, y: 200 });
	});

	it("click() throws AccessibilityTrustError and never reaches the helper", async () => {
		const instance = await startUntrusted();
		await expect(instance.click()).rejects.toThrow(AccessibilityTrustError);
		await expect(instance.position()).resolves.toEqual({ x: 100, y: 200 });
	});

	it("warm() throws AccessibilityTrustError and never reaches the helper", async () => {
		const instance = await startUntrusted();
		await expect(instance.warm()).rejects.toThrow(AccessibilityTrustError);
		await expect(instance.position()).resolves.toEqual({ x: 100, y: 200 });
	});

	it("position() is unaffected — read-only, safe regardless of trust status", async () => {
		const instance = await startUntrusted();
		await expect(instance.position()).resolves.toEqual({ x: 100, y: 200 });
	});

	it("a trusted seam (isTrusted: () => true) behaves exactly like no seam at all", async () => {
		const instance = new CursorChoreographer({ helperPath, isTrusted: () => true });
		await instance.start();
		choreographer = instance;
		const result = await instance.moveTo(600, 200, 500);
		expect(result.to).toEqual({ x: 600, y: 200 });
	});
});
