/**
 * The composer's SHARED arithmetic: usable width, the height cap, the exact
 * clamp, and the saturation bound.
 *
 * These four numbers used to exist in two hand-written copies (the conversation
 * panel's `composerHeight` and `pointer-region.ts`'s `composerStripRows`, which
 * the approval/question panels bundle separately). The copies had to agree
 * exactly — a drift of one row misroutes the pointer region or clips the card —
 * and both had to re-wrap the whole draft to produce them. This module is
 * dependency-free on purpose: `pointer-region.ts` must be able to import it
 * without pulling React/Ink (or a second copy of the panel) into the dock
 * bundles.
 *
 * @module @yourname/dsh-tui-app/composer-metrics
 */

/** The composer's wrap width inside the message column (`max(10, right − 4)`). */
export function composerUsableFor(messageRight: number): number {
  return Math.max(10, messageRight - 4)
}

/** The height cap tied to the terminal height (`max(min, rows − 8)`). */
export function composerCap(rows: number, min: number): number {
  return Math.max(min, rows - 8)
}

/** `min(min + wrapped − 1, cap)` — the card height for an exact row count. */
export function composerHeightFor(wrapped: number, min: number, cap: number): number {
  return Math.min(min + wrapped - 1, cap)
}

/**
 * `cap` when the LOWER BOUND on rows already reaches it, else undefined.
 *
 * Every painted row holds at most `usable` display cells (hard wrap never
 * exceeds the column), so a draft of `cells` cells needs at least
 * `ceil(cells/usable)` rows; when that alone saturates the clamp the exact count
 * cannot change the answer. `cells` is a DISPLAY width (`visualWidth`), not
 * `String.length`: a surrogate pair or ZWJ sequence is many code units on one
 * row (measured over 40k fuzzed strings: the cell bound never over-estimated,
 * the UTF-16 bound did 5404 times).
 */
export function composerHeightSaturated(cells: number, usable: number, min: number, cap: number): number | undefined {
  const rows = Math.ceil(Math.max(0, cells) / Math.max(1, usable))
  return min + rows - 1 >= cap ? cap : undefined
}
