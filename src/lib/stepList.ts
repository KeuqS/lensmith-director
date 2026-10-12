/**
 * Step-list schema + validator for `drive --steps`.
 *
 * Whatever generates this file is out of scope here (the step list is
 * plain JSON) — this module only
 * validates the shape, mirroring `compose`'s own validate-before-write
 * discipline in the sibling `lensmith` repo
 * (`lensmith/src/commands/compose.ts:validateZoomFragment`): a malformed
 * input fails fast, before anything is launched, naming the offending step's
 * index — never a raw stack trace, never a partially-driven run.
 */

export interface ClickStep {
	type: "click";
	selector: string;
	label?: string;
	/**
	 * Overrides `drive.ts`'s
	 * `DEFAULT_ACTION_TIMEOUT_MS` for this step's element wait, scroll and
	 * bounding-box read. Validated exactly as `wait`'s `ms` is — a finite
	 * positive number, or the step list is rejected before anything launches.
	 */
	timeoutMs?: number;
	/**
	 * CR-LENSMITH-A008-2. The narration line spoken over this step, with at most one `[[mark]]`
	 * placed before the word the click should land on. Timed by `drive --narration`; ignored
	 * (the step drives exactly as without it) when no narration timings are given.
	 */
	say?: string;
}

export interface WaitStep {
	type: "wait";
	ms: number;
	/** See {@link ClickStep.say}. A wait step has no click: a mark, if present, is not used. */
	say?: string;
}

/**
 * Focuses `selector` (driven through the same choreographer
 * a `click` step uses) and enters `text` as real input, character by character.
 * `text` is carried only as long as it takes to drive it — neither `drive.ts`'s
 * action-log entry nor `zoomEmission.ts`'s fragment ever records it (see
 * `actionLog.ts`'s `ActionLogTypeEntry`).
 */
export interface TypeStepLiteral {
	type: "type";
	selector: string;
	text: string;
	label?: string;
	/** See {@link ClickStep.timeoutMs} — same override, same validation. */
	timeoutMs?: number;
	/** See {@link ClickStep.say}. The mark lands on the click that focuses the field. */
	say?: string;
}

/**
 * The alternative to a literal `text` — the step names
 * *where* to find the value (a macOS keychain service/account pair) rather
 * than carrying the value itself, so a credential never has to be written
 * into a step-list file. Resolution happens at drive time only
 * (`keychainText.ts`); this module never executes anything.
 */
export interface TypeStepFromKeychain {
	type: "type";
	selector: string;
	textFrom: { keychain: { service: string; account: string } };
	label?: string;
	/** See {@link ClickStep.timeoutMs} — same override, same validation. */
	timeoutMs?: number;
	/** See {@link ClickStep.say}. The mark lands on the click that focuses the field. */
	say?: string;
}

export type TypeStep = TypeStepLiteral | TypeStepFromKeychain;

export type Step = ClickStep | WaitStep | TypeStep;

export interface StepList {
	url: string;
	steps: Step[];
	/**
	 * Optional minimum driven-window width (CSS px) this step list requires.
	 * A target UI can hide elements behind a responsive breakpoint (for
	 * example a sidebar that is `hidden lg:flex`, invisible below Tailwind's
	 * 1024px `lg` breakpoint) while `drive`
	 * always launches with `viewport: null` (the real OS window size). On a
	 * narrow window, a step targeting that element fails with Playwright's
	 * generic 30s `waitFor` timeout and no indication why. When set,
	 * `runDrive` checks this ONCE, before any step runs (the whole run
	 * shares one window), and raises a specific, named error instead.
	 */
	minViewportWidth?: number;
}

export class StepListError extends Error {}

function stepLabel(index: number): string {
	return `step at index ${index}`;
}

/**
 * Shared by the `click` and `type` branches below: a non-positive or non-numeric `timeoutMs` is rejected by name,
 * exactly like `wait`'s `ms` is, before anything launches.
 */
function validateOptionalTimeoutMs(
	value: unknown,
	label: string,
	stepType: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || (value as number) <= 0) {
		throw new StepListError(
			`${label} (type "${stepType}") has a non-positive or non-numeric "timeoutMs" ` +
				`(got ${JSON.stringify(value)})`,
		);
	}
	return value as number;
}

/** Any `[[...]]` tag in a `say` line; the name is checked separately so a bad name is named. */
const SAY_TAG = /\[\[([^\]]*)\]\]/g;
/**
 * CR-LENSMITH-A008-2: the allowed mark name — the same rule the engine's `lensmith narrate` uses to
 * find marks (`/\[\[(\w+)\]\]/`, CR-LENSMITH-A008-5): letters, digits and "_", no hyphen.
 */
export const SAY_MARK_NAME = /^\w+$/;

/** The `[[mark]]` name in a validated `say` line, or undefined when the line carries none. */
export function sayMark(say: string): string | undefined {
	for (const m of say.matchAll(SAY_TAG)) return m[1];
	return undefined;
}

/**
 * CR-LENSMITH-A008-2: `say` is optional; when present it is a non-empty string with at most
 * one `[[mark]]`, whose name matches {@link SAY_MARK_NAME}.
 */
function validateOptionalSay(value: unknown, label: string, stepType: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new StepListError(`${label} (type "${stepType}") has a non-string or empty "say"`);
	}
	const marks = [...value.matchAll(SAY_TAG)].map((m) => m[1] as string);
	if (marks.length > 1) {
		throw new StepListError(
			`${label} (type "${stepType}") has ${marks.length} [[mark]] tags in "say" — at most one is allowed`,
		);
	}
	const [mark] = marks;
	if (mark !== undefined && !SAY_MARK_NAME.test(mark)) {
		throw new StepListError(
			`${label} (type "${stepType}") has an invalid [[mark]] name in "say" ` +
				`(got ${JSON.stringify(mark)}; allowed: letters, digits and "_")`,
		);
	}
	return value;
}

function validateStep(raw: unknown, index: number): Step {
	const label = stepLabel(index);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new StepListError(`${label} is not an object`);
	}

	const { type } = raw as { type?: unknown };

	if (type === "click") {
		const {
			selector,
			label: stepDisplayLabel,
			timeoutMs,
			say,
		} = raw as { selector?: unknown; label?: unknown; timeoutMs?: unknown; say?: unknown };
		if (typeof selector !== "string" || selector.length === 0) {
			throw new StepListError(`${label} (type "click") has a missing or empty "selector"`);
		}
		if (stepDisplayLabel !== undefined && typeof stepDisplayLabel !== "string") {
			throw new StepListError(`${label} (type "click") has a non-string "label"`);
		}
		const validatedTimeoutMs = validateOptionalTimeoutMs(timeoutMs, label, "click");
		const validatedSay = validateOptionalSay(say, label, "click");
		const step: ClickStep = { type: "click", selector };
		if (typeof stepDisplayLabel === "string") step.label = stepDisplayLabel;
		if (validatedTimeoutMs !== undefined) step.timeoutMs = validatedTimeoutMs;
		if (validatedSay !== undefined) step.say = validatedSay;
		return step;
	}

	if (type === "wait") {
		const { ms, say } = raw as { ms?: unknown; say?: unknown };
		if (!Number.isFinite(ms) || (ms as number) <= 0) {
			throw new StepListError(
				`${label} (type "wait") has a missing or non-positive "ms" (got ${JSON.stringify(ms)})`,
			);
		}
		const validatedSay = validateOptionalSay(say, label, "wait");
		const step: WaitStep = { type: "wait", ms: ms as number };
		if (validatedSay !== undefined) step.say = validatedSay;
		return step;
	}

	if (type === "type") {
		const {
			selector,
			text,
			textFrom,
			label: stepDisplayLabel,
			timeoutMs,
			say,
		} = raw as {
			selector?: unknown;
			text?: unknown;
			textFrom?: unknown;
			label?: unknown;
			timeoutMs?: unknown;
			say?: unknown;
		};
		if (typeof selector !== "string" || selector.length === 0) {
			throw new StepListError(`${label} (type "type") has a missing or empty "selector"`);
		}
		if (stepDisplayLabel !== undefined && typeof stepDisplayLabel !== "string") {
			throw new StepListError(`${label} (type "type") has a non-string "label"`);
		}
		const validatedTimeoutMs = validateOptionalTimeoutMs(timeoutMs, label, "type");
		const validatedSay = validateOptionalSay(say, label, "type");

		const hasText = text !== undefined;
		const hasTextFrom = textFrom !== undefined;
		if (hasText === hasTextFrom) {
			throw new StepListError(
				`${label} (type "type") must have exactly one of "text" or "textFrom" ` +
					`(got ${hasText ? "both" : "neither"})`,
			);
		}

		if (hasText) {
			if (typeof text !== "string") {
				throw new StepListError(`${label} (type "type") has a non-string "text"`);
			}
			const step: TypeStepLiteral = { type: "type", selector, text };
			if (typeof stepDisplayLabel === "string") step.label = stepDisplayLabel;
			if (validatedTimeoutMs !== undefined) step.timeoutMs = validatedTimeoutMs;
			if (validatedSay !== undefined) step.say = validatedSay;
			return step;
		}

		if (typeof textFrom !== "object" || textFrom === null || Array.isArray(textFrom)) {
			throw new StepListError(`${label} (type "type") has a non-object "textFrom"`);
		}
		const { keychain } = textFrom as { keychain?: unknown };
		if (typeof keychain !== "object" || keychain === null || Array.isArray(keychain)) {
			throw new StepListError(
				`${label} (type "type") has a "textFrom" with a missing or invalid "keychain" object`,
			);
		}
		const { service, account } = keychain as { service?: unknown; account?: unknown };
		if (typeof service !== "string" || service.length === 0) {
			throw new StepListError(
				`${label} (type "type") has a "textFrom.keychain" with a missing or empty "service"`,
			);
		}
		if (typeof account !== "string" || account.length === 0) {
			throw new StepListError(
				`${label} (type "type") has a "textFrom.keychain" with a missing or empty "account"`,
			);
		}
		const step: TypeStepFromKeychain = {
			type: "type",
			selector,
			textFrom: { keychain: { service, account } },
		};
		if (typeof stepDisplayLabel === "string") step.label = stepDisplayLabel;
		if (validatedTimeoutMs !== undefined) step.timeoutMs = validatedTimeoutMs;
		if (validatedSay !== undefined) step.say = validatedSay;
		return step;
	}

	throw new StepListError(
		`${label} has an unknown "type" (got ${JSON.stringify(type)}) — expected "click", "wait", or "type"`,
	);
}

/** Validates an already-parsed value. Throws {@link StepListError} naming the first problem found. */
export function validateStepList(parsed: unknown): StepList {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new StepListError('the step list must be an object with "url" and "steps"');
	}

	const { url, steps, minViewportWidth } = parsed as {
		url?: unknown;
		steps?: unknown;
		minViewportWidth?: unknown;
	};

	if (typeof url !== "string" || url.length === 0) {
		throw new StepListError('the step list\'s "url" must be a non-empty string');
	}
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new StepListError('the step list\'s "steps" must be a non-empty array');
	}
	if (
		minViewportWidth !== undefined &&
		(typeof minViewportWidth !== "number" ||
			!Number.isFinite(minViewportWidth) ||
			minViewportWidth <= 0)
	) {
		throw new StepListError(
			`the step list's "minViewportWidth" must be a positive finite number when present ` +
				`(got ${JSON.stringify(minViewportWidth)})`,
		);
	}

	const result: StepList = { url, steps: steps.map((raw, index) => validateStep(raw, index)) };
	if (minViewportWidth !== undefined) result.minViewportWidth = minViewportWidth as number;
	return result;
}

/** Reads and validates `--steps`. Throws {@link StepListError} for bad JSON or a bad shape. */
export function readStepList(rawJson: string, sourcePath: string): StepList {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new StepListError(`"${sourcePath}" is not valid JSON: ${message}`);
	}
	return validateStepList(parsed);
}
