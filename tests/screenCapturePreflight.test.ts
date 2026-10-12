import { describe, expect, it } from "vitest";
import {
	checkScreenCaptureCapability,
	ScreenCaptureUnavailableError,
} from "../src/lib/screenCapturePreflight.js";

describe("checkScreenCaptureCapability", () => {
	it("resolves with the helper's own success line when it exits 0", () => {
		const detail = checkScreenCaptureCapability({
			helperPath: "/fake/lensmith-screen-capture-preflight",
			runFn: () => ({
				status: 0,
				stdout: "3 window(s) with a real, visible title out of 12 enumerated.\n",
				stderr: "",
			}),
		});
		expect(detail).toBe("3 window(s) with a real, visible title out of 12 enumerated.");
	});

	it(
		"throws ScreenCaptureUnavailableError naming what is missing and the remedy when the " +
			"helper exits non-zero — the exact shape a permission-less SSH session produces",
		() => {
			const remedy =
				"No other application's window title is visible to this process. Grant Screen " +
				"Recording in System Settings, then restart the worker.";
			expect(() =>
				checkScreenCaptureCapability({
					helperPath: "/fake/lensmith-screen-capture-preflight",
					runFn: () => ({ status: 1, stdout: "", stderr: remedy }),
				}),
			).toThrow(ScreenCaptureUnavailableError);

			try {
				checkScreenCaptureCapability({
					helperPath: "/fake/lensmith-screen-capture-preflight",
					runFn: () => ({ status: 1, stdout: "", stderr: remedy }),
				});
				throw new Error("expected to throw");
			} catch (error) {
				expect((error as Error).message).toBe(remedy);
			}
		},
	);

	it("falls back to naming the bare exit code when the helper wrote nothing to stderr", () => {
		expect(() =>
			checkScreenCaptureCapability({
				helperPath: "/fake/lensmith-screen-capture-preflight",
				runFn: () => ({ status: 2, stdout: "", stderr: "" }),
			}),
		).toThrow(/exited with code 2/);
	});
});
