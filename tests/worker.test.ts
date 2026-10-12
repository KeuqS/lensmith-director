import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimNextJob, ensureJobDirs, runWorkerLoop } from "../src/commands/worker.js";
import { ScreenCaptureUnavailableError } from "../src/lib/screenCapturePreflight.js";

describe("Invariant: the worker adds no new capture, render or driving logic", () => {
	it('never spawns anything other than the "demo" subcommand — no ScreenCaptureKit/Playwright/cursor code, and no reimplemented record/compose/process invocation', () => {
		const source = readFileSync(
			path.join(import.meta.dirname, "..", "src", "commands", "worker.ts"),
			"utf-8",
		);
		for (const forbidden of [
			"chromium",
			"CursorChoreographer",
			"ScreenCaptureKit",
			"spawnRecorder",
			"CGEvent",
		]) {
			expect(source).not.toContain(forbidden);
		}
		// Quoted CLI-subcommand tokens only — NOT a bare-word check, which would
		// also flag legitimate, unrelated uses like `process.exitCode`.
		for (const subcommand of ["record", "compose", "process"]) {
			expect(source).not.toMatch(new RegExp(`["']${subcommand}["']`));
		}
		// The one subcommand string this file is allowed to spawn.
		expect(source).toMatch(/"demo"/);
	});
});

// Mirrors tests/demo.test.ts's own FakeChild: a real child_process exposes
// stdout/stderr Readable streams, EventEmitter-style error/exit events, and
// kill()/exitCode/signalCode — a PassThrough gives that exact interface
// without spawning any real process. Nothing here ever runs the real `demo`
// command or a real `lensmith-screen-capture-preflight` binary.
class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killSignals: string[] = [];
	onKill?: (signal: string) => void;

	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		this.killSignals.push(String(signal));
		this.onKill?.(String(signal));
		return true;
	}

	emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("exit", code, signal);
	}
}

interface SpawnedCommand {
	child: FakeChild;
	args: string[];
}

/** A no-op handler for tests where `spawnFn` must never actually be invoked. */
function noHandler(): void {
	// deliberately empty — asserting `calls` stays empty is the point.
}

function buildSpawnFn(handler: (child: FakeChild, args: string[]) => void): {
	spawnFn: (cmd: string, args: string[]) => FakeChild;
	calls: SpawnedCommand[];
} {
	const calls: SpawnedCommand[] = [];
	const spawnFn = ((_cmd: string, args: string[]) => {
		const child = new FakeChild();
		calls.push({ child, args });
		queueMicrotask(() => handler(child, args));
		return child;
		// biome-ignore lint/suspicious/noExplicitAny: FakeChild deliberately duck-types child_process's shape
	}) as any;
	return { spawnFn, calls };
}

function argAfter(args: string[], flag: string): string {
	const index = args.indexOf(flag);
	if (index === -1 || index + 1 >= args.length) {
		throw new Error(`${flag} not found in ${JSON.stringify(args)}`);
	}
	return args[index + 1] as string;
}

/** Mirrors tests/demo.test.ts's own fakeOnTerminationSignal, renamed for this command's own hook. */
function fakeOnShutdownSignal() {
	const state: { callback?: (signal: NodeJS.Signals) => void } = {};
	const onShutdownSignal = (callback: (signal: NodeJS.Signals) => void) => {
		state.callback = callback;
		return () => {
			state.callback = undefined;
		};
	};
	const trigger = (signal: NodeJS.Signals) => state.callback?.(signal);
	return { onShutdownSignal, trigger };
}

/** Increments by one (virtual) second on every call — lets a test assert cycles occurred in order. */
function fakeClock(startMs = 1_700_000_000_000) {
	let current = startMs;
	return () => {
		const date = new Date(current);
		current += 1000;
		return date;
	};
}

function readJson(filePath: string): unknown {
	return JSON.parse(readFileSync(filePath, "utf-8"));
}

describe("claimNextJob", () => {
	let jobsDir: string;

	beforeEach(() => {
		jobsDir = mkdtempSync(path.join(tmpdir(), "lensmith-director-worker-claim-"));
		ensureJobDirs(jobsDir);
	});

	afterEach(() => {
		rmSync(jobsDir, { recursive: true, force: true });
	});

	it("returns null when the queue is empty", () => {
		expect(claimNextJob(jobsDir)).toBeNull();
	});

	it("claims the earliest job by filename and moves it out of queue/ into running/", () => {
		writeFileSync(path.join(jobsDir, "queue", "b.json"), "{}");
		writeFileSync(path.join(jobsDir, "queue", "a.json"), "{}");

		const claimed = claimNextJob(jobsDir);
		expect(claimed?.id).toBe("a");
		expect(existsSync(path.join(jobsDir, "queue", "a.json"))).toBe(false);
		expect(existsSync(path.join(jobsDir, "running", "a.json"))).toBe(true);
		expect(existsSync(path.join(jobsDir, "queue", "b.json"))).toBe(true);
	});

	it(
		"Invariant: a job file is executed at most once — presenting the same job to two " +
			"consecutive claim attempts, the second finds nothing",
		() => {
			writeFileSync(path.join(jobsDir, "queue", "only.json"), "{}");

			const first = claimNextJob(jobsDir);
			expect(first?.id).toBe("only");

			const second = claimNextJob(jobsDir);
			expect(second).toBeNull();
		},
	);
});

describe("runWorkerLoop", () => {
	let jobsDir: string;
	let outDir: string;

	beforeEach(() => {
		jobsDir = mkdtempSync(path.join(tmpdir(), "lensmith-director-worker-loop-"));
		outDir = mkdtempSync(path.join(tmpdir(), "lensmith-director-worker-out-"));
	});

	afterEach(() => {
		rmSync(jobsDir, { recursive: true, force: true });
		rmSync(outDir, { recursive: true, force: true });
	});

	function writeJob(name: string, spec: { steps: string; outDir: string }): void {
		mkdirSync(path.join(jobsDir, "queue"), { recursive: true });
		writeFileSync(path.join(jobsDir, "queue", name), JSON.stringify(spec));
	}

	it(
		"Invariant: refuses to start when capture is impossible — the preflight throws before " +
			"the loop is entered, no heartbeat is written, and no child is ever spawned",
		async () => {
			const { spawnFn, calls } = buildSpawnFn(noHandler);
			const remedy =
				"No other application's window title is visible to this process. Grant Screen " +
				"Recording, then restart the worker.";

			await expect(
				runWorkerLoop(
					{ jobsDir, pollMs: 10 },
					{
						spawnFn,
						nodeBinPath: "node",
						resolveDirectorCliPath: () => "/fake/dist/cli.js",
						checkCaptureCapability: () => {
							throw new ScreenCaptureUnavailableError(remedy);
						},
					},
				),
			).rejects.toThrow(ScreenCaptureUnavailableError);

			expect(calls).toHaveLength(0);
			expect(existsSync(path.join(jobsDir, "worker.heartbeat.json"))).toBe(false);
		},
	);

	it("invokes demo's own compiled CLI as a child process with --steps and --out-dir from the job", async () => {
		writeJob("job-1.json", { steps: "/tmp/steps.json", outDir });

		const { onShutdownSignal, trigger } = fakeOnShutdownSignal();
		const { spawnFn, calls } = buildSpawnFn((child) => {
			trigger("SIGINT"); // stop the loop right after the one job is claimed and spawned
			child.emitExit(0);
		});

		await runWorkerLoop(
			{ jobsDir, pollMs: 10 },
			{
				spawnFn,
				nodeBinPath: "node",
				resolveDirectorCliPath: () => "/fake/dist/cli.js",
				checkCaptureCapability: () => "capturable",
				onShutdownSignal,
			},
		);

		expect(calls).toHaveLength(1);
		const args = calls[0]?.args ?? [];
		expect(args[0]).toBe("/fake/dist/cli.js");
		expect(args[1]).toBe("demo");
		expect(argAfter(args, "--steps")).toBe("/tmp/steps.json");
		expect(argAfter(args, "--out-dir")).toBe(outDir);
	});

	it("a successful job is moved to done/ with a result naming the artifacts actually produced", async () => {
		const stepsPath = path.join(jobsDir, "steps.json");
		writeFileSync(stepsPath, "{}");
		writeJob("clip-1.json", { steps: stepsPath, outDir });

		const { onShutdownSignal, trigger } = fakeOnShutdownSignal();
		const { spawnFn } = buildSpawnFn((child) => {
			writeFileSync(path.join(outDir, "final.mp4"), "fake video bytes");
			child.stdout.write("demo: wrote 7 artifact(s)\n");
			child.emitExit(0);
			trigger("SIGINT");
		});

		await runWorkerLoop(
			{ jobsDir, pollMs: 10 },
			{
				spawnFn,
				nodeBinPath: "node",
				resolveDirectorCliPath: () => "/fake/dist/cli.js",
				checkCaptureCapability: () => "capturable",
				onShutdownSignal,
			},
		);

		expect(existsSync(path.join(jobsDir, "running", "clip-1.json"))).toBe(false);
		expect(existsSync(path.join(jobsDir, "queue", "clip-1.json"))).toBe(false);
		expect(existsSync(path.join(jobsDir, "done", "clip-1.json"))).toBe(true);

		const result = readJson(path.join(jobsDir, "done", "clip-1.result.json")) as {
			id: string;
			exitCode: number;
			artifacts: string[];
			stderrTail?: string;
		};
		expect(result.id).toBe("clip-1");
		expect(result.exitCode).toBe(0);
		expect(result.stderrTail).toBeUndefined();
		expect(result.artifacts).toEqual([path.resolve(path.join(outDir, "final.mp4"))]);
	});

	it(
		"Invariant: a failed job produces a failed/ result carrying the child's exit code and " +
			"stderr tail — never a success result, and never a silent retry",
		async () => {
			const stepsPath = path.join(jobsDir, "steps.json");
			writeFileSync(stepsPath, "{}");
			writeJob("broken.json", { steps: stepsPath, outDir });

			const { onShutdownSignal, trigger } = fakeOnShutdownSignal();
			const { spawnFn } = buildSpawnFn((child) => {
				child.stderr.write('demo: stage "drive" failed — selector not found\n');
				child.emitExit(1);
				trigger("SIGINT");
			});

			await runWorkerLoop(
				{ jobsDir, pollMs: 10 },
				{
					spawnFn,
					nodeBinPath: "node",
					resolveDirectorCliPath: () => "/fake/dist/cli.js",
					checkCaptureCapability: () => "capturable",
					onShutdownSignal,
				},
			);

			expect(existsSync(path.join(jobsDir, "done", "broken.json"))).toBe(false);
			expect(existsSync(path.join(jobsDir, "failed", "broken.json"))).toBe(true);

			const result = readJson(path.join(jobsDir, "failed", "broken.result.json")) as {
				exitCode: number;
				stderrTail: string;
			};
			expect(result.exitCode).toBe(1);
			expect(result.stderrTail).toContain("selector not found");
		},
	);

	it(
		"a malformed job is moved straight to failed/ naming the offending field, without ever " +
			"spawning demo, and the worker keeps running and heartbeating",
		async () => {
			mkdirSync(path.join(jobsDir, "queue"), { recursive: true });
			writeFileSync(path.join(jobsDir, "queue", "bad.json"), JSON.stringify({ outDir }));

			const { onShutdownSignal, trigger } = fakeOnShutdownSignal();
			let cycles = 0;
			const { spawnFn, calls } = buildSpawnFn(noHandler);

			await runWorkerLoop(
				{ jobsDir, pollMs: 10 },
				{
					spawnFn,
					nodeBinPath: "node",
					resolveDirectorCliPath: () => "/fake/dist/cli.js",
					checkCaptureCapability: () => "capturable",
					onShutdownSignal,
					sleep: async () => {
						cycles += 1;
						if (cycles >= 2) trigger("SIGINT");
					},
				},
			);

			expect(calls).toHaveLength(0); // never spawned demo for the malformed job
			expect(existsSync(path.join(jobsDir, "failed", "bad.json"))).toBe(true);
			const result = readJson(path.join(jobsDir, "failed", "bad.result.json")) as {
				stderrTail: string;
			};
			expect(result.stderrTail).toContain("steps");

			// Still alive and still heartbeating after the bad job, through at
			// least one more idle poll cycle before shutdown.
			expect(cycles).toBeGreaterThanOrEqual(2);
			expect(existsSync(path.join(jobsDir, "worker.heartbeat.json"))).toBe(true);
		},
	);

	it("Invariant: the heartbeat file's timestamp advances on every cycle, including cycles that found no work", async () => {
		const { onShutdownSignal, trigger } = fakeOnShutdownSignal();
		const { spawnFn } = buildSpawnFn(noHandler);
		const now = fakeClock();
		let sleepCalls = 0;

		await runWorkerLoop(
			{ jobsDir, pollMs: 10 },
			{
				spawnFn,
				nodeBinPath: "node",
				resolveDirectorCliPath: () => "/fake/dist/cli.js",
				checkCaptureCapability: () => "capturable",
				onShutdownSignal,
				now,
				sleep: async () => {
					sleepCalls += 1;
					if (sleepCalls >= 3) trigger("SIGINT");
				},
			},
		);

		expect(sleepCalls).toBe(3);
		const heartbeat = readJson(path.join(jobsDir, "worker.heartbeat.json")) as {
			timestamp: string;
			jobInFlight: string | null;
		};
		// `now()` is called once per idle cycle for the heartbeat and nowhere
		// else on the idle path, so the LAST heartbeat write used the 3rd
		// value the fake clock produced.
		expect(heartbeat.jobInFlight).toBeNull();
		expect(new Date(heartbeat.timestamp).getTime()).toBeGreaterThan(1_700_000_000_000);
	});

	it("two jobs dropped at once are executed one after the other, never concurrently", async () => {
		const stepsPath = path.join(jobsDir, "steps.json");
		writeFileSync(stepsPath, "{}");
		writeJob("job-a.json", { steps: stepsPath, outDir: path.join(outDir, "a") });
		writeJob("job-b.json", { steps: stepsPath, outDir: path.join(outDir, "b") });
		mkdirSync(path.join(outDir, "a"), { recursive: true });
		mkdirSync(path.join(outDir, "b"), { recursive: true });

		const { onShutdownSignal, trigger } = fakeOnShutdownSignal();
		const order: string[] = [];
		let spawnCount = 0;
		const { spawnFn, calls } = buildSpawnFn((child, args) => {
			spawnCount += 1;
			const jobOutDir = argAfter(args, "--out-dir");
			order.push(`start:${jobOutDir}`);
			child.emitExit(0);
			order.push(`end:${jobOutDir}`);
			if (spawnCount === 2) trigger("SIGINT");
		});

		await runWorkerLoop(
			{ jobsDir, pollMs: 10 },
			{
				spawnFn,
				nodeBinPath: "node",
				resolveDirectorCliPath: () => "/fake/dist/cli.js",
				checkCaptureCapability: () => "capturable",
				onShutdownSignal,
			},
		);

		expect(calls).toHaveLength(2);
		// Each job's start/end pair is adjacent — never interleaved with the
		// other job's start, which is what "never concurrently" means here.
		expect(order).toEqual([
			`start:${path.join(outDir, "a")}`,
			`end:${path.join(outDir, "a")}`,
			`start:${path.join(outDir, "b")}`,
			`end:${path.join(outDir, "b")}`,
		]);
	});

	it(
		"Invariant: an ordinary stop strands no job — SIGINT during a run leaves running/ empty " +
			"and the job back in queue/, and the worker exits without writing a done/failed result",
		async () => {
			const stepsPath = path.join(jobsDir, "steps.json");
			writeFileSync(stepsPath, "{}");
			writeJob("mid-flight.json", { steps: stepsPath, outDir });

			const { onShutdownSignal, trigger } = fakeOnShutdownSignal();
			let recordChild: FakeChild | undefined;
			const { spawnFn } = buildSpawnFn((child) => {
				recordChild = child;
				// Never exits on its own — models a real demo run still in
				// progress when the signal arrives. Exits only once killed.
				child.onKill = () => child.emitExit(0, "SIGINT");
			});

			const runPromise = runWorkerLoop(
				{ jobsDir, pollMs: 10 },
				{
					spawnFn,
					nodeBinPath: "node",
					resolveDirectorCliPath: () => "/fake/dist/cli.js",
					checkCaptureCapability: () => "capturable",
					onShutdownSignal,
				},
			);

			// Let the fake spawn's queued handler register the child first.
			await Promise.resolve();
			await Promise.resolve();
			trigger("SIGINT");

			await runPromise; // must resolve cleanly (exit code 0), never throw

			expect(recordChild?.killSignals).toContain("SIGINT");
			expect(readdirSync(path.join(jobsDir, "running"))).toHaveLength(0);
			expect(existsSync(path.join(jobsDir, "queue", "mid-flight.json"))).toBe(true);
			expect(existsSync(path.join(jobsDir, "done", "mid-flight.json"))).toBe(false);
			expect(existsSync(path.join(jobsDir, "failed", "mid-flight.json"))).toBe(false);
			expect(existsSync(path.join(jobsDir, "done", "mid-flight.result.json"))).toBe(false);
			expect(existsSync(path.join(jobsDir, "failed", "mid-flight.result.json"))).toBe(false);
		},
	);

	it("SIGINT while idle (no job in flight) exits cleanly with nothing to requeue", async () => {
		const { onShutdownSignal, trigger } = fakeOnShutdownSignal();
		const { spawnFn, calls } = buildSpawnFn(noHandler);

		await runWorkerLoop(
			{ jobsDir, pollMs: 10 },
			{
				spawnFn,
				nodeBinPath: "node",
				resolveDirectorCliPath: () => "/fake/dist/cli.js",
				checkCaptureCapability: () => "capturable",
				onShutdownSignal,
				sleep: async () => {
					trigger("SIGINT");
				},
			},
		);

		expect(calls).toHaveLength(0);
	});
});
