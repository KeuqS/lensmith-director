/**
 * Resolves the sibling `lensmith` engine repo's built CLI entrypoint
 * (`dist/cli.js`) explicitly — never assumed to be on PATH. CR-LENSMITH-A002-7.
 *
 * Measured 2026-09-12: the npm-linked `lensmith` executable exits 0 with zero
 * output on this machine, so resolving `lensmith` via PATH is a real,
 * silent-failure risk `demo` must not inherit. Spawning `process.execPath`
 * against the path this resolves sidesteps whatever npm's own bin shim was
 * doing, the same way `nativeHelpers.ts` resolves this repo's own compiled
 * Swift helper explicitly rather than trusting PATH.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE_BIN_ENV_VAR = "LENSMITH_ENGINE_BIN";

export class EngineBinaryMissingError extends Error {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled output lives at dist/lib/engineBinary.js — the repo root is two
// directories up (mirrors nativeHelpers.ts's own derivation).
const directorRepoRoot = path.resolve(__dirname, "..", "..");
const defaultEngineBinPath = path.resolve(directorRepoRoot, "..", "lensmith", "dist", "cli.js");

/**
 * `env` and `defaultPath` are injectable for tests only — production callers
 * resolve against `process.env` and the real sibling-repo default (the
 * director and engine checkouts as siblings under the same parent directory).
 */
export function resolveEngineBinaryPath(
	env: NodeJS.ProcessEnv = process.env,
	defaultPath: string = defaultEngineBinPath,
): string {
	const candidate = env[ENGINE_BIN_ENV_VAR] ?? defaultPath;
	try {
		accessSync(candidate, fsConstants.R_OK);
	} catch {
		throw new EngineBinaryMissingError(
			`Lensmith engine CLI not found at ${candidate}. Build it ("npm run build" in the lensmith ` +
				`repo) and either keep the lensmith-director checkout next to it as sibling directories, ` +
				`or set ${ENGINE_BIN_ENV_VAR} to its dist/cli.js path.`,
		);
	}
	return candidate;
}
