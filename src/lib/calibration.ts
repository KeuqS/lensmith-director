/// <reference lib="dom" />
/**
 * Window-offset calibration + the coordinate-mapping formula.
 *
 * The triple-slash reference above is deliberate and scoped to this file only
 * — it does NOT add `"DOM"` to the project's global `tsconfig.json` `lib`
 * array, which would leak browser globals into every Node-side file in the
 * CLI. Only the `page.evaluate()` callback bodies below run inside the
 * browser and need `window`/`document`/`MouseEvent`; everything else in this
 * module is ordinary Node code.
 *
 * Ground truth: a probe measured 4/4 exact. Two things are stated as measured
 * facts, not re-derived here:
 *
 *   - `devicePixelRatio` is NOT applied anywhere in this path. It was 2 on
 *     the probe's Retina display; applying it would have been catastrophically
 *     wrong. `CGEventPost` space == CSS px == points, top-left origin.
 *   - The window offset is derived from ONE synthetic click's reported
 *     `MouseEvent.screenX/screenY`, not `window.outerHeight - window.innerHeight`
 *     — the subtraction is fragile (breaks with a bookmarks
 *     bar, downloads shelf, or extension banner change).
 */

export interface Point {
	x: number;
	y: number;
}

export interface BoundingBoxLike {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The driven window's content-area size, in the same CSS-px space `box` is measured in. */
export interface WindowSize {
	width: number;
	height: number;
}

export class CalibrationError extends Error {}

/**
 * A computed screen point would land outside the driven browser window's own
 * bounds — or the calibration offset it was computed from was non-finite in
 * the first place (garbage in, garbage out; a non-finite offset makes every
 * bounds comparison below false, so it is caught by the same check, not a
 * separate one).
 *
 * The same `CursorDeliveryError`-style named error class used for "the OS
 * reports the click landed somewhere other than requested" — out-of-bounds is the same family of
 * failure, "don't trust an unverified target," reported the same way: a
 * distinct, named class (not a generic exception) raised BEFORE any
 * `CGEventPost` call, carrying enough structured detail (the point, the
 * offset, the window size) for a caller to log or react to specifically.
 *
 * The case that motivated this: an off-screen target far down a long page
 * (page-Y 2700 on an 841px viewport) computed screen point Y=2851 on a
 * 1080px display — which would have posted a real click on the Dock. A manual
 * preflight caught it; nothing in the code would have.
 */
export class TargetOutOfBoundsError extends CalibrationError {
	readonly point: Point;
	readonly offset: Point;
	readonly window: WindowSize;

	constructor(point: Point, offset: Point, window: WindowSize) {
		const offsetFinite = Number.isFinite(offset.x) && Number.isFinite(offset.y);
		const bounds = `x: ${offset.x}..${offset.x + window.width}, y: ${offset.y}..${offset.y + window.height}`;
		const reason = offsetFinite
			? `falls outside the driven window's own bounds (${bounds})`
			: `is unusable because the calibration offset itself is non-finite (${offset.x}, ${offset.y})`;
		super(
			`Refusing to compute a click target: point (${point.x}, ${point.y}) ${reason}. ` +
				"Posting a real click here could land anywhere on the desktop — outside the window " +
				"this run is supposed to be confined to.",
		);
		this.name = "TargetOutOfBoundsError";
		this.point = point;
		this.offset = offset;
		this.window = window;
	}
}

/**
 * The formula: `screenX = offset.x + bbox.x + bbox.width/2`,
 * `screenY = offset.y + bbox.y + bbox.height/2`. No `devicePixelRatio`
 * multiplication anywhere, deliberately.
 *
 * `window` is the driven browser window's own content-area size — in
 * practice, `page.evaluate(() => ({width: innerWidth, height: innerHeight}))`
 * (what `drive.ts` already computes as its `viewport`; equivalent to
 * `page.viewportSize()` when `viewport: null` was used at launch, per the
 * original design wording, since `viewportSize()` itself
 * returns `null` in that mode — see `main.swift`'s header comment, which
 * exposes no separate window-geometry query; checked before writing this,
 * not assumed). The window's screen-space bounds are therefore
 * `offset` .. `offset + window` on each axis: `offset` IS the screen
 * position of the content area's own (0, 0), by construction of
 * `calibrateOffset` below. A point outside that box, or an offset that isn't
 * even a finite number, raises {@link TargetOutOfBoundsError} instead of
 * returning — this function is now structurally incapable of handing back an
 * unverified target, the same discipline `cursorChoreographer.ts`'s
 * `#verifyDelivered` applies to the ACHIEVED side of a move.
 */
export function computeScreenPoint(offset: Point, box: BoundingBoxLike, window: WindowSize): Point {
	const point: Point = {
		x: offset.x + box.x + box.width / 2,
		y: offset.y + box.y + box.height / 2,
	};

	const offsetFinite = Number.isFinite(offset.x) && Number.isFinite(offset.y);
	const withinBounds =
		offsetFinite &&
		point.x >= offset.x &&
		point.x <= offset.x + window.width &&
		point.y >= offset.y &&
		point.y <= offset.y + window.height;

	if (!withinBounds) {
		throw new TargetOutOfBoundsError(point, offset, window);
	}

	return point;
}

const CALIBRATION_ANCHOR_ID = "__lensmith_director_calibration_anchor__";
const CALIBRATION_MARKER_KEY = "__lensmithDirectorCalibration__";
/** Arbitrary in-viewport point for the calibration click. Top-left corner, unlikely to hit real UI. */
export const CALIBRATION_ANCHOR: Point = { x: 10, y: 10 };

interface CalibrationInjectArgs {
	id: string;
	marker: string;
	x: number;
	y: number;
}

interface CalibrationReadArgs {
	id: string;
	marker: string;
}

interface CalibrationMeasurement {
	screenX: number;
	screenY: number;
}

/** The minimal `Page` surface this module needs — satisfied structurally by a real Playwright `Page`. */
export interface CalibrationPageLike {
	evaluate<T, Arg>(pageFunction: (arg: Arg) => T, arg: Arg): Promise<T>;
	mouse: { click(x: number, y: number): Promise<void> };
}

/**
 * The calibration trick: inject a throwaway 1x1 element at a known
 * viewport point, fire ONE synthetic `page.mouse.click()` at it — Playwright's
 * own CDP-synthesized input, which never touches the real OS cursor
 * (Playwright's synthetic input is invisible to `CGEventGetLocation`)
 * — and read back the `MouseEvent.screenX/screenY` Chromium itself computed
 * for that click. The window offset is the difference between that and the
 * point we asked it to click.
 */
export async function calibrateOffset(page: CalibrationPageLike): Promise<Point> {
	await page.evaluate<void, CalibrationInjectArgs>(
		({ id, marker, x, y }) => {
			const el = document.createElement("div");
			el.id = id;
			Object.assign(el.style, {
				position: "fixed",
				left: `${x}px`,
				top: `${y}px`,
				width: "1px",
				height: "1px",
				opacity: "0",
				zIndex: "2147483647",
				pointerEvents: "auto",
			});
			(window as unknown as Record<string, unknown>)[marker] = null;
			el.addEventListener(
				"click",
				(event) => {
					(window as unknown as Record<string, unknown>)[marker] = {
						screenX: (event as MouseEvent).screenX,
						screenY: (event as MouseEvent).screenY,
					};
				},
				{ once: true },
			);
			document.body.appendChild(el);
		},
		{
			id: CALIBRATION_ANCHOR_ID,
			marker: CALIBRATION_MARKER_KEY,
			x: CALIBRATION_ANCHOR.x,
			y: CALIBRATION_ANCHOR.y,
		},
	);

	await page.mouse.click(CALIBRATION_ANCHOR.x, CALIBRATION_ANCHOR.y);

	const measured = await page.evaluate<CalibrationMeasurement | null, CalibrationReadArgs>(
		({ id, marker }) => {
			document.getElementById(id)?.remove();
			return (window as unknown as Record<string, unknown>)[
				marker
			] as CalibrationMeasurement | null;
		},
		{ id: CALIBRATION_ANCHOR_ID, marker: CALIBRATION_MARKER_KEY },
	);

	if (!measured) {
		throw new CalibrationError(
			"calibration click did not register — the page may be intercepting synthetic input, or CSP is blocking the injected element",
		);
	}

	return {
		x: measured.screenX - CALIBRATION_ANCHOR.x,
		y: measured.screenY - CALIBRATION_ANCHOR.y,
	};
}
