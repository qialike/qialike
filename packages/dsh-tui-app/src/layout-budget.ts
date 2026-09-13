/**
 * Shared vertical budget for the DOCKED (conversation) view, plus the app's
 * minimum-height policy.
 *
 * Three places used to compute the docked composer strip independently — the
 * painted card (`composerBand`), the pointer/selection mirror
 * (`mainSurfaceGeometry`) and the in-flow-dock router
 * (`pointer-region.composerStripRows`) — each carrying its own copy of `5`, `3`
 * and `rows − STATUS_BAR_HEIGHT − h + 1`. They agreed only while the transcript
 * still had slack: the message column's own chrome above the card (its `paddingY`
 * top row + the 1-row `gap` before the composer) cannot shrink, so on a short
 * terminal the paint stops the card at that chrome while the model keeps sliding
 * it up. Measured on the REAL binary at 133 columns: at 9 rows the caret sat one
 * row ABOVE the draft and the card's bottom edge was painted under the status
 * bar; at 8 rows it was two rows with the chip row overwritten. This module is
 * the one place those numbers live.
 *
 * @module @yourname/dsh-tui-app/layout-budget
 */

/** Status-bar rows pinned at the bottom of the docked view. */
export const STATUS_BAR_HEIGHT = 3

/** Card chrome-inclusive minimum: the two half-row fill edges + the blank row +
 *  the status row + one input row. */
export const COMPOSER_MIN_HEIGHT = 5

/** Rows the message column spends ABOVE the card that cannot shrink: its
 *  `paddingY` top row (1) plus the 1-row `gap` between the transcript and the
 *  composer (1). The card can therefore never sit above row
 *  `1 + DOCKED_CHROME_ABOVE_CARD`. */
export const DOCKED_CHROME_ABOVE_CARD = 2

/** Transcript rows the minimum height reserves. Without them the "conversation"
 *  view is a card you can type into with nothing to read: at 10 terminal rows the
 *  arithmetic is drift-free but leaves ZERO transcript rows (measured), which is
 *  why the technical floor is not the product minimum. */
export const DOCKED_MIN_TRANSCRIPT_ROWS = 4

/** Minimum terminal rows for the docked view (user call, 2026-09-13):
 *  card 5 + chrome-above 2 + status bar 3 + 4 transcript rows = **14** —
 *  deliberately the same number as the hero's minimum (`HERO_MIN_ROWS`), so the
 *  whole app has ONE documented minimum instead of two rules a row apart (and it
 *  is also exactly where the Steps sidebar starts fitting: `sidebarFits` needs
 *  ≥14 rows). */
export const DOCKED_MIN_ROWS =
  COMPOSER_MIN_HEIGHT + DOCKED_CHROME_ABOVE_CARD + STATUS_BAR_HEIGHT + DOCKED_MIN_TRANSCRIPT_ROWS

/**
 * Whether the docked stack can be laid out honestly at `rows`.
 * @param rows - terminal rows.
 * @returns true when the card, the chrome above it, the status bar and the
 *   reserved transcript rows all fit.
 */
export function dockedFits(rows: number): boolean {
  return rows >= DOCKED_MIN_ROWS
}

/**
 * First painted row (1-based) of the docked composer card.
 *
 * Bottom-anchored (`rows − status − cardH + 1`), but CLAMPED at the fixed chrome
 * above it — the paint cannot slide the card above `padding + gap`, which is
 * exactly what the old model missed on short terminals. On a terminal tall enough
 * to draw the docked view the clamp is a belt (the bottom-anchored value is
 * already ≥ the clamp); it is what keeps the model honest for any card height.
 * @param rows - terminal rows.
 * @param cardH - card height in rows (image chip included).
 * @returns the card's first painted row.
 */
export function dockedComposerTop(rows: number, cardH: number): number {
  return Math.max(rows - STATUS_BAR_HEIGHT - cardH + 1, 1 + DOCKED_CHROME_ABOVE_CARD)
}

/**
 * Transcript rows the docked view reserves at `rows` for a card of `cardH`.
 * @param rows - terminal rows.
 * @param cardH - card height in rows (image chip included).
 * @returns rows left for the transcript (may be negative when nothing fits).
 */
export function dockedTranscriptRows(rows: number, cardH: number): number {
  return rows - STATUS_BAR_HEIGHT - DOCKED_CHROME_ABOVE_CARD - cardH
}

/**
 * The one-row notice painted INSTEAD of a view that cannot be laid out honestly.
 * ONE builder for both views (hero and docked), so the copy cannot diverge, and
 * the ONE place that names the escape hatch the input gate leaves open.
 * @param minRows - the minimum the view needs (derived by the caller).
 * @returns the notice text.
 */
export function tooSmallNotice(minRows: number): string {
  // The parenthetical is load-bearing: every key is dropped while this notice is
  // up (see the gate in `handleKey`), so the user must be told why typing does
  // nothing — and how to get out (Ctrl+C quits; `/exit` needs typing).
  return `Terminal too small — resize to at least ${minRows} rows (keys paused; Ctrl+C quits)`
}
