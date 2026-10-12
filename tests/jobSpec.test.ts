import { describe, expect, it } from "vitest";
import { JobSpecError, readJobSpec, validateJobSpec } from "../src/lib/jobSpec.js";

describe("validateJobSpec", () => {
	it("accepts a job shaped exactly like demo's own argument set", () => {
		const spec = validateJobSpec({ steps: "/tmp/steps.json", outDir: "/tmp/out" });
		expect(spec).toEqual({ steps: "/tmp/steps.json", outDir: "/tmp/out" });
	});

	it("rejects a non-object", () => {
		expect(() => validateJobSpec("not an object")).toThrow(JobSpecError);
		expect(() => validateJobSpec(null)).toThrow(JobSpecError);
		expect(() => validateJobSpec([1, 2])).toThrow(JobSpecError);
	});

	it('names "steps" when missing or empty', () => {
		expect(() => validateJobSpec({ outDir: "/tmp/out" })).toThrow(/steps/);
		try {
			validateJobSpec({ steps: "", outDir: "/tmp/out" });
			throw new Error("expected to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(JobSpecError);
			expect((error as JobSpecError).field).toBe("steps");
		}
	});

	it('names "outDir" when missing or empty', () => {
		try {
			validateJobSpec({ steps: "/tmp/steps.json", outDir: 42 });
			throw new Error("expected to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(JobSpecError);
			expect((error as JobSpecError).field).toBe("outDir");
		}
	});
});

describe("readJobSpec", () => {
	it("parses valid JSON into a JobSpec", () => {
		const spec = readJobSpec(JSON.stringify({ steps: "a.json", outDir: "/tmp/x" }));
		expect(spec).toEqual({ steps: "a.json", outDir: "/tmp/x" });
	});

	it("names the JSON parse failure, not a generic error", () => {
		expect(() => readJobSpec("{not valid json")).toThrow(JobSpecError);
		try {
			readJobSpec("{not valid json");
		} catch (error) {
			expect((error as Error).message).toContain("not valid JSON");
		}
	});
});
