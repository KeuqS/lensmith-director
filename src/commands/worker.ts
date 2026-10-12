/**
 * `lensmith-director worker` — a long-lived process a human starts ONCE from
 * an already-granted terminal, which watches a job directory and runs
 * `demo`'s own compiled CLI (CR-LENSMITH-A002-7) as a child process for each
 * job it finds, one at a time. CR-LENSMITH-A002-8.
 *
 * **This command spawns the compiled `dist/cli.js demo` binary as an ordinary
 * child process — it never imports or calls `runDemo()` in-process.** That
 * matters beyond style: `registerDemoCommand`'s CLI action never supplies
 * `RunDemoDeps`, so the injectable `onTerminationSignal` gap CR-A002-7's own
 * guard report flagged (a narrow, CLI-unreachable window between the
 * recorder's spawn and the outer `try`'s start) stays exactly as unreachable
 * from this worker as it already is from every other real invocation of
 * `demo` today. This worker supplies no dependency object of any kind, so it
 * does not open that path.
 *
 * Job directory layout (created if absent): `<jobs>/queue`, `<jobs>/running`,
 * `<jobs>/done`, `<jobs>/failed`. A job is a `.json` file in `queue/` shaped
 * exactly like `demo`'s own argument set — see `jobSpec.ts`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	accessSync,
	constants as fsConstants,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Command, InvalidArgumentError } from "commander";
import { type JobSpec, readJobSpec } from "../lib/jobSpec.js";
import { checkScreenCaptureCapability } from "../lib/screenCapturePreflight.js";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function parsePollSeconds(raw: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new InvalidArgumentError(`--poll must be a positive number of seconds (got "${raw}").`);
	}
	return value;
}

// MARK: - Job directories

export interface JobDirs {
	queueDir: string;
	runningDir: string;
	doneDir: string;
	failedDir: string;
}

/** Technical Spec item 2: created if absent. */
export function ensureJobDirs(jobsDir: string): JobDirs {
	const dirs: JobDirs = {
		queueDir: path.join(jobsDir, "queue"),
		runningDir: path.join(jobsDir, "running"),
		doneDir: path.join(jobsDir, "done"),
		failedDir: path.join(jobsDir, "failed"),
	};
	for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
	return dirs;
}

// MARK: - Claiming (Technical Spec item 4)

export interface ClaimedJob {
	id: string;
	queuePath: string;
	runningPath: string;
}

/**
 * Claims the earliest (by filename) job in `queue/` by moving it to
 * `running/` — the move itself is the claim. `renameSync` throwing (already
 * moved by a concurrent claimer, or the file vanished) means this entry is
 * already spoken for; skip it and try the next. Returns `null` when nothing
 * is claimable.
 */
export function claimNextJob(jobsDir: string): ClaimedJob | null {
	const queueDir = path.join(jobsDir, "queue");
	const runningDir = path.join(jobsDir, "running");
	let entries: string[];
	try {
		entries = readdirSync(queueDir)
			.filter((f) => f.endsWith(".json"))
			.sort();
	} catch {
		return null;
	}
	for (const entry of entries) {
		const queuePath = path.join(queueDir, entry);
		const runningPath = path.join(runningDir, entry);
		try {
			renameSync(queuePath, runningPath);
		} catch {
			continue;
		}
		return { id: path.basename(entry, ".json"), queuePath, runningPath };
	}
	return null;
}

// MARK: - Result files (Technical Spec item 5)

export interface JobResult {
	id: string;
	command: string[];
	exitCode: number | null;
	artifacts: string[];
	startedAt: string;
	endedAt: string;
	/** Present only on failure — the child's stderr tail, or the validation error naming its field. */
	stderrTail?: string;
}

const STDERR_TAIL_MAX_CHARS = 4000;

/** Absolute paths of every FILE (not directory) directly inside `outDir`. `[]` if it never got created. */
function listArtifacts(outDir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(outDir);
	} catch {
		return [];
	}
	return entries
		.map((entry) => path.join(outDir, entry))
		.filter((entryPath) => {
			try {
				return statSync(entryPath).isFile();
			} catch {
				return false;
			}
		})
		.map((entryPath) => path.resolve(entryPath))
		.sort();
}

function writeResult(dir: string, id: string, result: JobResult): void {
	writeFileSync(
		path.join(dir, `${id}.result.json`),
		`${JSON.stringify(result, null, 2)}\n`,
		"utf-8",
	);
}

/** Technical Spec item 2: an invalid job moves straight to `failed/` naming the offending field. */
function failInvalidJob(dirs: JobDirs, claimed: ClaimedJob, error: unknown, at: Date): void {
	const result: JobResult = {
		id: claimed.id,
		command: [],
		exitCode: null,
		artifacts: [],
		startedAt: at.toISOString(),
		endedAt: at.toISOString(),
		stderrTail: messageOf(error),
	};
	writeResult(dirs.failedDir, claimed.id, result);
	renameSync(claimed.runningPath, path.join(dirs.failedDir, `${claimed.id}.json`));
}

// MARK: - Heartbeat (Technical Spec item 6)

interface Heartbeat {
	timestamp: string;
	pid: number;
	jobInFlight: string | null;
}

function writeHeartbeat(jobsDir: string, at: Date, pid: number, jobInFlight: string | null): void {
	const heartbeat: Heartbeat = { timestamp: at.toISOString(), pid, jobInFlight };
	writeFileSync(
		path.join(jobsDir, "worker.heartbeat.json"),
		`${JSON.stringify(heartbeat, null, 2)}\n`,
		"utf-8",
	);
}

// MARK: - Resolving this repo's own compiled CLI

export class DirectorCliMissingError extends Error {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled output lives at dist/commands/worker.js — cli.js sits one level up.
const defaultDirectorCliPath = path.resolve(__dirname, "..", "cli.js");

export function resolveDirectorCliPath(candidate: string = defaultDirectorCliPath): string {
	try {
		accessSync(candidate, fsConstants.R_OK);
	} catch {
		throw new DirectorCliMissingError(
			`This director CLI's own built entrypoint was not found at ${candidate}. Run "npm run build" first.`,
		);
	}
	return candidate;
}

// MARK: - Shutdown signal (mirrors demo.ts's own onTerminationSignal)

function defaultOnShutdownSignal(callback: (signal: NodeJS.Signals) => void): () => void {
	const handler = (signal: NodeJS.Signals) => callback(signal);
	process.once("SIGINT", handler);
	process.once("SIGTERM", handler);
	return () => {
		process.removeListener("SIGINT", handler);
		process.removeListener("SIGTERM", handler);
	};
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// MARK: - The loop

export interface RunWorkerOptions {
	jobsDir: string;
	pollMs: number;
}

export interface WorkerDeps {
	spawnFn?: typeof spawn;
	nodeBinPath?: string;
	resolveDirectorCliPath?: () => string;
	checkCaptureCapability?: () => string;
	sleep?: (ms: number) => Promise<void>;
	now?: () => Date;
	onShutdownSignal?: (callback: (signal: NodeJS.Signals) => void) => () => void;
}

/**
 * Runs the worker loop to completion — returns once an ordinary shutdown
 * signal has been handled (Technical Spec item 7); never returns on its own
 * otherwise. Throws BEFORE the loop is ever entered when the startup
 * preflight fails (Technical Spec item 3 / Invariant 1) — a caller must not
 * catch that and start the loop anyway.
 */
export async function runWorkerLoop(opts: RunWorkerOptions, deps: WorkerDeps = {}): Promise<void> {
	const spawnFn = deps.spawnFn ?? spawn;
	const nodeBinPath = deps.nodeBinPath ?? process.execPath;
	const resolveCliPath = deps.resolveDirectorCliPath ?? resolveDirectorCliPath;
	const checkCaptureCapability =
		deps.checkCaptureCapability ?? (() => checkScreenCaptureCapability());
	const sleep = deps.sleep ?? realSleep;
	const now = deps.now ?? (() => new Date());
	const onShutdownSignal = deps.onShutdownSignal ?? defaultOnShutdownSignal;

	const dirs = ensureJobDirs(opts.jobsDir);

	// Technical Spec item 3 / Invariant 1: proven BEFORE anything else runs —
	// nothing has started, so there is nothing to unwind, and this call
	// throwing means the loop below is never entered.
	const capabilityDetail = checkCaptureCapability();
	console.error(`worker: preflight passed — ${capabilityDetail}`);

	const directorCliPath = resolveCliPath();

	let shuttingDown = false;
	let killedForShutdown = false;
	let currentChild: ChildProcess | undefined;

	const unregisterShutdown = onShutdownSignal((signal) => {
		shuttingDown = true;
		if (currentChild && currentChild.exitCode === null && currentChild.signalCode === null) {
			killedForShutdown = true;
			currentChild.kill(signal);
		}
	});

	try {
		while (!shuttingDown) {
			const claimed = claimNextJob(opts.jobsDir);
			writeHeartbeat(opts.jobsDir, now(), process.pid, claimed?.id ?? null);

			if (!claimed) {
				await sleep(opts.pollMs);
				continue;
			}

			let spec: JobSpec;
			try {
				spec = readJobSpec(readFileSync(claimed.runningPath, "utf-8"));
			} catch (error) {
				failInvalidJob(dirs, claimed, error, now());
				continue;
			}

			killedForShutdown = false;
			const startedAt = now().toISOString();
			const args = ["demo", "--steps", spec.steps, "--out-dir", spec.outDir];
			const child = spawnFn(nodeBinPath, [directorCliPath, ...args], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			currentChild = child;

			let stderrTail = "";
			child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
			child.stderr?.on("data", (chunk: Buffer) => {
				process.stderr.write(chunk);
				stderrTail = `${stderrTail}${chunk.toString("utf-8")}`.slice(-STDERR_TAIL_MAX_CHARS);
			});

			const outcome = await new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
				child.once("error", (error) => resolve({ code: null, spawnError: error }));
				child.once("exit", (code) => resolve({ code }));
			});
			currentChild = undefined;
			const endedAt = now().toISOString();

			// Technical Spec item 7 / Invariant 3: a shutdown-triggered kill
			// requeues the job untouched rather than recording it as done or
			// failed — it was interrupted, not completed either way.
			if (killedForShutdown) {
				renameSync(claimed.runningPath, claimed.queuePath);
				continue;
			}

			const success = outcome.spawnError === undefined && outcome.code === 0;
			const result: JobResult = {
				id: claimed.id,
				command: [nodeBinPath, directorCliPath, ...args],
				exitCode: outcome.code,
				artifacts: listArtifacts(spec.outDir),
				startedAt,
				endedAt,
			};
			if (!success) {
				result.stderrTail = outcome.spawnError ? outcome.spawnError.message : stderrTail.trim();
			}

			const targetDir = success ? dirs.doneDir : dirs.failedDir;
			writeResult(targetDir, claimed.id, result);
			renameSync(claimed.runningPath, path.join(targetDir, `${claimed.id}.json`));
		}
	} finally {
		unregisterShutdown();
	}
}

const EXCLUSIVE_MACHINE_NOTICE =
	"Watching a job directory and running the full record/drive/compose/process pipeline for each " +
	"job found, one at a time, until stopped — the machine is exclusive for the duration of each " +
	"job. Start this from an already-granted terminal and do not touch the machine while a job is " +
	"in flight.";

export function registerWorkerCommand(program: Command): void {
	program
		.command("worker")
		.description(
			"watch a job directory and run the demo pipeline for each job found, one at a time, " +
				"until stopped (Ctrl+C for a clean shutdown)",
		)
		.requiredOption("--jobs <dir>", "job directory (queue/running/done/failed created if absent)")
		.option("--poll <seconds>", "poll interval in seconds", parsePollSeconds, 5)
		.action(async (opts: { jobs: string; poll: number }) => {
			console.error(EXCLUSIVE_MACHINE_NOTICE);
			try {
				await runWorkerLoop({ jobsDir: path.resolve(opts.jobs), pollMs: opts.poll * 1000 });
				console.log("worker: shut down cleanly");
			} catch (error) {
				console.error(`worker: ${messageOf(error)}`);
				process.exitCode = 1;
			}
		});
}
