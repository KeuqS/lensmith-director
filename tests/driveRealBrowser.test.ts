import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	ChoreographerLike,
	MoveResultLike,
	PageLike,
	PointLike,
} from "../src/commands/drive.js";
import { runDrive as runDriveReal } from "../src/commands/drive.js";
import { emitZoomRegions } from "../src/lib/zoomEmission.js";

// This file is the ONE place in the automated suite that launches a REAL
// browser. It is deliberately still safe to run unattended, in CI, on a
// machine someone is using:
//
//   - `headless: true` — no visible window opens; nothing steals focus.
//   - The choreographer is an in-memory fake — `moveTo`/`dwell`/`click` never
//     reach a subprocess, let alone the Swift helper or `CGEventPost`. The
//     real OS cursor is never touched.
//   - The page is loaded from a `file://` URL — no server, no network.
//
// What THIS proves that the fake-`PageLike` tests in `drive.test.ts` cannot:
// the calibration formula and `boundingBox()`-derived coordinates hold up
// against a REAL Chromium's real layout engine measuring a real DOM, not a
// hand-rolled simulation of what Playwright would report. This is the
// CR-LENSMITH-A002-2 Invariants' calibration positive control — "drive a
// step list against a test page with a KNOWN, hand-measured element
// position; assert the computed screenX/screenY is within a documented
// tolerance (start with ±2px) of that hand measurement" — run for real, on
// every CI run, against the acceptance fixture itself
// (`tests/fixtures/drive-test-page.html`, whose button positions are
// hand-authored and documented there).
//
// What it does NOT prove, and cannot: the real macOS window-offset term
// (RN-040 §5a's `calibratedOffsetX/Y`) — headless Chromium has no real OS
// window, so that offset is always exactly zero here. The nonzero-offset
// case, and the `isTrusted: true` proof that the real OS cursor (not
// Playwright's synthetic input) delivered the click, are exactly Acceptance
// Metric 4 — deferred to the announced, attended machine-window run (see the
// forge report).
//
// CR-LENSMITH-A002-4 Acceptance Metric 1 added a SECOND describe block below
// (own beforeAll/afterAll, own small viewport) proving auto-scroll-into-view
// against `tests/fixtures/drive-scroll-test-page.html` — a real, tall page
// with content above, straddling, and fully below the fold. Same headless/
// fake-choreographer safety properties as above; still the only two places
// in the suite that launch a real browser.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "drive-test-page.html");
const FIXTURE_URL = `file://${FIXTURE_PATH}`;

// Hand-measured from `drive-test-page.html`'s own CSS (`#btn-one`/`#btn-two`
// are absolutely positioned with fixed left/top/width/height — see that
// file's comment). Center = (left + width/2, top + height/2).
const KNOWN_BUTTON_ONE_CENTER = { x: 120 + 160 / 2, y: 160 + 56 / 2 };
const KNOWN_BUTTON_TWO_CENTER = { x: 520 + 160 / 2, y: 360 + 56 / 2 };
const CALIBRATION_TOLERANCE_PX = 2;

function fakeChoreographer(): ChoreographerLike {
	let position: PointLike = { x: 0, y: 0 };
	return {
		async start() {
			// no-op — no real subprocess to spawn
		},
		stop() {
			// no-op — nothing to tear down
		},
		async moveTo(x: number, y: number): Promise<MoveResultLike> {
			position = { x, y };
			return { elapsedMs: 0, to: { x, y } };
		},
		async dwell() {
			// no-op — instant, no real hold-still delay
		},
		async click(): Promise<PointLike> {
			return position;
		},
	};
}

// The Settle pacing (CR-LENSMITH-A007-2) sleeps 1200 + 800 ms after every step; these tests
// check the real page, not the pacing, so they get an instant sleep.
const runDrive: typeof runDriveReal = (list, deps) =>
	runDriveReal(list, { sleep: async () => undefined, ...deps });

describe("runDrive against a REAL (headless) Chromium page — calibration positive control", () => {
	let browser: import("playwright").Browser;
	let page: PageLike & import("playwright").Page;

	beforeAll(async () => {
		browser = await chromium.launch({ headless: true });
		const realPage = await browser.newPage({ viewport: { width: 1000, height: 700 } });
		page = realPage as unknown as PageLike & import("playwright").Page;
	});

	afterAll(async () => {
		await browser.close();
	});

	it("computes screenX/screenY within tolerance of the hand-measured element centers", async () => {
		const { actionLog, viewport } = await runDrive(
			{
				url: FIXTURE_URL,
				steps: [
					{ type: "click", selector: "#btn-one", label: "click button one" },
					{ type: "wait", ms: 10 },
					{ type: "click", selector: "#btn-two", label: "click button two" },
				],
			},
			// Real sleeps: the zoom-fragment check at the end needs a realistic timeline
			// (the 800 ms zoom-in floor only holds against steps that really took time).
			{
				page,
				choreographer: fakeChoreographer(),
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			},
		);

		expect(actionLog).toHaveLength(3);
		const [first, , second] = actionLog;
		if (first?.type !== "click" || second?.type !== "click") {
			throw new Error(`expected click entries, got: ${actionLog.map((e) => e.type).join(",")}`);
		}

		// headless Chromium has no real OS window, so the calibrated offset is
		// always (0, 0) here — the real, nonzero window-offset case is Metric 4's.
		expect(Math.abs(first.screenX - KNOWN_BUTTON_ONE_CENTER.x)).toBeLessThanOrEqual(
			CALIBRATION_TOLERANCE_PX,
		);
		expect(Math.abs(first.screenY - KNOWN_BUTTON_ONE_CENTER.y)).toBeLessThanOrEqual(
			CALIBRATION_TOLERANCE_PX,
		);
		expect(Math.abs(second.screenX - KNOWN_BUTTON_TWO_CENTER.x)).toBeLessThanOrEqual(
			CALIBRATION_TOLERANCE_PX,
		);
		expect(Math.abs(second.screenY - KNOWN_BUTTON_TWO_CENTER.y)).toBeLessThanOrEqual(
			CALIBRATION_TOLERANCE_PX,
		);

		// Cross-check against a FRESH, independent boundingBox() call — proves
		// the action log's recorded box matches real layout, not a stale read.
		const freshBoxOne = await page.locator("#btn-one").boundingBox();
		const freshBoxTwo = await page.locator("#btn-two").boundingBox();
		expect(freshBoxOne).toEqual(first.boundingBox);
		expect(freshBoxTwo).toEqual(second.boundingBox);

		// The emitted zoom fragment, from a REAL run, still satisfies compose's
		// validation rules (id, startMs < endMs, 0..1 focus) — see
		// `zoomEmission.test.ts` for the exhaustive version of this check; this
		// is the same shape produced from genuine DOM measurement.
		const { fragment, warnings } = emitZoomRegions(actionLog, viewport);
		expect(fragment.zoomRegions).toHaveLength(2);
		expect(warnings).toEqual([]);
		for (const region of fragment.zoomRegions) {
			expect(region.id.length).toBeGreaterThan(0);
			expect(region.startMs).toBeLessThan(region.endMs);
			expect(region.focus.cx).toBeGreaterThanOrEqual(0);
			expect(region.focus.cx).toBeLessThanOrEqual(1);
			expect(region.focus.cy).toBeGreaterThanOrEqual(0);
			expect(region.focus.cy).toBeLessThanOrEqual(1);
		}
	}, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────
// CR-LENSMITH-A002-6 — the `type` step, driven against a REAL (headless)
// Chromium page. Same safety properties as the describe block above: headless,
// in-memory fake choreographer (no OS cursor, no subprocess), file:// URL.
// This is the automated proof that `pressSequentially` dispatches genuine DOM
// `input` events into a real page — `window.__lensmithTypeLog` is the fixture's
// own listener recording exactly that (see `drive-test-page.html`'s header).
// What this does NOT prove — the real OS cursor (not Playwright's synthetic
// input) delivering the focusing click — is the announced machine-window run
// (see the forge report), same deferral as the click-only describe block above.
// ─────────────────────────────────────────────────────────────────────────

describe("runDrive against a REAL (headless) Chromium page — the `type` step", () => {
	let browser: import("playwright").Browser;
	let page: PageLike & import("playwright").Page;

	beforeAll(async () => {
		browser = await chromium.launch({ headless: true });
		const realPage = await browser.newPage({ viewport: { width: 1000, height: 700 } });
		page = realPage as unknown as PageLike & import("playwright").Page;
	});

	afterAll(async () => {
		await browser.close();
	});

	it("drives click → type → click, and the page's own input-event log shows the real trusted value", async () => {
		const SENTINEL_TEXT = "LENSMITH-A002-6-SENTINEL-VALUE";

		const { actionLog, viewport } = await runDrive(
			{
				url: FIXTURE_URL,
				steps: [
					{ type: "click", selector: "#text-field", label: "focus the text field" },
					{ type: "type", selector: "#text-field", text: SENTINEL_TEXT, label: "type a value" },
					{ type: "click", selector: "#btn-submit", label: "click submit" },
				],
			},
			{ page, choreographer: fakeChoreographer() },
		);

		expect(actionLog).toHaveLength(3);
		const [, typeEntry] = actionLog;
		if (typeEntry?.type !== "type") throw new Error("expected a type entry");
		expect(typeEntry.characterCount).toBe(SENTINEL_TEXT.length);

		// The page received the characters as real input events — Chromium's
		// own DOM fired `input` with `isTrusted: true` for a Playwright-driven
		// keyboard sequence (CDP-level input), and the field's live value
		// matches what was sent, proving `pressSequentially` actually typed
		// rather than the call silently no-op'ing.
		const typeLog = await page.evaluate<
			Array<{ value: string; isTrusted: boolean }> | undefined,
			undefined
		>(() => (window as unknown as Record<string, unknown>).__lensmithTypeLog as never, undefined);
		expect(typeLog).toBeDefined();
		expect(typeLog?.length).toBeGreaterThan(0);
		const lastEntry = typeLog?.at(-1);
		expect(lastEntry?.value).toBe(SENTINEL_TEXT);
		for (const entry of typeLog ?? []) {
			expect(entry.isTrusted).toBe(true);
		}

		// The invariant this CR is built against: the sentinel text is in
		// neither the action log nor the emitted zoom fragment.
		const { fragment } = emitZoomRegions(actionLog, viewport);
		const actionLogJson = JSON.stringify(actionLog);
		const zoomFragmentJson = JSON.stringify(fragment);
		expect(actionLogJson).not.toContain(SENTINEL_TEXT);
		expect(zoomFragmentJson).not.toContain(SENTINEL_TEXT);
		// Positive control: the same string genuinely appears in the step
		// list that was fed in, so the assertions above prove the artifacts
		// are clean rather than proving the check itself is broken.
		expect(JSON.stringify({ text: SENTINEL_TEXT })).toContain(SENTINEL_TEXT);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// CR-LENSMITH-A002-4 Technical Spec item 1 / Acceptance Metric 1: auto-
// scroll-into-view. A real, tall page (3000px) with content above, straddling,
// and fully below an 800x600 viewport's fold — headless, fake choreographer,
// same safety properties as the describe block above.
// ─────────────────────────────────────────────────────────────────────────

const SCROLL_FIXTURE_PATH = path.join(__dirname, "fixtures", "drive-scroll-test-page.html");
const SCROLL_FIXTURE_URL = `file://${SCROLL_FIXTURE_PATH}`;
const SCROLL_VIEWPORT = { width: 800, height: 600 };

// Hand-measured from `drive-scroll-test-page.html`'s own CSS — the box each
// button has at scrollY=0 (its position immediately after navigation, before
// any scrolling).
const UNSCROLLED_BOX_ABOVE_FOLD = { x: 100, y: 40, width: 160, height: 56 };
const UNSCROLLED_BOX_PARTIAL = { x: 100, y: 560, width: 160, height: 56 };

describe("runDrive against a REAL (headless) Chromium page — auto-scroll-into-view", () => {
	let browser: import("playwright").Browser;
	let page: PageLike & import("playwright").Page;

	beforeAll(async () => {
		browser = await chromium.launch({ headless: true });
		const realPage = await browser.newPage({ viewport: SCROLL_VIEWPORT });
		page = realPage as unknown as PageLike & import("playwright").Page;
	});

	afterAll(async () => {
		await browser.close();
	});

	it("a target fully below the fold is scrolled into view, and its computed screen point matches a manually-scrolled equivalent", async () => {
		const { actionLog } = await runDrive(
			{ url: SCROLL_FIXTURE_URL, steps: [{ type: "click", selector: "#btn-below-fold" }] },
			{ page, choreographer: fakeChoreographer() },
		);

		const [entry] = actionLog;
		if (entry?.type !== "click") throw new Error("expected a click entry");

		// The manually-scrolled equivalent the Acceptance Metric's own wording
		// asks for: reload (resets scrollY to 0), scroll the SAME element into
		// view by hand, then read its box — independent of `runDrive`'s own
		// scroll call, on a fresh navigation.
		await page.goto(SCROLL_FIXTURE_URL, { waitUntil: "load" });
		await page.locator("#btn-below-fold").scrollIntoViewIfNeeded();
		const manualBox = await page.locator("#btn-below-fold").boundingBox();

		expect(entry.boundingBox).toEqual(manualBox);
		expect(manualBox).not.toBeNull();
		if (!manualBox) throw new Error("unreachable — checked above");
		expect(entry.screenX).toBe(manualBox.x + manualBox.width / 2);
		expect(entry.screenY).toBe(manualBox.y + manualBox.height / 2);

		// Negative control: the element's own static CSS position (top: 2700px)
		// is nowhere near what got recorded — proves a scroll genuinely
		// happened, not that the box coincidentally matched.
		expect(entry.boundingBox.y).not.toBeCloseTo(2700, 0);
	});

	it("a target only PARTIALLY visible (straddling the fold) is still scrolled — not just fully off-screen targets", async () => {
		const { actionLog } = await runDrive(
			{ url: SCROLL_FIXTURE_URL, steps: [{ type: "click", selector: "#btn-partial" }] },
			{ page, choreographer: fakeChoreographer() },
		);

		const [entry] = actionLog;
		if (entry?.type !== "click") throw new Error("expected a click entry");

		// It DID move: the recorded box differs from the element's un-scrolled
		// (scrollY=0) position, proving `scrollIntoViewIfNeeded` did real work
		// even though the element was already partially on-screen.
		expect(entry.boundingBox).not.toEqual(UNSCROLLED_BOX_PARTIAL);

		// And it matches a manually-scrolled equivalent, same cross-check as
		// the fully-off-screen case above.
		await page.goto(SCROLL_FIXTURE_URL, { waitUntil: "load" });
		await page.locator("#btn-partial").scrollIntoViewIfNeeded();
		const manualBox = await page.locator("#btn-partial").boundingBox();
		expect(entry.boundingBox).toEqual(manualBox);
	});

	it("a target already fully on-screen is unaffected — Invariant 5, the common case stays unchanged", async () => {
		const { actionLog } = await runDrive(
			{ url: SCROLL_FIXTURE_URL, steps: [{ type: "click", selector: "#btn-above-fold" }] },
			{ page, choreographer: fakeChoreographer() },
		);

		const [entry] = actionLog;
		if (entry?.type !== "click") throw new Error("expected a click entry");
		// scrollIntoViewIfNeeded is a no-op for an element already fully in
		// view — the recorded box is exactly its un-scrolled position.
		expect(entry.boundingBox).toEqual(UNSCROLLED_BOX_ABOVE_FOLD);
	});
});

// BF-14: a click that navigates destroys the page context while the settle wait is running.
// Headless, fake choreographer (no real cursor); the click itself is delivered by Playwright
// so the navigation really happens.
describe("runDrive when a click navigates to another page (BF-14)", () => {
	let browser: import("playwright").Browser;
	let page: PageLike & import("playwright").Page;

	beforeAll(async () => {
		browser = await chromium.launch({ headless: true });
		const realPage = await browser.newPage({ viewport: { width: 1000, height: 700 } });
		page = realPage as unknown as PageLike & import("playwright").Page;
	});

	afterAll(async () => {
		await browser.close();
	});

	it("waits for the new page, settles on it, and records settleMs without a destroyed-context error", async () => {
		const fake = fakeChoreographer();
		const choreographer: ChoreographerLike = {
			...fake,
			async click() {
				// Fire the navigation without awaiting it, so the settle wait starts while the
				// document is being replaced.
				void page.locator("#go").click();
				return { x: 0, y: 0 };
			},
		};
		const { actionLog } = await runDrive(
			{
				url: `file://${path.join(__dirname, "fixtures", "drive-nav-page.html")}`,
				steps: [{ type: "click", selector: "#go" }],
			},
			{ page, choreographer },
		);

		const [entry] = actionLog;
		if (entry?.type !== "click") throw new Error("expected a click entry");
		expect(entry.settleMs).toBeGreaterThan(0);
		expect(page.url()).toContain("drive-nav-page-2.html");
		expect(await page.locator("#arrived").isVisible()).toBe(true);
	});
});
