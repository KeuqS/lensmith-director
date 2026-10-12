#!/usr/bin/env node
import { Command } from "commander";
import { registerCursorCommand } from "./commands/cursor.js";
import { registerDemoCommand } from "./commands/demo.js";
import { registerDriveCommand } from "./commands/drive.js";
import { registerWorkerCommand } from "./commands/worker.js";

// Keep in sync with package.json "version" — there is deliberately no runtime
// package.json read, to avoid ESM JSON-import behaviour drifting across Node
// releases for something this small.
export const LENSMITH_DIRECTOR_VERSION = "0.1.0";

export function buildProgram(): Command {
	const program = new Command();

	program
		.name("lensmith-director")
		.description("Lensmith Director — drives a running app and directs a demo recording.")
		.version(LENSMITH_DIRECTOR_VERSION, "-v, --version", "output the current version");

	registerCursorCommand(program);
	registerDriveCommand(program);
	registerDemoCommand(program);
	registerWorkerCommand(program);

	return program;
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;

if (isMainModule) {
	buildProgram().parse(process.argv);
}
