import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleInPage } from "../src/commands/drive.js";
import {
	DEFAULT_MOVE_DURATION_MS,
	distancePx,
	EASE_IN_OUT_CUBIC_PEAK_VELOCITY_FACTOR,
	easeInOutCubic,
	MAX_RECOMMENDED_MOVE_DURATION_MS,
	MIN_PEAK_VELOCITY_PX_PER_SEC,
	moveTimingWarnings,
	pauseBeforeNextStepMs,
	peakVelocityPxPerSec,
	SETTLE_PACING,
	travelMs,
} from "../src/lib/timing.js";

const ORIGIN = { x: 0, y: 0 };

describe("easeInOutCubic", () => {
	it("is anchored at both ends and symmetric about the midpoint", () => {
		expect(easeInOutCubic(0)).toBe(0);
		expect(easeInOutCubic(1)).toBe(1);
		expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
		expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 12);
	});

	it("spends most of the move slower than a constant-speed move would", () => {
		// The whole point of the curve: it eases in and out, so at 25% of the
		// time it has covered far less than 25% of the distance.
		expect(easeInOutCubic(0.25)).toBeLessThan(0.25);
		expect(easeInOutCubic(0.75)).toBeGreaterThan(0.75);
	});

	it("peaks at 3x the average speed (the factor the velocity check relies on)", () => {
		// Numerically differentiate the curve and confirm the analytic peak.
		const h = 1e-6;
		let peak = 0;
		for (let t = h; t < 1 - h; t += 0.001) {
			peak = Math.max(peak, (easeInOutCubic(t + h) - easeInOutCubic(t - h)) / (2 * h));
		}
		expect(peak).toBeCloseTo(EASE_IN_OUT_CUBIC_PEAK_VELOCITY_FACTOR, 3);
	});
});

describe("peakVelocityPxPerSec", () => {
	it("is 3x distance over duration", () => {
		expect(peakVelocityPxPerSec(500, 500)).toBeCloseTo(3000, 6);
		expect(peakVelocityPxPerSec(200, 900)).toBeCloseTo(666.67, 1);
	});

	it("computes distance as a straight line between two points", () => {
		expect(distancePx({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
	});
});

describe("moveTimingWarnings — the measured recipe", () => {
	it("the recommended move (500px in 500ms) is clean", () => {
		expect(moveTimingWarnings(ORIGIN, { x: 500, y: 0 }, 500)).toEqual([]);
		expect(peakVelocityPxPerSec(500, DEFAULT_MOVE_DURATION_MS)).toBeGreaterThan(
			MIN_PEAK_VELOCITY_PX_PER_SEC,
		);
	});

	it("500px over 2500ms — the natural, attractive move — is flagged on both counts", () => {
		const warnings = moveTimingWarnings(ORIGIN, { x: 500, y: 0 }, 2500);
		expect(warnings).toHaveLength(2);
		expect(warnings.join(" ")).toContain("phantom region");
		expect(warnings.join(" ")).toContain("below");
	});

	it("200px over 900ms — a typical UI hop — is flagged as too slow to register", () => {
		const warnings = moveTimingWarnings(ORIGIN, { x: 200, y: 0 }, 900);
		expect(warnings.join(" ")).toContain(`below ${MIN_PEAK_VELOCITY_PX_PER_SEC}px/s`);
	});

	it("warns about fusing once past the recommended ceiling, before the phantom threshold", () => {
		const warnings = moveTimingWarnings(ORIGIN, { x: 2000, y: 0 }, 800);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(`exceeds the recommended ${MAX_RECOMMENDED_MOVE_DURATION_MS}ms`);
	});

	it("says nothing about a zero-distance move", () => {
		expect(moveTimingWarnings(ORIGIN, ORIGIN, 5000)).toEqual([]);
	});

	it("treats negative-origin targets as ordinary coordinates", () => {
		// A second display can legitimately sit at a negative origin; the
		// distance is what matters, never the sign.
		expect(moveTimingWarnings({ x: 0, y: 0 }, { x: -1878, y: -1050 }, 500)).toEqual([]);
	});
});

describe("SETTLE_PACING — the Settle spec table (CR-LENSMITH-A007-2)", () => {
	it("holds exactly the spec numbers", () => {
		expect(SETTLE_PACING).toEqual({
			travelBaseMs: 300,
			travelPerPt: 0.4,
			travelMinMs: 400,
			travelMaxMs: 700,
			dwellMs: 700,
			settleQuietMs: 300,
			settleCapMs: 4000,
			resultHoldMs: 1200,
			breathMs: 800,
			typeCharDelayMs: 60,
			zoomScale: 1.8,
			zoomInMs: 900,
			zoomOutMs: 700,
			zoomMinGapAfterOutMs: 800,
			zoomConnectMarginRatio: 0.08,
		});
	});
});

describe("travelMs — clamp(300 + 0.4 x d, 400, 700)", () => {
	it("is 400 at d=100 (floor: 340 clamps up) and at 250 pt or less", () => {
		expect(travelMs(100)).toBe(400);
		expect(travelMs(250)).toBe(400);
		expect(travelMs(0)).toBe(400);
	});

	it("is 540 at d=600", () => {
		expect(travelMs(600)).toBe(540);
	});

	it("is 700 at d=1500 (ceiling) and at 1000 pt", () => {
		expect(travelMs(1500)).toBe(700);
		expect(travelMs(1000)).toBe(700);
	});

	it("never exceeds the director's own recommended maximum", () => {
		expect(SETTLE_PACING.travelMaxMs).toBe(MAX_RECOMMENDED_MOVE_DURATION_MS);
	});
});

describe("settleInPage — the in-page settle wait", () => {
	// A tiny stand-in for the three DOM globals the function touches. No browser.
	let mutate: () => void;
	let disconnected: boolean;
	let visibleSelectors: Set<string>;

	beforeEach(() => {
		vi.useFakeTimers();
		disconnected = false;
		visibleSelectors = new Set();
		class FakeObserver {
			constructor(cb: () => void) {
				mutate = cb;
			}
			observe() {
				// no-op: the test drives mutations by calling `mutate()`
			}
			disconnect() {
				disconnected = true;
			}
		}
		vi.stubGlobal("MutationObserver", FakeObserver);
		vi.stubGlobal("document", {
			querySelector: (sel: string) =>
				visibleSelectors.has(sel) ? { getClientRects: () => [1] } : null,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("returns at the expect selector as soon as it is visible", async () => {
		let done = false;
		const p = settleInPage({ expectSelector: "#result", quietMs: 300, capMs: 4000 }).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(done).toBe(false); // keeps waiting while the selector is absent
		visibleSelectors.add("#result");
		mutate();
		await p;
		expect(done).toBe(true);
		expect(disconnected).toBe(true);
	});

	it("without a selector, returns after 300 ms with no DOM mutation", async () => {
		let done = false;
		const p = settleInPage({ quietMs: 300, capMs: 4000 }).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(299);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await p;
		expect(done).toBe(true);
	});

	it("restarts the quiet window on every mutation", async () => {
		let done = false;
		const p = settleInPage({ quietMs: 300, capMs: 4000 }).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(200);
		mutate();
		await vi.advanceTimersByTimeAsync(200);
		expect(done).toBe(false); // 400 ms in, but only 200 ms since the last mutation
		await vi.advanceTimersByTimeAsync(100);
		await p;
		expect(done).toBe(true);
	});

	it("is capped at 4000 ms however busy the page stays", async () => {
		let done = false;
		const p = settleInPage({ quietMs: 300, capMs: 4000 }).then(() => {
			done = true;
		});
		for (let t = 0; t < 3900; t += 100) {
			await vi.advanceTimersByTimeAsync(100);
			mutate();
		}
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(100);
		await p;
		expect(done).toBe(true);
	});

	it("returns at once when the expect selector is already visible", async () => {
		visibleSelectors.add("#result");
		await settleInPage({ expectSelector: "#result", quietMs: 300, capMs: 4000 });
		expect(disconnected).toBe(false); // never even started observing
	});
});

describe("pauseBeforeNextStepMs (BF-11)", () => {
	it("is zoom-out + breath = 1500 when not connected, breath = 800 when connected", () => {
		expect(pauseBeforeNextStepMs(false)).toBe(1500);
		expect(pauseBeforeNextStepMs(true)).toBe(800);
	});
});
