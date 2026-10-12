/**
 * `worker`'s startup preflight (CR-LENSMITH-A002-8 Technical Spec item 3):
 * proves screen capture is actually possible, by the cheapest real check
 * available — a window enumeration, never a permission flag.
 * `CGPreflightScreenCaptureAccess()` is already known to answer `true` while
 * capture produces nothing usable ([[BF-5]]), so this shells out to
 * `lensmith-screen-capture-preflight` (`src/native/screen-capture-preflight/
 * main.swift`), which enumerates on-screen windows and checks whether any
 * other application's window title is genuinely visible — real captured
 * content, not a cached flag.
 */

import { spawnSync } from "node:child_process";
import { resolveScreenCapturePreflightPath } from "./nativeHelpers.js";

export class ScreenCaptureUnavailableError extends Error {}

export interface RunPreflightResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export interface ScreenCapturePreflightDeps {
	/** Injectable for tests only — production resolves the real compiled helper. */
	helperPath?: string;
	/** Injectable for tests only — production spawns the real helper synchronously. */
	runFn?: (helperPath: string) => RunPreflightResult;
}

function defaultRunFn(helperPath: string): RunPreflightResult {
	const result = spawnSync(helperPath, [], { encoding: "utf-8" });
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/**
 * Throws {@link ScreenCaptureUnavailableError} naming what is missing and the
 * exact remedy (the native helper's own stderr already carries both — see
 * `main.swift`) when capture is not possible right now. Resolves with the
 * helper's own success line when it is.
 */
export function checkScreenCaptureCapability(deps: ScreenCapturePreflightDeps = {}): string {
	const helperPath = deps.helperPath ?? resolveScreenCapturePreflightPath();
	const runFn = deps.runFn ?? defaultRunFn;
	const result = runFn(helperPath);
	if (result.status !== 0) {
		const detail =
			result.stderr.trim() || `the preflight helper exited with code ${result.status ?? "null"}`;
		throw new ScreenCaptureUnavailableError(detail);
	}
	return result.stdout.trim();
}
