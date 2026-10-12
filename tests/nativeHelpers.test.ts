import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_CHOREOGRAPHER_NAME,
	NativeHelperMissingError,
	resolveCursorChoreographerPath,
	resolveScreenCapturePreflightPath,
	SCREEN_CAPTURE_PREFLIGHT_NAME,
} from "../src/lib/nativeHelpers.js";

describe("resolveCursorChoreographerPath", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-native-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("names the missing binary AND the build step that produces it", () => {
		expect(() => resolveCursorChoreographerPath(dir)).toThrow(NativeHelperMissingError);
		try {
			resolveCursorChoreographerPath(dir);
		} catch (error) {
			expect((error as Error).message).toContain(CURSOR_CHOREOGRAPHER_NAME);
			expect((error as Error).message).toContain("npm run build:native:mac");
		}
	});

	it("resolves an existing, executable helper binary", () => {
		const helperPath = path.join(dir, CURSOR_CHOREOGRAPHER_NAME);
		writeFileSync(helperPath, "#!/bin/sh\necho fake helper\n");
		chmodSync(helperPath, 0o755);
		expect(resolveCursorChoreographerPath(dir)).toBe(helperPath);
	});

	it("rejects a file that exists but is not executable", () => {
		const helperPath = path.join(dir, CURSOR_CHOREOGRAPHER_NAME);
		writeFileSync(helperPath, "not executable");
		chmodSync(helperPath, 0o644);
		expect(() => resolveCursorChoreographerPath(dir)).toThrow(NativeHelperMissingError);
	});
});

describe("resolveScreenCapturePreflightPath", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-native-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("names the missing binary AND the build step that produces it", () => {
		expect(() => resolveScreenCapturePreflightPath(dir)).toThrow(NativeHelperMissingError);
		try {
			resolveScreenCapturePreflightPath(dir);
		} catch (error) {
			expect((error as Error).message).toContain(SCREEN_CAPTURE_PREFLIGHT_NAME);
			expect((error as Error).message).toContain("npm run build:native:mac");
		}
	});

	it("resolves an existing, executable helper binary", () => {
		const helperPath = path.join(dir, SCREEN_CAPTURE_PREFLIGHT_NAME);
		writeFileSync(helperPath, "#!/bin/sh\necho fake helper\n");
		chmodSync(helperPath, 0o755);
		expect(resolveScreenCapturePreflightPath(dir)).toBe(helperPath);
	});
});
