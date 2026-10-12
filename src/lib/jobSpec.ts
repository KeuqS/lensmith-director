/**
 * Job-file schema for `worker` (CR-LENSMITH-A002-8). A job is exactly the
 * argument set of `demo`'s own command (CR-LENSMITH-A002-7): `{ steps,
 * outDir }`, camelCase to match the parsed `commander` option keys
 * `registerDemoCommand`'s action receives. Mirrors `stepList.ts`'s own
 * validate-before-run discipline — a malformed job fails fast, before any
 * process is spawned, naming the offending field.
 */

export class JobSpecError extends Error {
	constructor(
		public readonly field: string,
		message: string,
	) {
		super(message);
	}
}

export interface JobSpec {
	steps: string;
	outDir: string;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Validates an already-parsed value. Throws {@link JobSpecError} naming the first problem found. */
export function validateJobSpec(parsed: unknown): JobSpec {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new JobSpecError("<root>", 'the job file must be an object with "steps" and "outDir"');
	}

	const { steps, outDir } = parsed as { steps?: unknown; outDir?: unknown };

	if (typeof steps !== "string" || steps.length === 0) {
		throw new JobSpecError(
			"steps",
			`the job's "steps" must be a non-empty string path (demo's own --steps) — got ${JSON.stringify(steps)}`,
		);
	}
	if (typeof outDir !== "string" || outDir.length === 0) {
		throw new JobSpecError(
			"outDir",
			`the job's "outDir" must be a non-empty string path (demo's own --out-dir) — got ${JSON.stringify(outDir)}`,
		);
	}

	return { steps, outDir };
}

/** Reads and validates a job file's raw contents. Throws {@link JobSpecError} for bad JSON or a bad shape. */
export function readJobSpec(rawJson: string): JobSpec {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch (error) {
		throw new JobSpecError("<root>", `the job file is not valid JSON: ${messageOf(error)}`);
	}
	return validateJobSpec(parsed);
}
