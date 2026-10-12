import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ENGINE_BIN_ENV_VAR,
	EngineBinaryMissingError,
	resolveEngineBinaryPath,
} from "../src/lib/engineBinary.js";

describe("resolveEngineBinaryPath", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "lensmith-director-engine-bin-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("names the missing path AND the env var override, exit is a clean error not a silent run", () => {
		const missing = path.join(dir, "does-not-exist", "cli.js");
		expect(() => resolveEngineBinaryPath({}, missing)).toThrow(EngineBinaryMissingError);
		try {
			resolveEngineBinaryPath({}, missing);
		} catch (error) {
			expect((error as Error).message).toContain(missing);
			expect((error as Error).message).toContain(ENGINE_BIN_ENV_VAR);
		}
	});

	it("resolves the default path when it exists and is readable", () => {
		const cliPath = path.join(dir, "cli.js");
		writeFileSync(cliPath, "// fake engine cli\n");
		expect(resolveEngineBinaryPath({}, cliPath)).toBe(cliPath);
	});

	it("an env var override takes precedence over the default path", () => {
		const overridePath = path.join(dir, "override-cli.js");
		writeFileSync(overridePath, "// fake engine cli\n");
		const defaultPath = path.join(dir, "does-not-exist.js");
		expect(resolveEngineBinaryPath({ [ENGINE_BIN_ENV_VAR]: overridePath }, defaultPath)).toBe(
			overridePath,
		);
	});

	it("a nonexistent env var override is a clean error naming that exact path", () => {
		const overridePath = path.join(dir, "nonexistent-override.js");
		expect(() => resolveEngineBinaryPath({ [ENGINE_BIN_ENV_VAR]: overridePath })).toThrow(
			EngineBinaryMissingError,
		);
	});
});
