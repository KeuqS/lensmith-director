import CoreGraphics
import Foundation

// lensmith-screen-capture-preflight — proves screen capture is actually
// POSSIBLE right now, for `worker`'s startup preflight (CR-LENSMITH-A002-8
// Technical Spec item 3).
//
// `CGPreflightScreenCaptureAccess()` is already proven, on this exact class
// of machine, to answer `true` while capture produces nothing usable
// ([[BF-5]]): it reports a cached PERMISSION flag, not present CAPABILITY.
// This binary asks a different, harder-to-fake question instead: can this
// process actually see another application's real, on-screen window title
// right now?
//
// Since macOS 10.15, `CGWindowListCopyWindowInfo` returns an entry for every
// on-screen window regardless of permission, but redacts `kCGWindowName` to
// empty/absent for any window this process does not own UNLESS Screen
// Recording access is genuinely granted to the process macOS holds
// responsible for it (the same TCC attribution this CR's own document
// measured for `record`, walking to the terminal application actually
// running this process). A real title is captured CONTENT, not a flag — its
// presence is evidence capture will work; its absence, evidence it will not.
// This is a one-shot check (unlike the long-lived `cursor-choreographer`
// helper): it enumerates once and exits, so it belongs in its own binary
// rather than a new command on that helper's unrelated NDJSON protocol.

func fail(_ message: String) -> Never {
	FileHandle.standardError.write(Data("\(message)\n".utf8))
	exit(1)
}

let listOptions: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let rawList = CGWindowListCopyWindowInfo(listOptions, kCGNullWindowID) else {
	fail(
		"Window enumeration itself failed (CGWindowListCopyWindowInfo returned nil) — this is not "
			+ "the ordinary no-permission case, which still returns a list with redacted titles. "
			+ "Investigate before retrying; this is not a permission problem."
	)
}
guard let windows = rawList as? [[String: AnyObject]] else {
	fail("Window enumeration returned an unexpected shape — cannot evaluate capture capability.")
}

let ownPid = ProcessInfo.processInfo.processIdentifier

let normalWindowsWithVisibleTitles = windows.filter { info -> Bool in
	guard let ownerPidNumber = info[kCGWindowOwnerPID as String] as? NSNumber else { return false }
	if ownerPidNumber.int32Value == ownPid { return false }

	guard let layerNumber = info[kCGWindowLayer as String] as? NSNumber else { return false }
	if layerNumber.intValue != 0 { return false }

	guard let name = info[kCGWindowName as String] as? String, !name.isEmpty else { return false }
	return true
}

if normalWindowsWithVisibleTitles.isEmpty {
	fail(
		"No other application's window title is visible to this process (\(windows.count) window(s) "
			+ "enumerated in total, all with redacted or empty titles). macOS redacts window titles "
			+ "from a process without real Screen Recording access, even when "
			+ "CGPreflightScreenCaptureAccess() reports granted ([[BF-5]]). Grant Screen Recording, in "
			+ "System Settings -> Privacy & Security -> Screen Recording, to the exact application this "
			+ "worker was started from. An SSH session has no GUI session and cannot be granted this at "
			+ "all — start the worker from a Terminal window on the physical console instead, then "
			+ "restart it."
	)
}

print(
	"\(normalWindowsWithVisibleTitles.count) window(s) with a real, visible title out of "
		+ "\(windows.count) enumerated — screen capture is possible from this process."
)
exit(0)
