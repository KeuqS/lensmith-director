#!/usr/bin/env node
// Builds every native macOS helper into bin/ (gitignored — CI and operators
// build it fresh; see README.md "Development").
//
// Plain `swiftc -O` on a single file per helper, deliberately: neither helper
// has dependencies beyond CoreGraphics and Foundation, so a SwiftPM package
// would add a manifest, a .build/ tree and a search-for-the-product step to
// buy nothing. Command Line Tools are enough — full Xcode is not required.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const binDir = path.join(root, "bin");

const HELPERS = [
	{
		name: "lensmith-cursor-choreographer",
		source: path.join(root, "src", "native", "cursor-choreographer", "main.swift"),
	},
	{
		name: "lensmith-screen-capture-preflight",
		source: path.join(root, "src", "native", "screen-capture-preflight", "main.swift"),
	},
];

if (process.platform !== "darwin") {
	// Not an error: the TypeScript side builds and tests on any platform, and CI
	// runs the whole gate on macOS. Only the native-backed commands need these.
	console.log("Skipping native macOS helper build: host platform is not macOS.");
	process.exit(0);
}

const swiftcVersion = spawnSync("swiftc", ["--version"], { cwd: root, encoding: "utf8" });
if (swiftcVersion.status !== 0) {
	const message = `${swiftcVersion.stderr ?? ""}${swiftcVersion.stdout ?? ""}`.trim();
	console.error(
		[
			"Unable to build the native macOS helpers: no working Swift compiler was found.",
			"",
			message,
			"",
			"Install Apple's Command Line Tools, then run this again:",
			"  xcode-select --install",
		].join("\n"),
	);
	process.exit(1);
}

fs.mkdirSync(binDir, { recursive: true });

for (const helper of HELPERS) {
	if (!fs.existsSync(helper.source)) {
		console.error(`Source file not found: ${helper.source}`);
		process.exit(1);
	}

	const dest = path.join(binDir, helper.name);
	console.log(`Building ${helper.name}...`);
	const result = spawnSync("swiftc", ["-O", "-o", dest, helper.source], {
		cwd: root,
		stdio: "inherit",
	});
	if (result.error) {
		console.error(`Failed to start swiftc: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}

	fs.chmodSync(dest, 0o755);
	console.log(`Built ${helper.name} -> bin/${helper.name}`);
}
