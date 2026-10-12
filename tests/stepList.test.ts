import { describe, expect, it } from "vitest";
import { readStepList, StepListError, validateStepList } from "../src/lib/stepList.js";

describe("validateStepList", () => {
	it("accepts a well-formed step list", () => {
		const result = validateStepList({
			url: "http://localhost:4173/page.html",
			steps: [
				{ type: "click", selector: "#a", label: "click a" },
				{ type: "wait", ms: 500 },
				{ type: "click", selector: "#b" },
			],
		});
		expect(result.url).toBe("http://localhost:4173/page.html");
		expect(result.steps).toHaveLength(3);
		expect(result.steps[0]).toEqual({ type: "click", selector: "#a", label: "click a" });
		expect(result.steps[1]).toEqual({ type: "wait", ms: 500 });
		// no "label" key at all when omitted — not `label: undefined`
		expect(result.steps[2]).toEqual({ type: "click", selector: "#b" });
		expect(Object.hasOwn(result.steps[2] as object, "label")).toBe(false);
	});

	// CR-LENSMITH-A002-6 — the `type` step.
	describe("type step", () => {
		it("accepts a well-formed type step, with and without a label", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [
					{ type: "type", selector: "#field", text: "hello", label: "type a greeting" },
					{ type: "type", selector: "#other", text: "" },
				],
			});
			expect(result.steps[0]).toEqual({
				type: "type",
				selector: "#field",
				text: "hello",
				label: "type a greeting",
			});
			expect(result.steps[1]).toEqual({ type: "type", selector: "#other", text: "" });
			expect(Object.hasOwn(result.steps[1] as object, "label")).toBe(false);
		});

		it("names the offending step's index for a missing or empty selector", () => {
			expect(() =>
				validateStepList({ url: "http://x", steps: [{ type: "type", text: "hi" }] }),
			).toThrow(/index 0.*selector/);
			expect(() =>
				validateStepList({
					url: "http://x",
					steps: [{ type: "type", selector: "", text: "hi" }],
				}),
			).toThrow(/index 0.*selector/);
		});

		it("names the offending step's index for a missing text", () => {
			expect(() =>
				validateStepList({ url: "http://x", steps: [{ type: "type", selector: "#a" }] }),
			).toThrow(/index 0.*text/);
			expect(() =>
				validateStepList({
					url: "http://x",
					steps: [{ type: "type", selector: "#a", text: 42 }],
				}),
			).toThrow(/index 0.*text/);
		});

		it("names the offending step's index for a non-string label", () => {
			expect(() =>
				validateStepList({
					url: "http://x",
					steps: [{ type: "type", selector: "#a", text: "hi", label: 42 }],
				}),
			).toThrow(/index 0.*label/);
		});

		// CR-LENSMITH-A002-10 — `textFrom.keychain`, the alternative to a literal `text`.
		describe("textFrom (CR-LENSMITH-A002-10)", () => {
			it("accepts a well-formed textFrom step, with and without a label", () => {
				const result = validateStepList({
					url: "http://x",
					steps: [
						{
							type: "type",
							selector: "#code",
							textFrom: { keychain: { service: "svc", account: "acct" } },
							label: "type the code",
						},
					],
				});
				expect(result.steps[0]).toEqual({
					type: "type",
					selector: "#code",
					textFrom: { keychain: { service: "svc", account: "acct" } },
					label: "type the code",
				});
			});

			it("rejects a step with both text and textFrom, naming the step index", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [
							{
								type: "type",
								selector: "#a",
								text: "hi",
								textFrom: { keychain: { service: "svc", account: "acct" } },
							},
						],
					}),
				).toThrow(/index 0.*exactly one.*"text".*"textFrom"/);
			});

			it("rejects a step with neither text nor textFrom, naming the step index", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a" }],
					}),
				).toThrow(/index 0.*exactly one.*"text".*"textFrom"/);
			});

			it("rejects a non-object textFrom", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", textFrom: "svc/acct" }],
					}),
				).toThrow(/index 0.*"textFrom"/);
			});

			it("rejects a textFrom missing the keychain object", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", textFrom: {} }],
					}),
				).toThrow(/index 0.*keychain/);
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", textFrom: { keychain: "svc/acct" } }],
					}),
				).toThrow(/index 0.*keychain/);
			});

			it("rejects a missing or empty service", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", textFrom: { keychain: { account: "acct" } } }],
					}),
				).toThrow(/index 0.*"service"/);
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [
							{
								type: "type",
								selector: "#a",
								textFrom: { keychain: { service: "", account: "acct" } },
							},
						],
					}),
				).toThrow(/index 0.*"service"/);
			});

			it("rejects a missing or empty account", () => {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", textFrom: { keychain: { service: "svc" } } }],
					}),
				).toThrow(/index 0.*"account"/);
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [
							{
								type: "type",
								selector: "#a",
								textFrom: { keychain: { service: "svc", account: "" } },
							},
						],
					}),
				).toThrow(/index 0.*"account"/);
			});

			it("passes a service value containing shell metacharacters through unmodified — validation never executes anything", () => {
				const dangerous = "svc-$(touch /tmp/pwned)-`echo hi`";
				const result = validateStepList({
					url: "http://x",
					steps: [
						{
							type: "type",
							selector: "#a",
							textFrom: { keychain: { service: dangerous, account: "acct" } },
						},
					],
				});
				const step = result.steps[0] as { textFrom: { keychain: { service: string } } };
				expect(step.textFrom.keychain.service).toBe(dangerous);
			});
		});
	});

	it("rejects a non-object top level", () => {
		expect(() => validateStepList(null)).toThrow(StepListError);
		expect(() => validateStepList([1, 2])).toThrow(StepListError);
		expect(() => validateStepList("nope")).toThrow(StepListError);
	});

	it("rejects a missing or empty url", () => {
		expect(() => validateStepList({ steps: [{ type: "wait", ms: 1 }] })).toThrow(/"url"/);
		expect(() => validateStepList({ url: "", steps: [{ type: "wait", ms: 1 }] })).toThrow(/"url"/);
		expect(() => validateStepList({ url: 123, steps: [{ type: "wait", ms: 1 }] })).toThrow(/"url"/);
	});

	it("rejects a missing, empty, or non-array steps", () => {
		expect(() => validateStepList({ url: "http://x" })).toThrow(/"steps"/);
		expect(() => validateStepList({ url: "http://x", steps: [] })).toThrow(/"steps"/);
		expect(() => validateStepList({ url: "http://x", steps: "nope" })).toThrow(/"steps"/);
	});

	it("names the offending step's index for an unknown type", () => {
		expect(() =>
			validateStepList({
				url: "http://x",
				steps: [{ type: "wait", ms: 1 }, { type: "scroll" }],
			}),
		).toThrow(/index 1/);
	});

	it("names the offending step's index for a malformed click step", () => {
		expect(() => validateStepList({ url: "http://x", steps: [{ type: "click" }] })).toThrow(
			/index 0.*selector/,
		);
		expect(() =>
			validateStepList({ url: "http://x", steps: [{ type: "click", selector: "" }] }),
		).toThrow(/index 0.*selector/);
		expect(() =>
			validateStepList({
				url: "http://x",
				steps: [{ type: "click", selector: "#a", label: 42 }],
			}),
		).toThrow(/index 0.*label/);
	});

	it("names the offending step's index for a malformed wait step", () => {
		expect(() => validateStepList({ url: "http://x", steps: [{ type: "wait" }] })).toThrow(
			/index 0.*ms/,
		);
		expect(() => validateStepList({ url: "http://x", steps: [{ type: "wait", ms: 0 }] })).toThrow(
			/index 0.*ms/,
		);
		expect(() => validateStepList({ url: "http://x", steps: [{ type: "wait", ms: -5 }] })).toThrow(
			/index 0.*ms/,
		);
	});

	it("rejects a step that isn't an object", () => {
		expect(() => validateStepList({ url: "http://x", steps: [null] })).toThrow(/index 0/);
		expect(() => validateStepList({ url: "http://x", steps: ["click"] })).toThrow(/index 0/);
	});

	// CR-LENSMITH-A002-13 (BF-8) — the per-step `timeoutMs` override on `click`
	// and `type` steps, validated exactly like `wait`'s `ms` above.
	describe("timeoutMs (CR-LENSMITH-A002-13)", () => {
		it("is omitted entirely from a click step when not present (same discipline as an omitted label)", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [{ type: "click", selector: "#a" }],
			});
			expect(Object.hasOwn(result.steps[0] as object, "timeoutMs")).toBe(false);
		});

		it("accepts a positive finite number on a click step and carries it through unchanged", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [{ type: "click", selector: "#a", timeoutMs: 2000 }],
			});
			expect(result.steps[0]).toEqual({ type: "click", selector: "#a", timeoutMs: 2000 });
		});

		it("rejects zero, negative, non-finite, and non-numeric timeoutMs on a click step, naming the step index", () => {
			for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "fast", null, true]) {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "click", selector: "#a", timeoutMs: bad }],
					}),
				).toThrow(/index 0.*timeoutMs/);
			}
		});

		it("accepts a positive finite number on a literal-text type step and carries it through unchanged", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [{ type: "type", selector: "#a", text: "hi", timeoutMs: 2000 }],
			});
			expect(result.steps[0]).toEqual({
				type: "type",
				selector: "#a",
				text: "hi",
				timeoutMs: 2000,
			});
		});

		it("accepts a positive finite number on a textFrom type step and carries it through unchanged", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [
					{
						type: "type",
						selector: "#a",
						textFrom: { keychain: { service: "svc", account: "acct" } },
						timeoutMs: 2000,
					},
				],
			});
			expect(result.steps[0]).toEqual({
				type: "type",
				selector: "#a",
				textFrom: { keychain: { service: "svc", account: "acct" } },
				timeoutMs: 2000,
			});
		});

		it("rejects zero, negative, non-finite, and non-numeric timeoutMs on a type step, naming the step index", () => {
			for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "fast", null, true]) {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "type", selector: "#a", text: "hi", timeoutMs: bad }],
					}),
				).toThrow(/index 0.*timeoutMs/);
			}
		});
	});

	// [[CR-LENSMITH-A002-4]] fix round, item 5 — the window-width precondition.
	describe("minViewportWidth", () => {
		it("is omitted entirely from the result when not present in the input (same discipline as an omitted click label)", () => {
			const result = validateStepList({ url: "http://x", steps: [{ type: "wait", ms: 1 }] });
			expect(Object.hasOwn(result, "minViewportWidth")).toBe(false);
		});

		it("accepts a positive finite number and carries it through unchanged", () => {
			const result = validateStepList({
				url: "http://x",
				steps: [{ type: "wait", ms: 1 }],
				minViewportWidth: 1024,
			});
			expect(result.minViewportWidth).toBe(1024);
		});

		it("rejects zero, negative, non-finite, and non-numeric values, naming the field", () => {
			for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1024", null, true]) {
				expect(() =>
					validateStepList({
						url: "http://x",
						steps: [{ type: "wait", ms: 1 }],
						minViewportWidth: bad,
					}),
				).toThrow(/"minViewportWidth"/);
			}
		});
	});
});

describe("readStepList", () => {
	it("parses and validates valid JSON", () => {
		const result = readStepList(
			JSON.stringify({ url: "http://x", steps: [{ type: "wait", ms: 10 }] }),
			"steps.json",
		);
		expect(result.steps).toEqual([{ type: "wait", ms: 10 }]);
	});

	it("rejects invalid JSON, naming the source path", () => {
		expect(() => readStepList("{not json", "steps.json")).toThrow(StepListError);
		expect(() => readStepList("{not json", "steps.json")).toThrow(/steps\.json/);
	});
});

describe("validateStepList: say (CR-LENSMITH-A008-2)", () => {
	const url = "http://localhost:4173/page.html";

	it("keeps a say line on click, type and wait steps", () => {
		const result = validateStepList({
			url,
			steps: [
				{ type: "click", selector: "#a", say: "Open the [[story]] Buildr story" },
				{ type: "type", selector: "#f", text: "x", say: "Type it" },
				{ type: "wait", ms: 500, say: "A [[pause_1]] pause" },
			],
		});
		expect(result.steps.map((s) => s.say)).toEqual([
			"Open the [[story]] Buildr story",
			"Type it",
			"A [[pause_1]] pause",
		]);
	});

	it("leaves say absent when not given", () => {
		const result = validateStepList({ url, steps: [{ type: "click", selector: "#a" }] });
		expect("say" in (result.steps[0] ?? {})).toBe(false);
	});

	it("rejects a non-string or empty say", () => {
		expect(() =>
			validateStepList({ url, steps: [{ type: "click", selector: "#a", say: 3 }] }),
		).toThrow(/step at index 0 \(type "click"\) has a non-string or empty "say"/);
		expect(() => validateStepList({ url, steps: [{ type: "wait", ms: 5, say: "  " }] })).toThrow(
			StepListError,
		);
	});

	it("rejects more than one mark", () => {
		expect(() =>
			validateStepList({ url, steps: [{ type: "click", selector: "#a", say: "[[a]] and [[b]]" }] }),
		).toThrow(/2 \[\[mark\]\] tags/);
	});

	it("accepts the engine's mark names: letters, digits and underscore", () => {
		for (const good of ["[[Story]]", "[[pause_1]]", "[[s2]]"]) {
			expect(() =>
				validateStepList({
					url,
					steps: [{ type: "click", selector: "#a", say: `go ${good} now` }],
				}),
			).not.toThrow();
		}
	});

	it("rejects a mark name outside the engine's \\w+ rule (a hyphen included)", () => {
		for (const bad of ["[[pause-1]]", "[[two words]]", "[[]]", "[[a.b]]"]) {
			expect(() =>
				validateStepList({
					url,
					steps: [{ type: "type", selector: "#f", text: "x", say: `go ${bad} now` }],
				}),
			).toThrow(/invalid \[\[mark\]\] name/);
		}
	});
});
