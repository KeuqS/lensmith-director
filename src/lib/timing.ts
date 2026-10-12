/**
 * The timing recipe.
 *
 * These numbers are not taste. They were measured against a real automatic
 * zoom-region detector fed by real cursor telemetry, and the result was
 * counter-intuitive enough to be worth stating plainly:
 *
 *   **The prettier the cursor motion, the worse the downstream result.**
 *
 * What was measured:
 *
 *   | move                              | outcome                                              |
 *   |-----------------------------------|------------------------------------------------------|
 *   | 500 px over 2500 ms (natural)     | ZERO zoom candidates — move and pause fuse into one   |
 *   |                                   | run that exceeds the detector's maximum and is dropped |
 *   | 200 px over 900 ms (a UI hop)     | one candidate, focused on the CENTROID between origin  |
 *   |                                   | and target — i.e. the empty space between two buttons  |
 *   | any move >= 1200 ms               | additionally spawns a PHANTOM region at the origin     |
 *   | 500 px / 500 ms + 700-1200 ms dwell | correct: focus lands on the target                   |
 *
 * A dwell run is only broken by motion whose peak speed clears roughly
 * {@link MIN_PEAK_VELOCITY_PX_PER_SEC}. Below that, a move is indistinguishable
 * from standing still, which is why a slow, elegant glide produces nothing at all.
 *
 * So: move fast, then hold still. Both halves matter.
 */

/** Default eased-move duration. Inside the recipe, with headroom. */
export const DEFAULT_MOVE_DURATION_MS = 500;

/** Beyond this, a move starts fusing with the pause around it. */
export const MAX_RECOMMENDED_MOVE_DURATION_MS = 700;

/** Beyond this, a move additionally spawns a phantom region at its origin. */
export const PHANTOM_REGION_MOVE_DURATION_MS = 1200;

/** Peak speed a move must clear to register as motion at all. */
export const MIN_PEAK_VELOCITY_PX_PER_SEC = 891;

/** Hold still this long after arriving, before clicking. */
export const MIN_DWELL_MS = 700;
export const MAX_DWELL_MS = 1200;
export const DEFAULT_DWELL_MS = 900;

/**
 * Peak speed of an `easeInOutCubic` move, as a multiple of its average speed.
 *
 * For `easeInOut` of power n the normalised velocity peaks at exactly n (at the
 * midpoint): d/dt[4t^3] = 12t^2, which is 3 at t = 0.5. Cubic easing therefore
 * spends most of its budget slower than the average, and its peak is only 3x the
 * average — which is precisely why a move that "looks fast enough" can still sit
 * under the detection threshold.
 */
export const EASE_IN_OUT_CUBIC_PEAK_VELOCITY_FACTOR = 3;

/** The easing curve the native helper uses. Kept here for calculation and tests. */
export function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function distancePx(from: { x: number; y: number }, to: { x: number; y: number }): number {
	return Math.hypot(to.x - from.x, to.y - from.y);
}

/** Peak speed, in px/s, of an eased move covering `distance` px in `durationMs`. */
export function peakVelocityPxPerSec(distance: number, durationMs: number): number {
	if (durationMs <= 0) return Number.POSITIVE_INFINITY;
	return (EASE_IN_OUT_CUBIC_PEAK_VELOCITY_FACTOR * distance) / (durationMs / 1000);
}

/**
 * Advisory only — never throws, never rejects a move. A caller may have a good
 * reason to move slowly (framing a shot, exiting a scene); what it must not do
 * is move slowly by accident and then wonder why nothing was detected.
 */
export function moveTimingWarnings(
	from: { x: number; y: number },
	to: { x: number; y: number },
	durationMs: number,
): string[] {
	const warnings: string[] = [];
	const distance = distancePx(from, to);
	if (distance === 0) return warnings;

	if (durationMs > PHANTOM_REGION_MOVE_DURATION_MS) {
		warnings.push(
			`move duration ${durationMs}ms exceeds ${PHANTOM_REGION_MOVE_DURATION_MS}ms — long moves also spawn a phantom region at the origin`,
		);
	} else if (durationMs > MAX_RECOMMENDED_MOVE_DURATION_MS) {
		warnings.push(
			`move duration ${durationMs}ms exceeds the recommended ${MAX_RECOMMENDED_MOVE_DURATION_MS}ms — the move starts fusing with the pause around it`,
		);
	}

	const peak = peakVelocityPxPerSec(distance, durationMs);
	if (peak < MIN_PEAK_VELOCITY_PX_PER_SEC) {
		warnings.push(
			`peak velocity ${Math.round(peak)}px/s is below ${MIN_PEAK_VELOCITY_PX_PER_SEC}px/s — this move may not register as motion at all (try a shorter duration)`,
		);
	}

	return warnings;
}

/** Hold still. The other half of the recipe; a move without it lands nothing. */
export function dwell(ms: number = DEFAULT_DWELL_MS): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The "Settle" pacing (Pacing card, treatment C; CR-LENSMITH-A007-2). Every
 * number is from the Settle spec table; none is invented. Provisional until
 * Drew approves them on a real film (CR-LENSMITH-A007-7), then locked here.
 *
 * Step rhythm: travel (by distance) + dwell, click, wait for the result to
 * settle, hold the result, breathe at 1x, next step.
 */
export const SETTLE_PACING = {
	/** travel_ms = clamp(base + perPt x d, min, max), d in screen points. */
	travelBaseMs: 300,
	travelPerPt: 0.4,
	travelMinMs: 400,
	travelMaxMs: 700,
	/** Hold still on the target before the click. */
	dwellMs: 700,
	/** Settle: no DOM mutation for this long (when the step has no `expect` selector)... */
	settleQuietMs: 300,
	/** ...but never wait longer than this. */
	settleCapMs: 4000,
	/** Held at full zoom after the result settled, cursor still. */
	resultHoldMs: 1200,
	/** At 1x after the hold, before the next step's travel starts. */
	breathMs: 800,
	/** Type steps: per character, unchanged. */
	typeCharDelayMs: 60,
	/** Zoom regions (CR-LENSMITH-A007-10). Scale is the renderer's, unchanged. */
	zoomScale: 1.8,
	/** The renderer's zoom-in window, begins at travel start. */
	zoomInMs: 900,
	/** The renderer's zoom-out, begins at the region's `endMs`. */
	zoomOutMs: 700,
	/** A zoom-in never starts within this long of a (non-connected) zoom-out's end. */
	zoomMinGapAfterOutMs: 800,
	/** Next target must sit inside the zoomed frame with this margin on every side to connect. */
	zoomConnectMarginRatio: 0.08,
} as const;

/** Cursor travel time for a move of `distancePt` screen points: clamp(300 + 0.4 x d, 400, 700). */
export function travelMs(distancePt: number): number {
	const { travelBaseMs, travelPerPt, travelMinMs, travelMaxMs } = SETTLE_PACING;
	return Math.min(travelMaxMs, Math.max(travelMinMs, travelBaseMs + travelPerPt * distancePt));
}

/**
 * Sleep after a step's result hold, before the next step starts (BF-11). The zoom-out
 * lasts `zoomOutMs` from the region end, and the film then breathes `breathMs` at 1x, so
 * the breath counts from the END of the zoom-out. A connected step pans instead of
 * zooming out, so only the breath remains.
 */
export function pauseBeforeNextStepMs(connected: boolean): number {
	return connected ? SETTLE_PACING.breathMs : SETTLE_PACING.zoomOutMs + SETTLE_PACING.breathMs;
}
