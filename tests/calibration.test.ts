import { describe, expect, it } from "vitest";
import {
	CALIBRATION_ANCHOR,
	CalibrationError,
	type CalibrationPageLike,
	calibrateOffset,
	computeScreenPoint,
	TargetOutOfBoundsError,
} from "../src/lib/calibration.js";

// A generously large driven-window size, reused across the "the common case
// stays unchanged" tests below — big enough that every hand-picked point in
// this describe block lands well inside offset..offset+window, so these
// tests exercise the FORMULA, not the new bounds check (that gets its own
// describe block further down).
const AMPLE_WINDOW = { width: 1920, height: 1080 };

describe("computeScreenPoint (RN-040 §5a's formula, no devicePixelRatio)", () => {
	it("adds the offset to the bounding-box center", () => {
		const point = computeScreenPoint(
			{ x: 100, y: 50 },
			{ x: 200, y: 300, width: 80, height: 40 },
			AMPLE_WINDOW,
		);
		// screenX = offset.x + bbox.x + bbox.width/2; screenY analogous.
		expect(point).toEqual({ x: 100 + 200 + 40, y: 50 + 300 + 20 });
	});

	it("handles a zero offset (window flush with the desktop origin)", () => {
		const point = computeScreenPoint(
			{ x: 0, y: 0 },
			{ x: 10, y: 20, width: 100, height: 50 },
			AMPLE_WINDOW,
		);
		expect(point).toEqual({ x: 60, y: 45 });
	});

	it("handles a negative offset (a window on a second display at a negative origin)", () => {
		const point = computeScreenPoint(
			{ x: -1878, y: -1050 },
			{ x: 10, y: 10, width: 20, height: 20 },
			AMPLE_WINDOW,
		);
		expect(point).toEqual({ x: -1858, y: -1030 });
	});

	it("never multiplies by anything resembling a devicePixelRatio", () => {
		// A 2x DPR bug would double the bbox-derived component. Assert the
		// literal linear formula instead of merely eyeballing the numbers above.
		const offset = { x: 7, y: 11 };
		const box = { x: 13, y: 17, width: 40, height: 60 };
		const point = computeScreenPoint(offset, box, AMPLE_WINDOW);
		expect(point.x).toBe(offset.x + box.x + box.width / 2);
		expect(point.y).toBe(offset.y + box.y + box.height / 2);
	});
});

/**
 * [[CR-LENSMITH-A002-4]] Technical Spec item 2 / Invariant 2 — the bounds
 * assertion. Mirrors the trial's own near-miss: an off-screen target
 * computed a screen point at the literal edge of the display because
 * nothing checked it against the window it was supposed to be confined to.
 */
describe("computeScreenPoint bounds assertion (CR-LENSMITH-A002-4 Technical Spec item 2)", () => {
	it("accepts a point exactly ON the window's boundary (inclusive)", () => {
		// window is offset(0,0)..offset+window(100,100). Box center lands
		// exactly at (100, 100) — the far corner, inclusive by design (same
		// "exactly at the tolerance boundary is accepted" spirit as
		// cursorChoreographer.ts's POSITION_TOLERANCE_PX).
		const point = computeScreenPoint(
			{ x: 0, y: 0 },
			{ x: 90, y: 90, width: 20, height: 20 },
			{ width: 100, height: 100 },
		);
		expect(point).toEqual({ x: 100, y: 100 });
	});

	it("rejects a point past the window's right/bottom edge — TargetOutOfBoundsError, not a generic exception", () => {
		expect(() =>
			computeScreenPoint(
				{ x: 0, y: 0 },
				// bbox center = (101, 50) — 1px past the 100px-wide window.
				{ x: 91, y: 40, width: 20, height: 20 },
				{ width: 100, height: 100 },
			),
		).toThrow(TargetOutOfBoundsError);
	});

	it("rejects a point past the window's left/top edge (a negative-offset window, still bounded)", () => {
		expect(() =>
			computeScreenPoint(
				{ x: -500, y: -500 },
				// bbox is entirely off the top-left of a 0..width/height box.
				{ x: -20, y: -20, width: 10, height: 10 },
				{ width: 400, height: 400 },
			),
		).toThrow(TargetOutOfBoundsError);
	});

	it("rejects when the calibration offset itself is non-finite (NaN) — never reaches the arithmetic silently", () => {
		expect(() =>
			computeScreenPoint(
				{ x: Number.NaN, y: 0 },
				{ x: 10, y: 10, width: 10, height: 10 },
				AMPLE_WINDOW,
			),
		).toThrow(TargetOutOfBoundsError);
	});

	it("rejects when the calibration offset itself is non-finite (Infinity) — a deliberately-corrupted offset, per the CR's own negative-control pattern", () => {
		expect(() =>
			computeScreenPoint(
				{ x: Number.POSITIVE_INFINITY, y: 0 },
				{ x: 10, y: 10, width: 10, height: 10 },
				AMPLE_WINDOW,
			),
		).toThrow(TargetOutOfBoundsError);
	});

	it("the thrown error carries the point, offset and window for a caller to log or react to", () => {
		try {
			computeScreenPoint(
				{ x: 0, y: 0 },
				{ x: 10000, y: 10000, width: 10, height: 10 },
				{ width: 100, height: 100 },
			);
			throw new Error("expected computeScreenPoint to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(TargetOutOfBoundsError);
			const boundsError = error as TargetOutOfBoundsError;
			expect(boundsError.point).toEqual({ x: 10005, y: 10005 });
			expect(boundsError.offset).toEqual({ x: 0, y: 0 });
			expect(boundsError.window).toEqual({ width: 100, height: 100 });
			expect(boundsError.name).toBe("TargetOutOfBoundsError");
		}
	});

	it("reproduces the trial's exact near-miss shape: an off-screen target computing a screen point at the display's edge", () => {
		// The trial: a tab strip far down a long page, at page-Y 2700 on an 841px viewport
		// computed screen point Y=2851 on a 1080px display — past the bottom
		// edge of any window that size. Reproduced at reduced scale here: a
		// viewport of height 100 with a box whose center sits at y=151 (past
		// the fold) is exactly the class of target scroll-into-view (Spec
		// item 1) now prevents from ever reaching this function un-scrolled —
		// but if it ever did, the bounds check is the second line of defense.
		expect(() =>
			computeScreenPoint(
				{ x: 0, y: 0 },
				{ x: 10, y: 141, width: 10, height: 20 }, // center y = 151
				{ width: 400, height: 100 },
			),
		).toThrow(TargetOutOfBoundsError);
	});
});

/**
 * A fake `Page` that never touches a real browser or the real OS cursor —
 * it simulates the calibration handshake `calibrateOffset` performs
 * (inject a listener, "click" at the anchor, read back a screenX/screenY) in
 * plain JS, standing in for what a real Chromium tab would report. This
 * exercises `calibrateOffset`'s ORCHESTRATION (not just the pure math) fully
 * offline, the same spirit as `cursorChoreographer.test.ts`'s fake helper.
 */
function fakePage(options: {
	/** Simulated window position, in desktop screen coordinates. */
	windowOffset: { x: number; y: number };
	/** If true, the calibration click never registers (simulates a blocked/CSP'd page). */
	dropClick?: boolean;
}): CalibrationPageLike {
	let registered: { screenX: number; screenY: number } | null = null;

	return {
		async evaluate<T, Arg>(pageFunction: (arg: Arg) => T, arg: Arg): Promise<T> {
			// Two call shapes happen in calibrateOffset: the "inject" call (no
			// meaningful return) and the "read" call (returns the measurement).
			// We can't run the real browser-context function bodies here (they
			// reference `document`/`window`), so we simulate their EFFECT instead,
			// keyed on which args shape came through.
			const asInject = arg as unknown as { id?: string; x?: number; y?: number } | undefined;
			if (asInject && typeof asInject.x === "number" && typeof asInject.y === "number") {
				// "inject" call — nothing to do; the click handler is simulated in mouse.click.
				return undefined as T;
			}
			// "read" call — return the simulated measurement.
			return registered as T;
		},
		mouse: {
			async click(x: number, y: number): Promise<void> {
				if (options.dropClick) return;
				registered = {
					screenX: x + options.windowOffset.x,
					screenY: y + options.windowOffset.y,
				};
			},
		},
	};
}

describe("calibrateOffset (against a fake page — no real browser, no OS cursor)", () => {
	it("derives the window offset from the calibration click's reported screen point", async () => {
		const page = fakePage({ windowOffset: { x: 340, y: 90 } });
		const offset = await calibrateOffset(page);
		expect(offset).toEqual({ x: 340, y: 90 });
	});

	it("derives a zero offset when the window sits flush with the desktop origin", async () => {
		const page = fakePage({ windowOffset: { x: 0, y: 0 } });
		const offset = await calibrateOffset(page);
		expect(offset).toEqual({ x: 0, y: 0 });
	});

	it("is independent of the anchor point chosen (offset, not absolute position)", async () => {
		const page = fakePage({ windowOffset: { x: -220, y: 15 } });
		const offset = await calibrateOffset(page);
		// The anchor itself is internal, but the derived offset must not depend
		// on it — clicking CALIBRATION_ANCHOR should back out exactly windowOffset.
		expect(offset).toEqual({ x: -220, y: 15 });
		expect(CALIBRATION_ANCHOR.x).toBeGreaterThanOrEqual(0);
	});

	it("throws CalibrationError when the calibration click never registers", async () => {
		const page = fakePage({ windowOffset: { x: 0, y: 0 }, dropClick: true });
		await expect(calibrateOffset(page)).rejects.toThrow(CalibrationError);
	});
});
