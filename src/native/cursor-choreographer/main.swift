import ApplicationServices
import CoreGraphics
import Foundation

// lensmith-cursor-choreographer — moves the REAL macOS cursor and synthesises
// REAL mouse clicks.
//
// This binary is deliberately not covert. It exists so a demo recording shows a
// cursor actually travelling across the screen and pressing things: a screen
// recorder captures the OS cursor, and nothing that only talks to a browser's
// input pipeline (CDP / Playwright `page.mouse`) moves it. See README.md for the
// permission story and the operating constraints.
//
// ---------------------------------------------------------------------------
// Mechanism (measured, not assumed — see README.md "Why it works this way")
// ---------------------------------------------------------------------------
//
// 1. Motion is posted as a stream of `.mouseMoved` CGEvents to `.cghidEventTap`.
//    `CGWarpMouseCursorPosition` is NOT used and must never be: it relocates the
//    cursor WITHOUT generating events, which reads as a teleport on video and
//    leaves the application underneath with no `:hover` state — the two things a
//    demo recording is entirely made of.
//
// 2. Coordinate space is top-left origin, in POINTS, and points == CSS pixels
//    here. `devicePixelRatio` must NOT be applied. It was 2 on the Retina display
//    this was measured on, and multiplying by it would have put every aim at
//    double the intended offset. Display bounds are signed and continuous across
//    a multi-display desktop (a second display can legitimately sit at a negative
//    origin such as (-1878, -1050)), so negative coordinates are valid input and
//    are never clamped.
//
// 3. Posting an event is cheap: p50 ~7µs, p95 ~14-18µs, so a 120 Hz easing loop
//    costs nothing. BUT the FIRST post in a fresh process costs 31-36 ms. That
//    one-off cost lands as a visible stutter at the start of the first move, so
//    this helper is built to be a long-lived process (`serve`) and warms itself
//    with a no-op post to the cursor's CURRENT location before the first real
//    motion.
//
// 4. Clicks set `mouseEventClickState = 1` on both the down and the up event.
//    Without it, repeated clicks at the same spot get coalesced into double- and
//    triple-clicks by the receiving application.
//
// 5. Events land on whatever window is under the cursor at OS level. The caller
//    must bring its target to the front, and the machine is exclusive for the
//    duration of a run — a notification banner or a Spaces switch will eat a
//    click.
//
// 6. Without Accessibility permission, `CGEventPost` silently no-ops: no
//    exception, no non-zero exit, no stderr line — measured directly, not
//    assumed ([[BF-2]], 2026-08-13). `move`/`click`/`warm` therefore preflight
//    `AXIsProcessTrusted()` once per invocation before posting anything, and
//    fail loudly, by name, instead of letting a caller trust a success reply
//    that describes an event the OS silently dropped ([[CR-LENSMITH-A002-3]]).
//    `position` is unaffected — it posts no event, so it is safe regardless of
//    trust status.

// MARK: - Constants

/// Default move duration. Deliberately well inside the recipe documented in
/// README.md: an eased move of <= 700 ms, then a dwell before the click. Slower,
/// prettier moves measurably produce WORSE downstream results.
let defaultMoveDurationMs = 500

/// Easing sample rate. 120 Hz is free at ~7µs/event and matches high-refresh
/// displays; anything lower starts to read as steppy on a 60 fps recording.
let stepRateHz = 120.0

/// Press duration between the down and up event of a click. Long enough to be an
/// unambiguous click, short enough that it never reads as a press-and-hold.
let clickPressSeconds = 0.012

// MARK: - Output

func emit(_ fields: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
		let line = String(data: data, encoding: .utf8)
	else {
		return
	}
	print(line)
	fflush(stdout)
}

func emitError(_ cmd: String, _ message: String) {
	emit(["type": "error", "cmd": cmd, "message": message])
}

// MARK: - Primitives

/// Reads the current cursor position. READ-ONLY: posts nothing, so it is safe to
/// call at any time, including while a human is using the machine.
func currentLocation() -> CGPoint? {
	guard let event = CGEvent(source: nil) else { return nil }
	return event.location
}

@discardableResult
func postMouseMoved(to point: CGPoint) -> Bool {
	guard
		let event = CGEvent(
			mouseEventSource: nil,
			mouseType: .mouseMoved,
			mouseCursorPosition: point,
			mouseButton: .left
		)
	else {
		return false
	}
	event.post(tap: .cghidEventTap)
	return true
}

var isWarm = false

/// Absorbs the 31-36 ms first-post cost by posting a no-op move to the location
/// the cursor is ALREADY at. Nothing moves; the next real move starts instantly
/// instead of opening with a stutter.
@discardableResult
func warmUp() -> Bool {
	if isWarm { return true }
	guard let here = currentLocation() else { return false }
	guard postMouseMoved(to: here) else { return false }
	isWarm = true
	return true
}

func easeInOutCubic(_ t: Double) -> Double {
	t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
}

/// Eased move to `target`. Returns the number of events posted and the elapsed
/// wall time, so the caller can assert the motion actually happened rather than
/// trusting an exit code.
func easedMove(to target: CGPoint, durationMs: Int) -> (steps: Int, elapsedMs: Double, from: CGPoint, to: CGPoint)? {
	warmUp()
	guard let start = currentLocation() else { return nil }

	let durationSeconds = Double(durationMs) / 1000.0
	let steps = max(2, Int((durationSeconds * stepRateHz).rounded()))
	let began = Date()

	for step in 1...steps {
		let t = Double(step) / Double(steps)
		let eased = easeInOutCubic(t)
		let point = CGPoint(
			x: start.x + (target.x - start.x) * eased,
			y: start.y + (target.y - start.y) * eased
		)
		postMouseMoved(to: point)

		// Schedule against the absolute start time rather than sleeping a fixed
		// slice per step, so per-event jitter cannot accumulate into a move that
		// overruns its duration budget.
		let due = began.addingTimeInterval(durationSeconds * t)
		let remaining = due.timeIntervalSinceNow
		if remaining > 0 {
			Thread.sleep(forTimeInterval: remaining)
		}
	}

	let landed = currentLocation() ?? target
	return (steps, Date().timeIntervalSince(began) * 1000.0, start, landed)
}

func postClick(at point: CGPoint) -> Bool {
	guard
		let down = CGEvent(
			mouseEventSource: nil,
			mouseType: .leftMouseDown,
			mouseCursorPosition: point,
			mouseButton: .left
		),
		let up = CGEvent(
			mouseEventSource: nil,
			mouseType: .leftMouseUp,
			mouseCursorPosition: point,
			mouseButton: .left
		)
	else {
		return false
	}
	// Both events, not just the down: without an explicit click state the
	// receiving app coalesces successive clicks at one spot into a double-click.
	down.setIntegerValueField(.mouseEventClickState, value: 1)
	up.setIntegerValueField(.mouseEventClickState, value: 1)

	down.post(tap: .cghidEventTap)
	Thread.sleep(forTimeInterval: clickPressSeconds)
	up.post(tap: .cghidEventTap)
	return true
}

// MARK: - Accessibility preflight

// [[BF-2]]: with Accessibility ungranted, `CGEventPost` silently no-ops — no
// exception, no non-zero exit, no stderr line — and everything downstream
// (this helper's own success replies, `cursorChoreographer.ts`, `drive`'s
// action log) proceeded as though the event had landed. This preflight is
// what makes that failure loud instead of silent, per
// [[CR-LENSMITH-A002-3]] Technical Spec item 3.

/// Injectable seam ([[CR-LENSMITH-A002-3]] Technical Spec item 4): a function
/// reference so the real `AXIsProcessTrusted()` call is isolated to one
/// place. There is no Swift test target in this single-file `swiftc -O`
/// binary (see `README.md` "Development") to override this in — the logic
/// path this preflight drives (untrusted -> loud, specific failure, no move
/// attempted) is instead covered on the TypeScript side, against a FAKE
/// helper, via `CursorChoreographer`'s own `isTrusted` option
/// (`cursorChoreographer.ts`). RN-040 §5c already established that revoking
/// a live grant mid-session to test the REAL API call itself is not safely
/// doable, so that one call stays unverified by CI — this seam exists so the
/// rest of the mechanism does not have to be.
var isProcessTrusted: () -> Bool = { AXIsProcessTrusted() }

/// Cached once per process ("runs once per invocation, not per-move" —
/// Technical Spec item 3): `serve` handles many commands over one long-lived
/// process, and re-querying `AXIsProcessTrusted()` before every single move
/// would be correct but wasteful. A one-shot invocation (`move`/`click`
/// directly from argv) is trivially "once" regardless, since the process
/// exits after one command.
var accessibilityTrustChecked = false
var accessibilityTrusted = false

/// Fails loudly, once, before ANY move/click/warm event is posted — the
/// silent no-op BF-2 measured happened precisely because nothing checked
/// this first. Read-only `position` is deliberately NOT gated: it posts no
/// event, so it stays safe to call regardless of trust status (same rule
/// this repo already applies everywhere else — see `CLAUDE.md`).
@discardableResult
func ensureAccessibilityTrusted(cmd: String) -> Bool {
	if !accessibilityTrustChecked {
		accessibilityTrusted = isProcessTrusted()
		accessibilityTrustChecked = true
	}
	if !accessibilityTrusted {
		emitError(
			cmd,
			"Accessibility permission is not granted to this helper — macOS silently discards posted "
				+ "cursor events without it (no exception, no non-zero exit). Grant it in System Settings "
				+ "→ Privacy & Security → Accessibility, then restart lensmith-director."
		)
	}
	return accessibilityTrusted
}

// MARK: - Command handlers

func handlePosition(cmd: String = "position") {
	guard let point = currentLocation() else {
		emitError(cmd, "Unable to read the cursor position (CGEvent(source:) returned nil).")
		return
	}
	emit(["type": "ok", "cmd": cmd, "x": point.x, "y": point.y])
}

func handleWarm() {
	guard ensureAccessibilityTrusted(cmd: "warm") else { return }
	if warmUp() {
		emit(["type": "ok", "cmd": "warm", "warm": true])
	} else {
		emitError("warm", "Unable to post the warm-up event.")
	}
}

func handleMove(x: Double, y: Double, durationMs: Int) {
	guard ensureAccessibilityTrusted(cmd: "move") else { return }
	guard durationMs > 0 else {
		emitError("move", "durationMs must be a positive integer (got \(durationMs)).")
		return
	}
	guard let result = easedMove(to: CGPoint(x: x, y: y), durationMs: durationMs) else {
		emitError("move", "Unable to read the cursor position before moving.")
		return
	}
	emit([
		"type": "ok",
		"cmd": "move",
		"steps": result.steps,
		"elapsedMs": result.elapsedMs,
		"fromX": result.from.x,
		"fromY": result.from.y,
		"x": result.to.x,
		"y": result.to.y,
	])
}

func handleClick() {
	guard ensureAccessibilityTrusted(cmd: "click") else { return }
	warmUp()
	guard let point = currentLocation() else {
		emitError("click", "Unable to read the cursor position before clicking.")
		return
	}
	guard postClick(at: point) else {
		emitError("click", "Unable to create the click events.")
		return
	}
	emit(["type": "ok", "cmd": "click", "x": point.x, "y": point.y])
}

// MARK: - serve (long-lived, one NDJSON command per line on stdin)

func serve() {
	emit(["type": "ready", "warm": isWarm])
	while let line = readLine(strippingNewline: true) {
		let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.isEmpty { continue }
		guard let data = trimmed.data(using: .utf8),
			let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
			let cmd = object["cmd"] as? String
		else {
			emitError("?", "Malformed command line; expected a JSON object with a \"cmd\" field.")
			continue
		}

		switch cmd {
		case "position":
			handlePosition()
		case "warm":
			handleWarm()
		case "move":
			guard let x = object["x"] as? Double ?? (object["x"] as? NSNumber)?.doubleValue,
				let y = object["y"] as? Double ?? (object["y"] as? NSNumber)?.doubleValue
			else {
				emitError("move", "move requires numeric \"x\" and \"y\".")
				continue
			}
			let durationMs =
				(object["durationMs"] as? NSNumber)?.intValue ?? defaultMoveDurationMs
			handleMove(x: x, y: y, durationMs: durationMs)
		case "click":
			handleClick()
		case "quit":
			emit(["type": "ok", "cmd": "quit"])
			return
		default:
			emitError(cmd, "Unknown command \"\(cmd)\".")
		}
	}
}

// MARK: - Entry point

let usage = """
	lensmith-cursor-choreographer — moves the real macOS cursor and synthesises real clicks.

	Usage:
	  lensmith-cursor-choreographer position
	  lensmith-cursor-choreographer move <x> <y> [durationMs]
	  lensmith-cursor-choreographer click
	  lensmith-cursor-choreographer serve

	`serve` reads one JSON command per line on stdin and writes one JSON result per
	line on stdout. It is the intended entry point: the process stays alive, so the
	31-36 ms first-post cost is paid once instead of at the start of every move.

	Only `position` is read-only. Every other command posts real input events to
	whatever window is under the cursor.
	"""

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
	FileHandle.standardError.write(Data((usage + "\n").utf8))
	exit(2)
}

switch command {
case "position":
	handlePosition()
case "move":
	guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else {
		emitError("move", "Usage: move <x> <y> [durationMs]")
		exit(2)
	}
	let durationMs = args.count >= 4 ? (Int(args[3]) ?? defaultMoveDurationMs) : defaultMoveDurationMs
	handleMove(x: x, y: y, durationMs: durationMs)
case "click":
	handleClick()
case "serve":
	serve()
case "-h", "--help", "help":
	print(usage)
default:
	FileHandle.standardError.write(Data(("Unknown command \"\(command)\".\n\n" + usage + "\n").utf8))
	exit(2)
}
