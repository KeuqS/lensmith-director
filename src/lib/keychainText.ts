/**
 * Resolves a `type` step's `textFrom.keychain` coordinates to the stored
 * secret. CR-LENSMITH-A002-10.
 *
 * This exists so a credential never has to be written into a step-list file
 * — some driven journeys type a sign-in code or another one-time secret, and
 * that value must never appear in a document a step list produces or an
 * agent transcript records. The one fixed system binary, `/usr/bin/security`,
 * is invoked through `execFile` with an argument array — never a shell,
 * never string concatenation — so a `service` or `account` value containing
 * shell metacharacters is passed through as one literal argument and cannot
 * run anything else. Validating the step list (`stepList.ts`) never calls
 * this; resolution happens at drive time only.
 */

import { execFile as nodeExecFile } from "node:child_process";

export class KeychainTextError extends Error {}

export interface KeychainCoordinates {
	service: string;
	account: string;
}

export interface ExecFileResult {
	stdout: string;
	stderr: string;
}

/** The subset of a Node `execFile` callback error this module reads. */
interface ExecFileError extends Error {
	code?: number | string | null;
	stdout?: string;
	stderr?: string;
}

/**
 * Injectable seam — production resolves the real `/usr/bin/security` via
 * `node:child_process`; tests supply a fake that never touches a real
 * keychain, so the never-leaves-memory and no-shell invariants are provable
 * without reading a real keychain value (see the CR's Invariants). The
 * optional third argument is CR-LENSMITH-A002-13 (BF-8): production passes
 * it straight through to Node's own `execFile` `timeout` option, so a real
 * wedged `security` process is also killed, not just given up on here.
 */
export type ExecFileFn = (
	file: string,
	args: readonly string[],
	options?: { timeoutMs?: number },
) => Promise<ExecFileResult>;

const SECURITY_BINARY_PATH = "/usr/bin/security";

/**
 * BF-8: a local keychain read is fast; this is generous margin over that,
 * not over any legitimate slow external wait — there is none here, unlike
 * the Turnstile-driven action bound in `drive.ts`. Bounds both the real
 * child process (via `defaultExecFile`'s own `timeout` option below, which
 * also terminates it) and — via {@link withTimeout} in
 * {@link resolveKeychainText} — a fake `execFile` in a fault-injection test
 * that never resolves at all, since a fake cannot honor Node's `timeout`
 * option itself.
 */
export const KEYCHAIN_TIMEOUT_MS = 10_000;

function defaultExecFile(
	file: string,
	args: readonly string[],
	options?: { timeoutMs?: number },
): Promise<ExecFileResult> {
	return new Promise((resolve, reject) => {
		nodeExecFile(
			file,
			args as string[],
			{ encoding: "utf-8", timeout: options?.timeoutMs },
			(error, stdout, stderr) => {
				if (error) {
					const execError = error as ExecFileError;
					execError.stdout = stdout;
					execError.stderr = stderr;
					reject(execError);
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}

/**
 * Races `promise` against a timer — the mechanism that makes the bound
 * provable against a fake `execFile` that never resolves (Node's own
 * `execFile` `timeout` option only ever bounds a REAL child process; a fake
 * function in a test has no such option to honor). Whichever settles first
 * wins; the loser's eventual settlement (if any) is simply never observed.
 */
function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout: () => Error,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export interface ResolveKeychainTextDeps {
	/** Injectable for tests only — production runs the real `/usr/bin/security`. */
	execFile?: ExecFileFn;
	/**
	 * Injectable for tests only (BF-8) — production uses
	 * {@link KEYCHAIN_TIMEOUT_MS}. Overridable so a fault-injection test can
	 * prove the bound against a never-resolving fake `execFile` without
	 * waiting out the real 10s.
	 */
	timeoutMs?: number;
}

/**
 * Resolves `{ service, account }` to the stored secret's value via
 * `security find-generic-password -s <service> -a <account> -w`, with the
 * one trailing newline `security` appends removed. Throws
 * {@link KeychainTextError} on any non-zero exit — naming the service and
 * account, but never the child's stdout, and never its raw stderr — mapping
 * the two known cases (item not found; keychain locked / user interaction
 * not allowed) to fixed wording, and any other failure to a generic message
 * naming only the exit code.
 */
export async function resolveKeychainText(
	coords: KeychainCoordinates,
	deps: ResolveKeychainTextDeps = {},
): Promise<string> {
	const execFile = deps.execFile ?? defaultExecFile;
	const timeoutMs = deps.timeoutMs ?? KEYCHAIN_TIMEOUT_MS;
	const { service, account } = coords;

	try {
		const { stdout } = await withTimeout(
			execFile(
				SECURITY_BINARY_PATH,
				["find-generic-password", "-s", service, "-a", account, "-w"],
				{ timeoutMs },
			),
			timeoutMs,
			() =>
				new KeychainTextError(
					`keychain read for service "${service}", account "${account}" did not complete ` +
						`within ${timeoutMs}ms.`,
				),
		);
		return stdout.replace(/\n$/, "");
	} catch (error) {
		if (error instanceof KeychainTextError) throw error;
		const execError = error as ExecFileError;
		const stderr = typeof execError.stderr === "string" ? execError.stderr : "";

		if (/could not be found in the keychain/i.test(stderr)) {
			throw new KeychainTextError(
				`no keychain item for service "${service}", account "${account}". Add it with: ` +
					`security add-generic-password -s "${service}" -a "${account}" -w "<value>"`,
			);
		}
		if (/user interaction is not allowed/i.test(stderr) || /could not be unlocked/i.test(stderr)) {
			throw new KeychainTextError(
				`the keychain is locked or unavailable for service "${service}", account "${account}" ` +
					"— unlock the login keychain in a GUI session and retry.",
			);
		}
		throw new KeychainTextError(
			`could not read the keychain item for service "${service}", account "${account}" ` +
				`(exit code ${execError.code ?? "unknown"}).`,
		);
	}
}
