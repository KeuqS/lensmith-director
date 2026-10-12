import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { resolveCursorChoreographerPath } from "./nativeHelpers.js";
import {
	DEFAULT_DWELL_MS,
	DEFAULT_MOVE_DURATION_MS,
	distancePx,
	dwell,
	moveTimingWarnings,
} from "./timing.js";

export interface Point {
	x: number;
	y: number;
}

export interface MoveResult {
	/** Number of interpolated events actually posted. */
	steps: number;
	/** Wall-clock duration of the move, as measured by the helper. */
	elapsedMs: number;
	from: Point;
	to: Point;
	/** Advisory timing notes — see `timing.ts`. Never fatal. */
	warnings: string[];
}

interface HelperMessage {
	type: string;
	cmd?: string;
	message?: string;
	[key: string]: unknown;
}

export class CursorChoreographerError extends Error {}

/**
 * How far the Swift helper's reported achieved position may sit from what
 * was requested/expected before it counts as delivery failing rather than
 * ordinary floating-point noise. Matches `CR-LENSMITH-A002-1` Acceptance
 * Metric 3's own bar ("a subsequent `position` reports the target within
 * 1 px"), validated live 2026-08-13 — reused here, not reinvented
 * ([[CR-LENSMITH-A002-3]]).
 *
 * Inclusive: exactly {@link POSITION_TOLERANCE_PX} away is ACCEPTED (that is
 * the literal "within 1 px" the metric measured); only strictly MORE than
 * this counts as divergence. See `#verifyDelivered` and
 * `tests/cursorChoreographer.test.ts`'s boundary tests.
 */
export const POSITION_TOLERANCE_PX = 1;

/**
 * The Swift helper reported an achieved position that diverges from what was
 * requested/expected by more than {@link POSITION_TOLERANCE_PX} — [[BF-2]]'s
 * exact failure shape: a move or click that macOS silently failed to
 * deliver (e.g. Accessibility revoked mid-session, a stray system event)
 * instead of throwing or exiting non-zero. Carries both values so a caller
 * can log or react to the specific delta, and is a distinct class (not a
 * generic {@link CursorChoreographerError}) so "the OS didn't deliver this"
 * is distinguishable from any other helper failure.
 */
export class CursorDeliveryError extends CursorChoreographerError {
	readonly requested: Point;
	readonly achieved: Point;

	constructor(requested: Point, achieved: Point) {
		const distance = distancePx(requested, achieved);
		super(
			`Cursor delivery diverged past the ${POSITION_TOLERANCE_PX}px tolerance: requested ` +
				`(${requested.x}, ${requested.y}), but the OS reports it landed at ` +
				`(${achieved.x}, ${achieved.y}) — ${distance.toFixed(2)}px off. The move or click may ` +
				"not have actually happened (Accessibility permission revoked mid-session, a stray " +
				"system event, or another transient delivery failure).",
		);
		this.name = "CursorDeliveryError";
		this.requested = requested;
		this.achieved = achieved;
	}
}

/**
 * The injectable trust seam (see {@link CursorChoreographerOptions.isTrusted})
 * reported the process as untrusted — matching the specific, actionable
 * failure the real Swift helper's own `AXIsProcessTrusted()` preflight emits
 * over NDJSON (`main.swift`'s `ensureAccessibilityTrusted`), Technical Spec
 * item 3 of [[CR-LENSMITH-A002-3]]. A distinct class, not a generic
 * {@link CursorChoreographerError}, so this specific cause is distinguishable
 * from any other helper failure.
 */
export class AccessibilityTrustError extends CursorChoreographerError {}

const READY_TIMEOUT_MS = 10_000;
const COMMAND_OVERHEAD_MS = 10_000;

const ACCESSIBILITY_TRUST_MESSAGE =
	"Accessibility permission is not granted to the cursor helper. Grant it in System Settings → " +
	"Privacy & Security → Accessibility, then try again.";

export interface CursorChoreographerOptions {
	helperPath?: string;
	/** Injectable for tests only — production spawns the real helper via `node:child_process`. */
	spawnFn?: typeof spawn;
	/**
	 * Injectable Accessibility-trust seam — Technical Spec item 4 of
	 * [[CR-LENSMITH-A002-3]]. `AXIsProcessTrusted()` is a macOS Accessibility
	 * API with no TypeScript binding, and RN-040 §5c already established that
	 * revoking a live grant mid-session to exercise the real untrusted path
	 * is not safely doable. The REAL check runs Swift-side (`main.swift`'s
	 * `ensureAccessibilityTrusted`, once per helper invocation) and its
	 * failure arrives as an ordinary NDJSON error already handled by
	 * `#settle()` — production code never sets this option and defers
	 * entirely to that.
	 *
	 * This option exists ONLY so a test can prove the WRAPPER's own
	 * reaction to "untrusted" — fail loudly with a specific error, send
	 * nothing to the helper — without a real Swift binary or a real
	 * permission change. When set and it returns `false`, `moveTo()`,
	 * `click()` and `warm()` throw {@link AccessibilityTrustError}
	 * immediately, before any command reaches the helper process.
	 */
	isTrusted?: () => boolean;
}

/**
 * Node-side wrapper around the native cursor choreographer.
 *
 * It holds the helper open as a LONG-LIVED process on purpose. The first event
 * posted by a fresh process costs 31-36 ms — two orders of magnitude more than
 * the ~7 µs a warm post costs — and that cost lands as a visible stutter at the
 * start of the first move. One process, warmed once, moves smoothly from the
 * first frame.
 *
 * Nothing in here posts an event until you ask it to. `position()` is read-only;
 * `moveTo()`, `click()` and `warm()` all synthesise real input.
 */
export class CursorChoreographer {
	#child: ChildProcess | undefined;
	#reader: Interface | undefined;
	#queue: Array<{
		resolve: (message: HelperMessage) => void;
		reject: (error: Error) => void;
		timer: NodeJS.Timeout;
	}> = [];
	#exitError: Error | undefined;
	#rejectReady: ((error: Error) => void) | undefined;
	readonly #helperPath: string;
	readonly #isTrusted: (() => boolean) | undefined;
	readonly #spawnFn: typeof spawn;
	/**
	 * Best-known position the cursor is expected to be at, used to verify
	 * `click()`'s achieved result — see `#verifyDelivered` and `click()`.
	 * `undefined` until the first `moveTo()`/`click()` establishes a
	 * baseline, so a standalone `click()` (no preceding `moveTo()` in this
	 * session — e.g. the CLI's `cursor click`) has nothing to diverge from
	 * and simply records its result as the new baseline.
	 */
	#expectedPosition: Point | undefined;

	constructor(options: CursorChoreographerOptions = {}) {
		this.#helperPath = options.helperPath ?? resolveCursorChoreographerPath();
		this.#isTrusted = options.isTrusted;
		this.#spawnFn = options.spawnFn ?? spawn;
	}

	get isRunning(): boolean {
		return this.#child !== undefined;
	}

	async start(): Promise<void> {
		if (this.#child) return;

		const child = this.#spawnFn(this.#helperPath, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
		this.#child = child;
		this.#exitError = undefined;

		// Invariant: a child that reaches this line has already been spawned as
		// a real OS process — every throw from here to the end of `start()`
		// must kill it before this method's caller ever sees the rejection,
		// the same "no acquisition without an owner for even one throw" rule
		// CR-LENSMITH-A002-9 round 2 generalised across this repo. This branch
		// is defensive (`stdio: ["pipe","pipe","pipe"]` guarantees non-null
		// streams in practice) but a defensive check that itself leaks on the
		// path it defends against is worse than no check.
		if (!child.stdout || !child.stdin) {
			child.kill();
			this.#child = undefined;
			throw new CursorChoreographerError("Failed to open a pipe to the cursor helper.");
		}

		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new CursorChoreographerError(
						`Cursor helper did not report ready within ${READY_TIMEOUT_MS}ms.`,
					),
				);
			}, READY_TIMEOUT_MS);
			// A helper that dies before it says "ready" must fail start() at once,
			// not sit on the timeout — the common cause is a binary that cannot
			// run at all, and that answer should arrive immediately.
			this.#rejectReady = (error: Error) => {
				clearTimeout(timer);
				reject(error);
			};

			const reader = createInterface({ input: child.stdout as NodeJS.ReadableStream });
			this.#reader = reader;

			let seenReady = false;
			reader.on("line", (line) => {
				const trimmed = line.trim();
				if (trimmed === "") return;
				let message: HelperMessage;
				try {
					message = JSON.parse(trimmed) as HelperMessage;
				} catch {
					// The helper only ever writes NDJSON; anything else is noise
					// from the runtime and must not desynchronise the queue.
					return;
				}
				if (!seenReady && message.type === "ready") {
					seenReady = true;
					clearTimeout(timer);
					this.#rejectReady = undefined;
					resolve();
					return;
				}
				this.#settle(message);
			});
		});

		child.on("error", (error) => {
			this.#fail(new CursorChoreographerError(`Cursor helper failed to start: ${error.message}`));
		});

		child.on("exit", (code, signal) => {
			this.#child = undefined;
			const detail = stderr.trim() ? ` — ${stderr.trim()}` : "";
			this.#fail(
				new CursorChoreographerError(
					`Cursor helper exited (code ${code ?? "null"}, signal ${signal ?? "null"})${detail}`,
				),
			);
		});

		try {
			await ready;
		} catch (error) {
			this.stop();
			throw error;
		}
	}

	#settle(message: HelperMessage): void {
		const pending = this.#queue.shift();
		if (!pending) return;
		clearTimeout(pending.timer);
		if (message.type === "error") {
			pending.reject(
				new CursorChoreographerError(
					message.message ?? `Cursor helper reported an error for "${message.cmd ?? "?"}".`,
				),
			);
			return;
		}
		pending.resolve(message);
	}

	/**
	 * Preflight for anything that posts a real event — `warm()`, `moveTo()`,
	 * `click()`. Throws before `#send()` is ever called, so an untrusted
	 * process sends NOTHING to the helper (Acceptance Metric 4 of
	 * [[CR-LENSMITH-A002-3]]: "no move/click call reaches the fake helper at
	 * all"). A no-op when {@link CursorChoreographerOptions.isTrusted} was
	 * never set — the real, authoritative check runs Swift-side.
	 */
	#assertTrusted(action: string): void {
		if (this.#isTrusted !== undefined && !this.#isTrusted()) {
			throw new AccessibilityTrustError(`${ACCESSIBILITY_TRUST_MESSAGE} (cannot ${action}.)`);
		}
	}

	/**
	 * [[BF-2]]'s fix: compare an achieved position against what was
	 * requested/expected and throw {@link CursorDeliveryError} if they
	 * diverge past {@link POSITION_TOLERANCE_PX}. Exactly on the boundary is
	 * ACCEPTED — see {@link POSITION_TOLERANCE_PX}'s own doc comment.
	 */
	#verifyDelivered(requested: Point, achieved: Point): void {
		if (distancePx(requested, achieved) > POSITION_TOLERANCE_PX) {
			throw new CursorDeliveryError(requested, achieved);
		}
	}

	#fail(error: Error): void {
		this.#exitError = error;
		const rejectReady = this.#rejectReady;
		this.#rejectReady = undefined;
		rejectReady?.(error);
		const queued = this.#queue;
		this.#queue = [];
		for (const pending of queued) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}

	async #send(command: Record<string, unknown>, timeoutMs: number): Promise<HelperMessage> {
		if (!this.#child?.stdin) {
			throw this.#exitError ?? new CursorChoreographerError("Cursor helper is not running.");
		}
		const stdin = this.#child.stdin;
		return await new Promise<HelperMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				const index = this.#queue.findIndex((entry) => entry.timer === timer);
				if (index >= 0) this.#queue.splice(index, 1);
				reject(
					new CursorChoreographerError(
						`Cursor helper did not answer "${String(command.cmd)}" within ${timeoutMs}ms.`,
					),
				);
			}, timeoutMs);
			this.#queue.push({ resolve, reject, timer });
			stdin.write(`${JSON.stringify(command)}\n`);
		});
	}

	/** Read-only. Posts nothing. */
	async position(): Promise<Point> {
		const message = await this.#send({ cmd: "position" }, COMMAND_OVERHEAD_MS);
		return { x: Number(message.x), y: Number(message.y) };
	}

	/**
	 * Posts a no-op move to the cursor's current location, paying the 31-36 ms
	 * first-post cost up front. Nothing moves — but this DOES post a real event.
	 */
	async warm(): Promise<void> {
		this.#assertTrusted("warm");
		await this.#send({ cmd: "warm" }, COMMAND_OVERHEAD_MS);
	}

	/**
	 * Eased move. Posts real motion events. Negative coordinates are valid.
	 *
	 * [[BF-2]] / [[CR-LENSMITH-A002-3]]: the helper's reported achieved
	 * position (`to`) is verified against the REQUESTED `{x, y}` before this
	 * resolves — a divergence past {@link POSITION_TOLERANCE_PX} throws
	 * {@link CursorDeliveryError} instead of silently returning a position
	 * that was never actually reached.
	 */
	async moveTo(
		x: number,
		y: number,
		durationMs: number = DEFAULT_MOVE_DURATION_MS,
	): Promise<MoveResult> {
		this.#assertTrusted("move");
		if (!Number.isFinite(durationMs) || durationMs <= 0) {
			throw new CursorChoreographerError(
				`durationMs must be a positive number of milliseconds (got ${durationMs}).`,
			);
		}
		const message = await this.#send(
			{ cmd: "move", x, y, durationMs: Math.round(durationMs) },
			durationMs + COMMAND_OVERHEAD_MS,
		);
		const from = { x: Number(message.fromX), y: Number(message.fromY) };
		const to = { x: Number(message.x), y: Number(message.y) };
		const requested = { x, y };
		this.#verifyDelivered(requested, to);
		this.#expectedPosition = to;
		return {
			steps: Number(message.steps),
			elapsedMs: Number(message.elapsedMs),
			from,
			to,
			warnings: moveTimingWarnings(from, requested, durationMs),
		};
	}

	/**
	 * Real left click at the current location.
	 *
	 * [[BF-2]] / [[CR-LENSMITH-A002-3]]: verified against `#expectedPosition`
	 * (the last position a `moveTo()`/`click()` in this session established)
	 * — catches the narrower failure mode BF-2 named as still-invisible even
	 * with permission granted: a stray event moving the cursor between the
	 * dwell and the click. `undefined` (no prior move this session) means
	 * nothing to diverge from, so the first call in a session cannot throw.
	 */
	async click(): Promise<Point> {
		this.#assertTrusted("click");
		const message = await this.#send({ cmd: "click" }, COMMAND_OVERHEAD_MS);
		const achieved = { x: Number(message.x), y: Number(message.y) };
		if (this.#expectedPosition !== undefined) {
			this.#verifyDelivered(this.#expectedPosition, achieved);
		}
		this.#expectedPosition = achieved;
		return achieved;
	}

	/** Hold still — the second half of the timing recipe. */
	async dwell(ms: number = DEFAULT_DWELL_MS): Promise<void> {
		await dwell(ms);
	}

	stop(): void {
		this.#reader?.close();
		this.#reader = undefined;
		const child = this.#child;
		this.#child = undefined;
		if (child) {
			child.stdin?.end();
			child.kill();
		}
		this.#fail(new CursorChoreographerError("Cursor helper was stopped."));
		this.#exitError = undefined;
		// A restarted helper (or a fresh process next time start() is called)
		// has no memory of this baseline — stale, it could produce a false
		// CursorDeliveryError against a position from a previous session.
		this.#expectedPosition = undefined;
	}
}

async function withChoreographer<T>(
	options: { helperPath?: string },
	run: (choreographer: CursorChoreographer) => Promise<T>,
): Promise<T> {
	const choreographer = new CursorChoreographer(options);
	await choreographer.start();
	try {
		return await run(choreographer);
	} finally {
		choreographer.stop();
	}
}

/**
 * One-shot convenience wrappers. Each starts and stops its own helper process,
 * so each pays the 31-36 ms first-post cost — fine for a single CLI invocation,
 * wrong for a sequence. Hold a {@link CursorChoreographer} open for a real run.
 */
export async function position(options: { helperPath?: string } = {}): Promise<Point> {
	return await withChoreographer(options, (choreographer) => choreographer.position());
}

export async function moveTo(
	x: number,
	y: number,
	durationMs: number = DEFAULT_MOVE_DURATION_MS,
	options: { helperPath?: string } = {},
): Promise<MoveResult> {
	return await withChoreographer(options, (choreographer) =>
		choreographer.moveTo(x, y, durationMs),
	);
}

export async function click(options: { helperPath?: string } = {}): Promise<Point> {
	return await withChoreographer(options, (choreographer) => choreographer.click());
}
