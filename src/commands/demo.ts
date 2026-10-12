/**
 * `lensmith-director demo` — sequences all four pipeline commands (the
 * engine's `record`, this repo's own `drive`, then the engine's `compose`
 * and `process`) into one invocation, so producing a clip is not four
 * hand-run commands with a human as the joint between them. CR-LENSMITH-A002-7.
 *
 * CR-LENSMITH-A008-5: when any step carries a `say` line, a `narrate` stage runs first —
 * the engine's `lensmith narrate` turns the say lines into audio plus `timings.json`, and the
 * drive is paced to it (the click lands on the line's `[[mark]]`, the hold covers the voice).
 * Without say lines nothing below changes.
 *
 * Order (Technical Spec item 2): start the recorder and wait for its own
 * ready line, run the driver, always stop the recorder next (whether the
 * driver succeeded or not), then compose and process. A failure at any stage
 * throws a {@link DemoError} naming that stage and leaves whatever was
 * already written in `--out-dir` in place — nothing here deletes a partial
 * artifact.
 *
 * `runDemo` takes every external effect (spawning the recorder/compose/
 * process children, performing the drive stage, probing a media file's
 * duration) as injectable `RunDemoDeps`, the same split `runDrive`
 * (`drive.ts`) and `runRecord` (the sibling engine repo's `recordSession.ts`)
 * already use — so the full stage sequencing, the stage-failure reporting,
 * and the always-stop-the-recorder guarantee are unit-testable against
 * fakes that launch no browser, spawn no real process, and post no OS
 * cursor event. Only `registerDemoCommand`'s CLI action uses the real
 * implementations, exercised only in an announced, attended machine window
 * (this repo's standing rule — see `CLAUDE.md`).
 *
 * **Invariant (CR-LENSMITH-A002-7 round 2, [[BF-6]]): once the recorder child
 * exists, it is owned for the rest of this function's lifetime, structurally
 * — not by inspection of each branch that follows.** The recorder is created
 * and immediately entered into a `try/finally` whose `finally` stops it
 * unconditionally (`stopRecorder` is idempotent: a no-op against a child that
 * already exited). This covers every way control can leave that region: the
 * ready-wait timing out or the child erroring/exiting before ever reporting
 * ready, the driver throwing, a thrown error from any step afterward, and a
 * SIGINT/SIGTERM delivered to this process itself (raced against whichever
 * stage is in flight via `onTerminationSignal`). A `SIGKILL` to this process
 * is the one exit path no code here can observe or react to — the recorder
 * is left running in that case, and no amount of `try/finally` changes that.
 * Do not re-derive this by reading the branches; if you add a stage between
 * spawn and the `finally`, it inherits this guarantee for free — only a
 * change that spawns the recorder somewhere else, or returns before the
 * `try` begins, can reopen it.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { ActionLogEntry } from "../lib/actionLog.js";
import { resolveEngineBinaryPath as resolveRealEngineBinaryPath } from "../lib/engineBinary.js";
import { readStepList, type StepList } from "../lib/stepList.js";
import { emitZoomRegions, logMsToFilmMs } from "../lib/zoomEmission.js";
import {
	acquirePage,
	DEFAULT_BROWSER_CHANNEL,
	defaultProfileDir,
	type NarrationTimings,
	narrationLineId,
	type RunDriveResult,
	readNarrationTimings,
	runDrive,
	withLaunchedChrome,
} from "./drive.js";

export type DemoStage =
	| "engine"
	| "steps"
	| "narrate"
	| "record"
	| "drive"
	| "compose"
	| "process"
	| "voiceover";

export class DemoError extends Error {
	constructor(
		public readonly stage: DemoStage,
		message: string,
	) {
		super(message);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface DemoRunOptions {
	stepsPath: string;
	outDir: string;
	/** Defaults to {@link defaultProfileDir} — CR-LENSMITH-A002-9. */
	profileDir?: string;
	/** Defaults to {@link DEFAULT_BROWSER_CHANNEL} — CR-LENSMITH-A002-9. */
	browserChannel?: string;
	/** CR-LENSMITH-A008-5: passed through to the engine's `narrate --voice`; omitted = engine default. */
	voice?: string;
	/** CR-LENSMITH-A008-5: passed through to the engine's `narrate --engine`; omitted = engine default (kokoro). */
	narrateEngine?: string;
	/** CR-LENSMITH-A008-6: passed through to the engine's `voiceover --captions`; omitted = the engine default (burn). */
	captions?: "burn" | "srt" | "none";
}

interface DemoPaths {
	rawVideo: string;
	cursorTelemetry: string;
	sessionInfo: string;
	actionLog: string;
	zoomFragment: string;
	projectFile: string;
	renderedVideo: string;
	voiceStarts: string;
	voicedVideo: string;
	manifest: string;
	narrationScript: string;
	narrationDir: string;
	narrationTimings: string;
}

/**
 * Fixed filenames inside `--out-dir` — `rawVideo`'s basename drives the
 * other two (`cursorTelemetry`, `sessionInfo`), matching the exact naming
 * convention `lensmith record` itself applies (`recordPaths.ts` in the
 * sibling engine repo: `<out>.cursor.json` appended, `<out>` extension
 * SWAPPED for `.session.json`). Duplicated here as two literal strings
 * rather than imported — the two repos share no source (see this repo's
 * `CLAUDE.md`) — and kept this simple because `demo` always names the raw
 * recording `raw.mp4` itself, so there is no general extension to swap.
 */
function buildOutputPaths(outDir: string): DemoPaths {
	return {
		rawVideo: path.join(outDir, "raw.mp4"),
		cursorTelemetry: path.join(outDir, "raw.mp4.cursor.json"),
		sessionInfo: path.join(outDir, "raw.session.json"),
		actionLog: path.join(outDir, "action-log.json"),
		zoomFragment: path.join(outDir, "zooms.json"),
		projectFile: path.join(outDir, "project.openscreen"),
		renderedVideo: path.join(outDir, "final.mp4"),
		voiceStarts: path.join(outDir, "voice-starts.json"),
		voicedVideo: path.join(outDir, "final-voiced.mp4"),
		manifest: path.join(outDir, "demo-manifest.json"),
		narrationScript: path.join(outDir, "narration-script.json"),
		narrationDir: path.join(outDir, "narration"),
		narrationTimings: path.join(outDir, "narration", "timings.json"),
	};
}

const RECORD_READY_MARKER = "Recording ready.";
const RECORD_READY_TIMEOUT_MS = 15_000;
const RECORD_STOP_TIMEOUT_MS = 30_000;

export interface SpawnedRecorder {
	child: ChildProcess;
	/** Resolves once the recorder's own ready line has been seen on its stdout. */
	ready: Promise<void>;
}

/**
 * Starts the engine's `record` command as a child process and resolves
 * `ready` the moment its stdout carries the literal ready line
 * `recordSession.ts` logs (`"[lensmith] Recording ready."`) — Technical Spec
 * item 2: "wait for its own ready line before the driver launches." Every
 * line of the child's stdout/stderr is forwarded to this process's own
 * stdout/stderr as it arrives (not buffered), the same "surface the child's
 * own output live" mechanism `runEngineCommand` below uses for compose/process.
 */
export function spawnRecorder(
	spawnFn: typeof spawn,
	nodeBinPath: string,
	engineBinPath: string,
	outPath: string,
	readyTimeoutMs: number,
	/** BF-15: `window:<id>` records only the driven Chrome window; omitted records the whole screen. */
	source?: string,
): SpawnedRecorder {
	const recordArgs = [engineBinPath, "record", "--out", outPath];
	if (source !== undefined) recordArgs.push("--source", source);
	const child = spawnFn(nodeBinPath, recordArgs, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	const ready = new Promise<void>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error("timed out waiting for the recorder to report ready"));
		}, readyTimeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			process.stdout.write(chunk);
			if (!settled && chunk.toString("utf-8").includes(RECORD_READY_MARKER)) {
				settled = true;
				clearTimeout(timer);
				resolve();
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`recorder exited before becoming ready (code=${code}, signal=${signal})`));
		});
	});

	return { child, ready };
}

/**
 * Stops a still-running recorder with SIGINT (the same signal
 * `recordSession.ts` listens for to trigger its own clean shutdown —
 * writing the telemetry/session files — before it exits) and waits for it
 * to actually exit, escalating to SIGKILL only if it never does. Resolves
 * with the exit code rather than rejecting — this always runs from a
 * `finally` block and must never mask whatever error is already in flight.
 *
 * Round 2 (CR-LENSMITH-A002-7): this is now reachable from `runDemo` even
 * when the recorder never became ready — including the case where it never
 * started as a real process at all (its `error` event fired instead of
 * `ready`). `SIGKILL` cannot be caught, but the OS still owns exactly when a
 * genuinely-running process is reaped and Node observes it; and a child that
 * was never a real process may never emit `exit` no matter what is sent to
 * it. Without the `giveUp` fallback below, either case would hang this
 * promise — and therefore `runDemo`'s `finally` — forever, which would
 * silently defeat the very guarantee this function exists to provide.
 */
export function stopRecorder(child: ChildProcess, timeoutMs: number): Promise<number | null> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve(child.exitCode);
			return;
		}
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			clearTimeout(escalate);
			clearTimeout(giveUp);
			resolve(child.exitCode);
		};
		const escalate = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, timeoutMs);
		const giveUp = setTimeout(settle, timeoutMs + 1_000);
		child.once("exit", settle);
		child.kill("SIGINT");
	});
}

/** Runs an engine subcommand to completion, its stdout/stderr inherited live — Technical Spec item 4. */
export function runEngineCommand(
	spawnFn: typeof spawn,
	nodeBinPath: string,
	engineBinPath: string,
	args: string[],
): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawnFn(nodeBinPath, [engineBinPath, ...args], { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}

/**
 * Launches a real Chrome (persistent profile) + choreographer and runs the
 * driver against them — the exact same acquire-then-own lifecycle
 * `registerDriveCommand`'s own CLI action uses in `drive.ts`
 * (`withLaunchedChrome` / `acquirePage`, CR-LENSMITH-A002-9 round 2: shared by
 * both call sites precisely so this ordering cannot drift between them again).
 * `runDrive` itself (the orchestration this delegates to) is exhaustively
 * unit-tested in `tests/drive.test.ts` against a fake page and choreographer;
 * `demo`'s own tests inject a whole replacement for this function
 * (`RunDemoDeps.performDrive`) rather than re-building those fakes here —
 * what `demo` adds is the stage SEQUENCING around this step, not the driving
 * logic itself.
 */
async function defaultPerformDrive(
	stepList: StepList,
	options: { profileDir: string; browserChannel: string },
	hooks: DriveHooks,
	narration: NarrationTimings | undefined,
): Promise<RunDriveResult> {
	return withLaunchedChrome(
		{ ...options, discoverWindow: true, activate: true },
		async (ctx, choreographer, windowId) => {
			const page = await acquirePage(ctx);
			// BF-15: the window exists now, so the recorder can start on it — before any step runs.
			await hooks.onWindowReady(windowId);
			try {
				await choreographer.start();
				return await runDrive(
					stepList,
					narration === undefined ? { page, choreographer } : { page, choreographer, narration },
				);
			} finally {
				choreographer.stop();
				// BF-16: stop the recorder while the window still exists — a window-source stream
				// dies when Chrome closes, and `withLaunchedChrome` closes it as soon as this returns.
				await hooks.onDriveFinished?.();
			}
		},
	);
}

/** `ffprobe`'s real output on failure/absence is never guessed at — `null` means genuinely unknown. */
function defaultProbeDurationMs(filePath: string): number | null {
	const result = spawnSync(
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
		{ encoding: "utf-8" },
	);
	if (result.error || result.status !== 0) return null;
	const seconds = Number.parseFloat((result.stdout ?? "").trim());
	return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

/**
 * Registers a callback for the process-termination signals (SIGINT,
 * SIGTERM) that would otherwise kill this process immediately with no
 * cleanup — the same mechanism [[BF-6]] already documented for the
 * recorder's own process, here aimed at the *director* process instead.
 * Returns an unregister function. Mirrors `drive.ts`'s own `onInterrupt`
 * dependency (`(cb) => process.once("SIGINT", cb)`) so tests can trigger the
 * same code path deterministically without sending a real OS signal.
 */
function defaultOnTerminationSignal(callback: (signal: NodeJS.Signals) => void): () => void {
	const handler = (signal: NodeJS.Signals) => callback(signal);
	process.once("SIGINT", handler);
	process.once("SIGTERM", handler);
	return () => {
		process.removeListener("SIGINT", handler);
		process.removeListener("SIGTERM", handler);
	};
}

/** Callbacks `performDrive` makes while it runs (BF-15: the recorder can only start once the window exists). */
export interface DriveHooks {
	/**
	 * Called once, after the driven Chrome window is open and BEFORE the first step. `windowId` is
	 * the window's CGWindowID, or null when it could not be found (the recorder then falls back to
	 * the whole screen).
	 */
	onWindowReady(windowId: number | null): Promise<void>;
	/**
	 * BF-16: called once the steps are done (or failed) and BEFORE Chrome is closed, so a
	 * window-source recording is stopped while its window still exists.
	 */
	onDriveFinished?(): Promise<void>;
}

export interface RunDemoDeps {
	spawnFn?: typeof spawn;
	nodeBinPath?: string;
	resolveEngineBinaryPath?: () => string;
	/**
	 * `narration` (CR-LENSMITH-A008-5) is the validated engine `timings.json` when the steps carry
	 * `say` lines — the same value `drive --narration` reads — and undefined otherwise.
	 */
	performDrive?: (
		stepList: StepList,
		hooks: DriveHooks,
		narration?: NarrationTimings,
	) => Promise<RunDriveResult>;
	probeDurationMs?: (filePath: string) => number | null;
	readyTimeoutMs?: number;
	stopTimeoutMs?: number;
	onTerminationSignal?: (callback: (signal: NodeJS.Signals) => void) => () => void;
}

interface ManifestArtifact {
	name: string;
	path: string;
	sizeBytes: number;
	durationMs: number | null;
}

interface Manifest {
	generatedAt: string;
	stepsPath: string;
	artifacts: ManifestArtifact[];
}

export interface DemoResult {
	manifestPath: string;
	artifacts: ManifestArtifact[];
}

/**
 * Runs the full pipeline. Throws {@link DemoError} naming the failing stage
 * on the first failure; on success writes the manifest and returns its path
 * plus every artifact entry. See this file's header for the stage order and
 * the always-stop-the-recorder guarantee.
 */
export async function runDemo(opts: DemoRunOptions, deps: RunDemoDeps = {}): Promise<DemoResult> {
	const spawnFn = deps.spawnFn ?? spawn;
	const nodeBinPath = deps.nodeBinPath ?? process.execPath;
	const resolveEngineBinaryPath = deps.resolveEngineBinaryPath ?? resolveRealEngineBinaryPath;
	const profileDir = opts.profileDir ?? defaultProfileDir();
	const browserChannel = opts.browserChannel ?? DEFAULT_BROWSER_CHANNEL;
	const performDrive =
		deps.performDrive ??
		((stepList: StepList, hooks: DriveHooks, narration?: NarrationTimings) =>
			defaultPerformDrive(stepList, { profileDir, browserChannel }, hooks, narration));
	const probeDurationMs = deps.probeDurationMs ?? defaultProbeDurationMs;
	const readyTimeoutMs = deps.readyTimeoutMs ?? RECORD_READY_TIMEOUT_MS;
	const stopTimeoutMs = deps.stopTimeoutMs ?? RECORD_STOP_TIMEOUT_MS;
	const onTerminationSignal = deps.onTerminationSignal ?? defaultOnTerminationSignal;

	// Invariant: "engine binary not resolvable -> immediate clear error, not a
	// silent empty run." Checked first, before anything else — nothing has
	// started yet, so there is nothing to unwind.
	let engineBinPath: string;
	try {
		engineBinPath = resolveEngineBinaryPath();
	} catch (error) {
		throw new DemoError("engine", messageOf(error));
	}

	let stepList: StepList;
	try {
		const raw = readFileSync(opts.stepsPath, "utf-8");
		stepList = readStepList(raw, opts.stepsPath);
	} catch (error) {
		throw new DemoError("steps", messageOf(error));
	}

	mkdirSync(opts.outDir, { recursive: true });
	const paths = buildOutputPaths(opts.outDir);

	// CR-LENSMITH-A008-5: the narrate stage, before anything is recorded — the drive needs the
	// voice timings up front to place each click on its line's [[mark]]. Steps without any `say`
	// line skip it entirely and run exactly as before.
	const narration = await runNarrateStage(stepList, opts, paths, {
		spawnFn,
		nodeBinPath,
		engineBinPath,
	});

	// CR-LENSMITH-A002-9 round 2 audit: registered BEFORE the recorder is
	// spawned, not after — `onTerminationSignal` is an injectable dependency
	// (a call to arbitrary code), and a throw from it must never find an
	// already-spawned recorder with no owner yet. Registering a signal
	// handler before anything exists for it to protect is free; the reverse
	// order is the one that can leak.
	//
	// A signal delivered to this process (SIGINT/SIGTERM) would otherwise
	// terminate it immediately with no chance for the `finally` below to run
	// — see [[BF-6]]. Racing it against whichever stage is in flight turns it
	// into an ordinary rejection this function already knows how to unwind
	// through. `.catch(() => {})` only suppresses an "unhandled rejection"
	// warning if the signal fires after both races below have settled (e.g.
	// during compose/process, once the recorder is already stopped and
	// `unregisterSignal` has run) — it does not affect which value either
	// race observes.
	let currentStage: DemoStage = "record";
	let rejectOnSignal: (error: DemoError) => void = () => {
		// Replaced synchronously below, before any await; only ever called if
		// a signal somehow arrived before that — a no-op is the right default.
	};
	const signal = new Promise<never>((_resolve, reject) => {
		rejectOnSignal = reject;
	});
	signal.catch(() => {
		// Suppresses "unhandled rejection" only for a signal that arrives
		// after both races below have settled — see the comment above.
	});
	const unregisterSignal = onTerminationSignal((receivedSignal) => {
		rejectOnSignal(
			new DemoError(
				currentStage,
				`interrupted by ${receivedSignal} before the ${currentStage} stage finished — stopping the recorder`,
			),
		);
	});

	// Ownership of the recorder's lifetime begins at the spawn call itself — not after
	// `recorder.ready` resolves. BF-15: the spawn now happens inside `onWindowReady`, which
	// `performDrive` calls once the driven Chrome window exists (a window-source recording needs
	// the window first). The `try`/`finally` below wraps `performDrive`, so every path out —
	// including a failure before the hook ran — still reaches the stop.
	let recorder: SpawnedRecorder | undefined;
	let recorderStopped = false;
	let recorderExitCode: number | null = null;
	const ensureRecorderStopped = async (): Promise<number | null> => {
		if (recorder && !recorderStopped) {
			recorderStopped = true;
			recorderExitCode = await stopRecorder(recorder.child, stopTimeoutMs);
		}
		return recorderExitCode;
	};

	const hooks: DriveHooks = {
		async onWindowReady(windowId) {
			currentStage = "record";
			let source: string | undefined;
			if (windowId === null) {
				console.error(
					"demo: warning: could not find the driven Chrome window id — recording the whole " +
						"screen instead of the window",
				);
			} else {
				source = `window:${windowId}`;
			}
			try {
				recorder = spawnRecorder(
					spawnFn,
					nodeBinPath,
					engineBinPath,
					paths.rawVideo,
					readyTimeoutMs,
					source,
				);
			} catch (error) {
				throw new DemoError("record", messageOf(error));
			}
			try {
				await Promise.race([recorder.ready, signal]);
			} catch (error) {
				throw error instanceof DemoError ? error : new DemoError("record", messageOf(error));
			}
			currentStage = "drive";
		},
		async onDriveFinished() {
			if (recorder) await ensureRecorderStopped();
		},
	};

	try {
		currentStage = "drive";
		let driveResult: RunDriveResult | undefined;
		let driveError: unknown;
		try {
			driveResult = await Promise.race([
				narration === undefined
					? performDrive(stepList, hooks)
					: performDrive(stepList, hooks, narration.timings),
				signal,
			]);
		} catch (error) {
			if (error instanceof DemoError) throw error;
			driveError = error;
		}

		// Always stop the recorder next, whether the driver succeeded or
		// threw — Invariant: "the recorder is always stopped, including when
		// the driver throws." Compose depends on the raw file being fully
		// flushed, so this explicit stop (not just the `finally` below) is
		// what makes that ordering true, in addition to being covered
		// structurally either way.
		const exitCode = await ensureRecorderStopped();
		// The recorder's fate is sealed from here on — a later signal (during
		// compose/process, or after this function returns) needs no special
		// handling, so stop listening for one now rather than leaving a
		// listener that outlives its purpose.
		unregisterSignal();

		if (driveError !== undefined) {
			throw new DemoError("drive", messageOf(driveError));
		}
		if (!recorder) {
			throw new DemoError("record", "the recorder was never started (no driven window reported)");
		}
		if (exitCode !== 0) {
			throw new DemoError("record", `recorder exited with code ${exitCode} while stopping`);
		}
		const drivenResult = driveResult as RunDriveResult;

		const { fragment, warnings } = emitZoomRegions(drivenResult.actionLog, drivenResult.viewport);
		for (const warning of warnings) console.error(`demo: warning: ${warning}`);
		writeFileSync(paths.actionLog, `${JSON.stringify(drivenResult.actionLog, null, 2)}\n`, "utf-8");
		writeFileSync(paths.zoomFragment, `${JSON.stringify(fragment, null, 2)}\n`, "utf-8");

		try {
			const code = await runEngineCommand(spawnFn, nodeBinPath, engineBinPath, [
				"compose",
				"--zooms",
				paths.zoomFragment,
				"--raw",
				paths.rawVideo,
				"--out",
				paths.projectFile,
			]);
			if (code !== 0) throw new Error(`compose exited with code ${code}`);
		} catch (error) {
			throw new DemoError("compose", messageOf(error));
		}

		try {
			const code = await runEngineCommand(spawnFn, nodeBinPath, engineBinPath, [
				"process",
				"--project",
				paths.projectFile,
				"--raw",
				paths.rawVideo,
				"--cursor",
				paths.cursorTelemetry,
				"--out",
				paths.renderedVideo,
			]);
			if (code !== 0) throw new Error(`process exited with code ${code}`);
		} catch (error) {
			throw new DemoError("process", messageOf(error));
		}

		// CR-LENSMITH-A008-6: voice the finished film when narration ran.
		if (narration !== undefined) {
			await runVoiceoverStage(drivenResult.actionLog, opts, paths, {
				spawnFn,
				nodeBinPath,
				engineBinPath,
			});
		}
		const voiced = narration !== undefined;

		// Every file this run actually wrote, per the Invariant — the manifest
		// itself is deliberately not one of its own entries (it cannot record
		// its own final size while still being written).
		const artifactSpecs: Array<{ name: string; path: string; isMedia: boolean }> = [
			{ name: "raw-recording", path: paths.rawVideo, isMedia: true },
			{ name: "cursor-telemetry", path: paths.cursorTelemetry, isMedia: false },
			{ name: "recording-session", path: paths.sessionInfo, isMedia: false },
			{ name: "action-log", path: paths.actionLog, isMedia: false },
			{ name: "zoom-fragment", path: paths.zoomFragment, isMedia: false },
			{ name: "project-file", path: paths.projectFile, isMedia: false },
			...(voiced
				? [
						{ name: "rendered-video", path: paths.voicedVideo, isMedia: true },
						{ name: "rendered-video-silent", path: paths.renderedVideo, isMedia: true },
						{ name: "voice-starts", path: paths.voiceStarts, isMedia: false },
					]
				: [{ name: "rendered-video", path: paths.renderedVideo, isMedia: true }]),
			...(narration?.artifacts ?? []),
		];
		const artifacts: ManifestArtifact[] = artifactSpecs.map((spec) => ({
			name: spec.name,
			path: spec.path,
			sizeBytes: statSync(spec.path).size,
			durationMs: spec.isMedia ? probeDurationMs(spec.path) : null,
		}));

		const manifest: Manifest = {
			generatedAt: new Date().toISOString(),
			stepsPath: opts.stepsPath,
			artifacts,
		};
		writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

		return { manifestPath: paths.manifest, artifacts };
	} finally {
		// The structural guarantee: whatever path got here — normal return, a
		// thrown DemoError from any stage above, an exception this function
		// didn't anticipate — the recorder is stopped before `runDemo` is
		// truly done. A no-op if `ensureRecorderStopped` already ran above.
		unregisterSignal();
		await ensureRecorderStopped();
	}
}

interface NarrateStageResult {
	timings: NarrationTimings;
	artifacts: Array<{ name: string; path: string; isMedia: boolean }>;
}

/**
 * CR-LENSMITH-A008-5: writes `<out>/narration-script.json` from the steps' `say` lines (line id
 * `s<step index>`, the id `drive` looks up), runs the engine's
 * `narrate --script <that> --out <out>/narration --json [--engine] [--voice]`, then reads and
 * validates `<out>/narration/timings.json` against the step list. Returns undefined — and spawns
 * nothing — when no step has `say`. Any failure is a {@link DemoError} for stage "narrate".
 */
async function runNarrateStage(
	stepList: StepList,
	opts: DemoRunOptions,
	paths: DemoPaths,
	engine: { spawnFn: typeof spawn; nodeBinPath: string; engineBinPath: string },
): Promise<NarrateStageResult | undefined> {
	const lines: Array<{ id: string; text: string }> = [];
	stepList.steps.forEach((step, index) => {
		if (step.say !== undefined) lines.push({ id: narrationLineId(index), text: step.say });
	});
	if (lines.length === 0) return undefined;

	try {
		writeFileSync(paths.narrationScript, `${JSON.stringify({ lines }, null, 2)}\n`, "utf-8");
		const args = [
			"narrate",
			"--script",
			paths.narrationScript,
			"--out",
			paths.narrationDir,
			"--json",
		];
		if (opts.narrateEngine !== undefined) args.push("--engine", opts.narrateEngine);
		if (opts.voice !== undefined) args.push("--voice", opts.voice);
		const code = await runEngineCommand(
			engine.spawnFn,
			engine.nodeBinPath,
			engine.engineBinPath,
			args,
		);
		if (code !== 0) throw new Error(`narrate exited with code ${code}`);
		const timings = readNarrationTimings(
			readFileSync(paths.narrationTimings, "utf-8"),
			paths.narrationTimings,
			stepList,
		);
		const artifacts: NarrateStageResult["artifacts"] = [
			{ name: "narration-script", path: paths.narrationScript, isMedia: false },
			{ name: "narration-timings", path: paths.narrationTimings, isMedia: false },
		];
		for (const { id } of lines) {
			const file = timings.lines[id]?.file;
			if (file === undefined) throw new Error(`timings.json line "${id}" names no audio file`);
			artifacts.push({
				name: `narration-audio-${id}`,
				path: path.join(paths.narrationDir, file),
				isMedia: true,
			});
		}
		return { timings, artifacts };
	} catch (error) {
		throw new DemoError("narrate", messageOf(error));
	}
}

/**
 * CR-LENSMITH-A008-6: collects `{voiceLineId: voiceStartMs}` from the action log, converts each to
 * film time with {@link logMsToFilmMs} (the same mapping the zoom regions use), writes
 * `<out>/voice-starts.json` and runs the engine's
 * `voiceover --video final.mp4 --narration narration/timings.json --starts voice-starts.json
 * --out final-voiced.mp4 [--captions]`. Any failure is a {@link DemoError} for stage "voiceover".
 * The engine's own stderr (e.g. ffmpeg built without libass) is inherited and shown live.
 */
async function runVoiceoverStage(
	actionLog: ActionLogEntry[],
	opts: DemoRunOptions,
	paths: DemoPaths,
	engine: { spawnFn: typeof spawn; nodeBinPath: string; engineBinPath: string },
): Promise<void> {
	try {
		const starts: Record<string, number> = {};
		for (const entry of actionLog) {
			if (entry.voiceLineId !== undefined && entry.voiceStartMs !== undefined) {
				starts[entry.voiceLineId] = Math.round(logMsToFilmMs(entry.voiceStartMs));
			}
		}
		if (Object.keys(starts).length === 0) {
			throw new Error("the action log recorded no narration start times");
		}
		writeFileSync(paths.voiceStarts, `${JSON.stringify(starts, null, 2)}\n`, "utf-8");
		const args = [
			"voiceover",
			"--video",
			paths.renderedVideo,
			"--narration",
			paths.narrationTimings,
			"--starts",
			paths.voiceStarts,
			"--out",
			paths.voicedVideo,
		];
		if (opts.captions !== undefined) args.push("--captions", opts.captions);
		const code = await runEngineCommand(
			engine.spawnFn,
			engine.nodeBinPath,
			engine.engineBinPath,
			args,
		);
		if (code !== 0) {
			throw new Error(
				`voiceover exited with code ${code} (burning captions needs an ffmpeg with libass; see the engine's message above, or pass --captions srt|none)`,
			);
		}
	} catch (error) {
		throw new DemoError("voiceover", messageOf(error));
	}
}

const EXCLUSIVE_MACHINE_NOTICE =
	"Recording the screen and driving a real browser with real input events — the machine is " +
	"exclusive for the whole run. Do not touch it.";

/**
 * `runDemo` wraps every failure it can reach into a {@link DemoError} naming
 * the stage before it ever escapes — the fallback branch here is for a
 * genuinely unforeseen error (e.g. the filesystem itself failing), not a
 * recognized failure mode this command already names.
 */
function reportDemoFailure(error: unknown): void {
	if (error instanceof DemoError) {
		console.error(`demo: stage "${error.stage}" failed — ${error.message}`);
		return;
	}
	console.error(`demo: ${messageOf(error)}`);
}

export function registerDemoCommand(program: Command): void {
	program
		.command("demo")
		.description(
			"record, drive, compose and process one clip in a single run: narrate the steps' say lines " +
				"(when any), start the recorder, run " +
				"the driver, stop the recorder, then compose and render — writing a manifest of every " +
				"artifact produced",
		)
		.requiredOption("--steps <path>", "path to the step-list JSON ({ url, steps: [...] })")
		.requiredOption("--out-dir <dir>", "directory to write every artifact and the manifest into")
		.option(
			"--profile-dir <path>",
			"Chrome profile directory — created and reused; never inside this repository, never committed",
			defaultProfileDir(),
		)
		.option(
			"--browser-channel <name>",
			"Chrome channel to launch — never Playwright's bundled Chromium",
			DEFAULT_BROWSER_CHANNEL,
		)
		.option(
			"--voice <name>",
			"narration voice, passed to the engine's `narrate --voice` (default: the engine's, Kokoro am_michael)",
		)
		.option(
			"--engine <name>",
			"narration engine, passed to the engine's `narrate --engine` (kokoro default, or edge)",
		)
		.option(
			"--captions <mode>",
			"captions on the narrated film, passed to the engine's `voiceover --captions`: burn (default), srt or none",
		)
		.addHelpText(
			"after",
			"\nOne-time warm-up: --profile-dir is expected to already be signed in — see " +
				"`lensmith-director drive --help` for the warm-up command a human runs once.",
		)
		.action(
			async (opts: {
				steps: string;
				outDir: string;
				profileDir: string;
				browserChannel: string;
				voice?: string;
				engine?: string;
				captions?: string;
			}) => {
				console.error(EXCLUSIVE_MACHINE_NOTICE);
				if (opts.captions !== undefined && !["burn", "srt", "none"].includes(opts.captions)) {
					console.error(`demo: --captions must be burn, srt or none (got '${opts.captions}')`);
					process.exitCode = 1;
					return;
				}
				try {
					const result = await runDemo({
						stepsPath: opts.steps,
						outDir: opts.outDir,
						profileDir: opts.profileDir,
						browserChannel: opts.browserChannel,
						...(opts.voice !== undefined ? { voice: opts.voice } : {}),
						...(opts.engine !== undefined ? { narrateEngine: opts.engine } : {}),
						...(opts.captions !== undefined
							? { captions: opts.captions as "burn" | "srt" | "none" }
							: {}),
					});
					console.log(
						`demo: wrote ${result.artifacts.length} artifact(s), manifest at ${result.manifestPath}`,
					);
				} catch (error) {
					reportDemoFailure(error);
					process.exitCode = 1;
				}
			},
		);
}
