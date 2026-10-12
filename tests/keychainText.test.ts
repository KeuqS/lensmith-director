import { describe, expect, it } from "vitest";
import {
	type ExecFileFn,
	KeychainTextError,
	resolveKeychainText,
} from "../src/lib/keychainText.js";

// A visibly-synthetic value — never a real credential shape — used to prove
// the resolved value reaches only the places it should (CR-LENSMITH-A002-10
// Invariant 1). It stands in for "the resolver's return value" in tests; a
// real run never logs, greps or echoes this constant itself.
const SENTINEL = "SENTINEL-NOT-A-REAL-CODE";

function fakeExecFile(stdout: string): {
	fn: ExecFileFn;
	calls: Array<{ file: string; args: readonly string[] }>;
} {
	const calls: Array<{ file: string; args: readonly string[] }> = [];
	const fn: ExecFileFn = async (file, args) => {
		calls.push({ file, args });
		return { stdout, stderr: "" };
	};
	return { fn, calls };
}

function failingExecFile(stderr: string, code = 1): ExecFileFn {
	return async () => {
		const error = new Error(`Command failed`) as Error & {
			code?: number;
			stdout?: string;
			stderr?: string;
		};
		error.code = code;
		error.stdout = "";
		error.stderr = stderr;
		throw error;
	};
}

describe("resolveKeychainText", () => {
	it("resolves stdout with exactly one trailing newline removed", async () => {
		const { fn } = fakeExecFile(`${SENTINEL}\n`);
		const result = await resolveKeychainText({ service: "svc", account: "acct" }, { execFile: fn });
		expect(result).toBe(SENTINEL);
	});

	it("removes only one trailing newline, not a value's own embedded newlines", async () => {
		const { fn } = fakeExecFile("line-one\nline-two\n");
		const result = await resolveKeychainText({ service: "svc", account: "acct" }, { execFile: fn });
		expect(result).toBe("line-one\nline-two");
	});

	it("passes /usr/bin/security find-generic-password with -s/-a/-w and the literal service/account, as one argument each — never a shell, never string concatenation", async () => {
		const { fn, calls } = fakeExecFile("value\n");
		await resolveKeychainText({ service: "svc", account: "acct" }, { execFile: fn });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			file: "/usr/bin/security",
			args: ["find-generic-password", "-s", "svc", "-a", "acct", "-w"],
		});
	});

	// Invariant: "No shell, no injection" — a service containing shell
	// metacharacters must reach the injected execFile as one literal string,
	// never interpreted, never split, never executed.
	it("passes a service containing shell metacharacters through as one literal argument", async () => {
		const dangerous = "svc-$(touch /tmp/pwned)-`echo hi`-;rm -rf ~-'\"";
		const { fn, calls } = fakeExecFile("value\n");
		await resolveKeychainText({ service: dangerous, account: "acct" }, { execFile: fn });
		expect(calls[0]?.args).toEqual(["find-generic-password", "-s", dangerous, "-a", "acct", "-w"]);
	});

	it("resolves the sentinel unchanged — the positive control for the never-leaves-memory grep below", async () => {
		const { fn } = fakeExecFile(`${SENTINEL}\n`);
		const result = await resolveKeychainText({ service: "svc", account: "acct" }, { execFile: fn });
		// Positive control: the grep this proves finds the sentinel here,
		// where it is genuinely supposed to be — the resolver's own return value.
		expect(result).toContain(SENTINEL);
	});

	it("throws KeychainTextError naming service and account, with neither the child's stdout nor its raw stderr in the message, when the item is not found", async () => {
		const rawStderr =
			`security: SecKeychainSearchCopyNext: The specified item ${SENTINEL} could not be ` +
			"found in the keychain.";
		const fn = failingExecFile(rawStderr, 44);
		await expect(
			resolveKeychainText({ service: "my-service", account: "my-account" }, { execFile: fn }),
		).rejects.toThrow(KeychainTextError);

		try {
			await resolveKeychainText({ service: "my-service", account: "my-account" }, { execFile: fn });
			expect.unreachable("expected resolveKeychainText to throw");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toMatch(/my-service/);
			expect(message).toMatch(/my-account/);
			expect(message).not.toContain(SENTINEL);
			expect(message).not.toBe(rawStderr);
		}
	});

	it("maps a locked/unavailable keychain to fixed wording, without echoing raw stderr", async () => {
		const rawStderr = `security: SecKeychainItemCopyContent: User interaction is not allowed. ${SENTINEL}`;
		const fn = failingExecFile(rawStderr, 25);
		try {
			await resolveKeychainText({ service: "svc", account: "acct" }, { execFile: fn });
			expect.unreachable("expected resolveKeychainText to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(KeychainTextError);
			const message = (error as Error).message;
			expect(message).toMatch(/locked|unavailable/i);
			expect(message).not.toContain(SENTINEL);
			expect(message).not.toContain("User interaction is not allowed");
		}
	});

	// BF-8 / CR-LENSMITH-A002-13: `execFile` has no timeout of its own — a
	// wedged `security` process (or a keychain-locked prompt this call never
	// allows) would otherwise hang `drive` forever. This proves the bound
	// against a fake that never resolves at all, never a real keychain.
	it("times out and rejects with a KeychainTextError naming the bound, when execFile never resolves", async () => {
		const neverResolves: ExecFileFn = () =>
			new Promise(() => {
				// deliberately never settles — the fault this test injects
			});

		const startedAt = Date.now();
		let thrown: unknown;
		try {
			await resolveKeychainText(
				{ service: "svc", account: "acct" },
				{ execFile: neverResolves, timeoutMs: 100 },
			);
		} catch (error) {
			thrown = error;
		}
		const elapsedMs = Date.now() - startedAt;

		expect(thrown).toBeInstanceOf(KeychainTextError);
		expect((thrown as Error).message).toMatch(/100ms/);
		expect((thrown as Error).message).toMatch(/svc/);
		expect((thrown as Error).message).toMatch(/acct/);
		// Bounded by ITS OWN injected timeout, not left to run long.
		expect(elapsedMs).toBeLessThan(1000);
	}, 2000);

	it("falls back to a generic, exit-code-only message for an unrecognized failure, still without raw stderr", async () => {
		const rawStderr = `some unrecognized security failure mode ${SENTINEL}`;
		const fn = failingExecFile(rawStderr, 99);
		try {
			await resolveKeychainText({ service: "svc", account: "acct" }, { execFile: fn });
			expect.unreachable("expected resolveKeychainText to throw");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toMatch(/99/);
			expect(message).not.toContain(SENTINEL);
			expect(message).not.toContain(rawStderr);
		}
	});
});
