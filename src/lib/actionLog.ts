/**
 * The action-log entry shapes `drive` records, one per step. CR-LENSMITH-A002-2.
 *
 * The action log is the FULL record of a driven run — "this is the full
 * record; nothing here is discarded" (the CR's own words). Its consumer is
 * out of this CR's scope (the future LLM editor/judge, RN-040 §3's role 9),
 * so it errs toward completeness rather than guessing what a later reader
 * will not need.
 *
 * `wait` steps get a marker entry (Forge's call, per the CR's own text: "it
 * may appear as a marker entry — Forge's call, document the choice"). The
 * alternative — silently dropping wait steps from the log — would make the
 * gaps between click timestamps unexplained to a reader who was not also
 * looking at the step list; a marker costs nothing and removes that
 * ambiguity.
 */

export interface BoundingBoxLike {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ActionLogClickEntry {
	index: number;
	type: "click";
	selector: string;
	label?: string;
	/** When the choreographed move toward the element began, relative to `t0` (page `load`). */
	startedAtMs: number;
	/** When the click was posted, relative to `t0`. */
	clickedAtMs: number;
	/** The computed OS-screen point the choreographer was sent to — RN-040 §5a's formula. */
	screenX: number;
	screenY: number;
	/** The element's Playwright bounding box (CSS px, viewport-relative) at click time. */
	boundingBox: BoundingBoxLike;
	/** ms from the click until the result settled (the `expect` selector visible, else DOM quiet; capped). CR-LENSMITH-A007-2. */
	settleMs: number;
	/** CR-LENSMITH-A008-2: the narration line id spoken over this step (`s<index>`), when narrated. */
	voiceLineId?: string;
	/** CR-LENSMITH-A008-2: when that line starts, relative to `t0` (same clock as the other times). */
	voiceStartMs?: number;
}

export interface ActionLogWaitEntry {
	index: number;
	type: "wait";
	/** When the wait began, relative to `t0`. */
	atMs: number;
	ms: number;
	/** CR-LENSMITH-A008-2: the narration line id spoken over this step (`s<index>`), when narrated. */
	voiceLineId?: string;
	/** CR-LENSMITH-A008-2: when that line starts, relative to `t0` (same clock as the other times). */
	voiceStartMs?: number;
}

/**
 * CR-LENSMITH-A002-6. Deliberately carries no `text` field — the Invariant
 * this CR builds against is that the typed value never appears in the action
 * log or the zoom fragment; `characterCount` is the only trace of what was
 * entered.
 */
export interface ActionLogTypeEntry {
	index: number;
	type: "type";
	selector: string;
	label?: string;
	/** When the choreographed move toward the field began, relative to `t0`. */
	startedAtMs: number;
	/** When the last character was entered, relative to `t0`. */
	endedAtMs: number;
	/** The achieved OS-screen point the choreographer's click resolved to. */
	screenX: number;
	screenY: number;
	/** The field's Playwright bounding box (CSS px, viewport-relative) at focus time. */
	boundingBox: BoundingBoxLike;
	/** Number of characters entered — never the characters themselves. */
	characterCount: number;
	/** ms from the last character until the result settled. CR-LENSMITH-A007-2. */
	settleMs: number;
	/** CR-LENSMITH-A008-2: the narration line id spoken over this step (`s<index>`), when narrated. */
	voiceLineId?: string;
	/** CR-LENSMITH-A008-2: when that line starts, relative to `t0` (same clock as the other times). */
	voiceStartMs?: number;
}

export type ActionLogEntry = ActionLogClickEntry | ActionLogWaitEntry | ActionLogTypeEntry;
