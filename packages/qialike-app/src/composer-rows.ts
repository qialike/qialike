/**
 * The composer draft's WRAPPED-ROW model, with a single-entry cache.
 *
 * Ink paints the draft through `wrap-ansi` with `{ trim: false, hard: true }`,
 * and the panel has to reproduce exactly that wrap for: the card height, the
 * caret-following window, the hardware caret cell, the mouse→input-index
 * mapping, the selection bounds and the palette rows. Before this module each
 * of those call sites re-wrapped the WHOLE draft — measured: five full wraps per
 * render plus three more per painted frame through the frame suffix — which is
 * what a large pasted draft paid on every frame.
 *
 * The model is one row list per (draft, usable width), cached on the draft's own
 * string identity:
 *
 *   - an UNCHANGED draft hits the cache in O(1), so a repaint (or a second
 *     consumer within one render: height, window, caret, mouse mapping,
 *     selection, palette) re-wraps nothing;
 *   - an EDIT at the END of a printable-ASCII draft extends the list by
 *     re-wrapping only from the last affected row (append: the row holding the
 *     last space, or the last row for a whitespace-free tail; shrink: the same
 *     from the new draft's side) — measured O(terminal height) per keystroke
 *     instead of O(draft);
 *   - every other edit (middle insert, or any draft with wide/combining/ZWJ
 *     glyphs, tabs, control bytes) rebuilds from scratch, which is always exact.
 *
 * The ASCII gate is not caution for its own sake: the incremental rule was
 * fuzzed against `wrap-ansi` and is exact on printable ASCII + `\n` (~59k
 * append/shrink steps, zero mismatches) but NOT in general (≈3% mismatches when
 * the alphabet mixes wide glyphs, combining marks, ZWJ emoji and spaces, because
 * `wrap-ansi` splits words by code point and a sliced grapheme measures
 * differently; tabs break it the same way). Correctness wins: anything outside
 * the gate takes the full wrap.
 *
 * Dependency-light on purpose (no React/Ink): the unit tests drive it directly.
 *
 * Dependency-light on purpose (no React/Ink): the unit tests drive it directly.
 *
 * @module @qialike/qialike-app/composer-rows
 */

import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'

/** One painted row of the draft: its ABSOLUTE character offset and its text. */
export interface ComposerRow {
  start: number
  text: string
}

/** Wrap one logical line exactly like Ink's `<Text wrap="wrap">`: the same
 *  `wrap-ansi` call Ink's wrap-text.js makes (`trim: false, hard: true`), so the
 *  height/caret math can never drift from the rendered rows. Words longer than
 *  the column break anywhere; shorter words stay whole. */
export function composerWrap(text: string, usable: number): string[] {
  if (text === '') return ['']
  return wrapAnsi(text, usable, { trim: false, hard: true }).split('\n')
}

/** Reference row list: every visual row of the whole draft, with per-row
 *  character offsets. Rows are bijective with the text because wrap keeps every
 *  character (`trim: false`). This is the ONLY producer of the cached model. */
export function composerRowsReference(input: string, usable: number): ComposerRow[] {
  const rows: ComposerRow[] = []
  let offset = 0
  for (const seg of input.split('\n')) {
    let at = 0
    for (const text of composerWrap(seg, usable)) {
      rows.push({ start: offset + at, text })
      at += text.length
    }
    offset += seg.length + 1
  }
  return rows
}

/** The cached model. Keyed by the draft's string identity: `store.input` is
 *  replaced (never mutated) on every edit, so an unchanged draft hits this in
 *  O(1) and a new draft rebuilds once. */
let rowsCache: { input: string; usable: number; rows: ComposerRow[]; ascii: boolean } | null = null

/** How many times the model had to be rebuilt from scratch (tests assert the
 *  incremental path really is taken for an ASCII append). */
let fullBuilds = 0

/** Full rebuilds since the last {@link resetComposerRowBuilds}. */
export function composerRowBuilds(): number {
  return fullBuilds
}

/** Reset the full-rebuild counter (tests). */
export function resetComposerRowBuilds(): void {
  fullBuilds = 0
}

/**
 * Printable ASCII + `\n` only. The incremental rebuild below is EXACT on this
 * alphabet (fuzzed: ~59k append/shrink steps, zero mismatches) and NOT exact in
 * general — with wide glyphs, combining marks and ZWJ emoji a rebuild from a row
 * boundary can wrap differently from the whole draft (`wrap-ansi` splits words by
 * code point, so a sliced grapheme has a different width), and tabs have the same
 * hazard. Any other draft takes the full wrap, which is always exact.
 */
const ASCII_SAFE = /^[\x20-\x7e\n]*$/

/** Index of the row containing `offset` (the last row starting at or before it). */
function rowIndexAt(rows: ReadonlyArray<ComposerRow>, offset: number): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.start <= offset) return i
  }
  return -1
}

/** Re-wrap `input` from the row boundary `from`, keeping `kept` rows verbatim. */
function rebuildFrom(input: string, usable: number, kept: ComposerRow[], from: number): ComposerRow[] {
  const rows = kept.slice()
  let offset = from
  for (const seg of input.slice(from).split('\n')) {
    let at = 0
    for (const text of composerWrap(seg, usable)) {
      rows.push({ start: offset + at, text })
      at += text.length
    }
    offset += seg.length + 1
  }
  return rows
}

/** Append-only extension: content before the last space's row cannot be affected
 *  by text appended at the end, and with no space at all the tail is one
 *  hard-wrapped word (so only its last row can grow). */
function extendRows(input: string, usable: number, prev: { input: string; rows: ComposerRow[] }): ComposerRow[] | null {
  const old = prev.input
  const rows = prev.rows
  const lineStart = old.lastIndexOf('\n') + 1
  let space = old.lastIndexOf(' ')
  if (space < lineStart) space = -1
  const j = space >= 0 ? rowIndexAt(rows, space) : rows.length - 1
  if (j < 0) return null
  return rebuildFrom(input, usable, rows.slice(0, j), rows[j]!.start)
}

/** Shrink extension: text removed after the new draft's last space cannot change
 *  the rows before that space's row; the same hard-wrap argument covers a
 *  whitespace-free tail. */
function shrinkRows(input: string, usable: number, prev: { rows: ComposerRow[] }): ComposerRow[] | null {
  const n = input.length
  if (n === 0) return null
  const rows = prev.rows
  const lineStart = input.lastIndexOf('\n') + 1
  let space = input.lastIndexOf(' ')
  if (space < lineStart) space = -1
  const j = space >= 0 ? rowIndexAt(rows, space) : rowIndexAt(rows, Math.max(lineStart, n - 1))
  if (j < 0) return null
  const from = rows[j]!.start
  if (from > n) return null
  return rebuildFrom(input, usable, rows.slice(0, j), from)
}

/** `composerRowsReference`, memoized on (input, usable) with an exact-incremental
 *  fast path for end edits on ASCII drafts. The returned array is shared —
 *  callers must treat it as read-only. */
export function composerRows(input: string, usable: number): ComposerRow[] {
  const prev = rowsCache
  if (prev !== null && prev.usable === usable) {
    if (prev.input === input) return prev.rows
    if (prev.ascii && ASCII_SAFE.test(input)) {
      let rows: ComposerRow[] | null = null
      if (input.length > prev.input.length && input.startsWith(prev.input)) {
        rows = extendRows(input, usable, prev)
      } else if (input.length < prev.input.length && prev.input.startsWith(input)) {
        rows = shrinkRows(input, usable, prev)
      }
      if (rows !== null) {
        rowsCache = { input, usable, rows, ascii: true }
        return rows
      }
    }
  }
  const rows = composerRowsReference(input, usable)
  fullBuilds += 1
  rowsCache = { input, usable, rows, ascii: ASCII_SAFE.test(input) }
  return rows
}

/** Drop the row cache (tests; also a way to release a large draft). */
export function resetComposerRowsCache(): void {
  rowsCache = null
}

/** Display width memo, so the height path's saturation test (and the caret
 *  cell) do not each pay a `string-width` pass over a multi-megabyte draft.
 *  Display width — NOT `String.length`: a surrogate pair or ZWJ sequence is many
 *  code units on one row. */
let widthCache: { input: string; cells: number } | null = null

/** Display width of the draft (`string-width`), memoized on its identity. */
export function composerCells(input: string): number {
  if (widthCache !== null && widthCache.input === input) return widthCache.cells
  const cells = stringWidth(input)
  widthCache = { input, cells }
  return cells
}

/** Drop the display-width memo (tests). */
export function resetComposerWidthCache(): void {
  widthCache = null
}

/**
 * The GLOBAL visual row of `caret`, found in an exact row list by binary search
 * — no prefix re-wrap.
 *
 * A caret at a row boundary belongs to the row that the prefix wrap's trailing
 * (possibly empty) row would be: after a `\n` it is the row STARTING at the
 * caret; at a hard-wrap boundary it is the row ENDING there. The separator check
 * (`start − previous end === 1`) is what tells the two apart, and it is the
 * exact reason `composerCaretGlobalRow` can stop wrapping the prefix.
 */
export function composerCaretRowIn(rows: ReadonlyArray<ComposerRow>, input: string, caret: number): number {
  const at = Math.max(0, Math.min(caret, input.length))
  if (at <= 0) return 0
  if (at >= input.length) return Math.max(0, rows.length - 1)
  let lo = 0
  let hi = rows.length - 1
  let row = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid]!.start <= at) { row = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  if (rows[row]!.start === at) {
    if (row > 0) {
      const prev = rows[row - 1]!
      // 1 = a '\n' sits between the rows (a new logical line); 0 = hard wrap.
      if (rows[row]!.start - (prev.start + prev.text.length) === 1) return row
      return row - 1
    }
    return 0
  }
  return row
}

/** The caret's global visual row over ALL wrapped input rows. */
export function composerCaretGlobalRow(input: string, cursor: number, usable: number): number {
  return composerCaretRowIn(composerRows(input, usable), input, Math.max(0, Math.min(cursor, input.length)))
}

/** Which visual rows are visible in the composer's text area, given the caret's
 *  global row: a window of `textArea` rows that keeps the caret row visible
 *  (tail when typing at the end). Returns the first visible row and the exact
 *  `[start, end)` character range of those rows, so the caller renders ONLY that
 *  window — the box never overflows and the caret row stays inside it. */
export function composerWindow(
  input: string,
  usable: number,
  caretRow: number,
  textArea: number,
): { rows: ComposerRow[]; first: number; start: number; end: number } {
  const rows = composerRows(input, usable)
  const total = rows.length
  const area = Math.max(1, textArea)
  const first = total <= area ? 0 : Math.max(0, Math.min(caretRow - (area - 1), total - area))
  const lastRow = rows[Math.min(total - 1, first + area - 1)]!
  return { rows, first, start: rows[first]!.start, end: lastRow.start + lastRow.text.length }
}

/** New caret index after moving by `dirRows` VISUAL rows (whole wrapped rows),
 *  keeping the same cell column when possible. Used by the wheel over the
 *  composer: when the draft is taller than its box the wheel scrolls the DRAFT
 *  (visual-line caret moves = what ↑/↓ do), not the transcript. */
export function composerCaretMoveVisual(input: string, caret: number, usable: number, dirRows: -1 | 1): number {
  const rows = composerRows(input, usable)
  if (rows.length <= 1) return caret
  const from = composerCaretGlobalRow(input, caret, usable)
  const target = Math.max(0, Math.min(rows.length - 1, from + dirRows))
  if (target === from) return caret
  const src = rows[from]!
  // Column (cells) of the caret inside its source visual row.
  const srcCol = src.text.slice(0, caret - src.start).split('').reduce((acc, ch) => acc + stringWidth(ch), 0)
  const dst = rows[target]!
  let acc = 0
  let idx = dst.text.length
  for (let i = 0; i < dst.text.length; i++) {
    const cw = stringWidth(dst.text[i]!)
    if (acc >= srcCol) { idx = i; break }
    acc += cw
    if (acc === srcCol) { idx = i + 1; break }
  }
  return dst.start + Math.min(idx, dst.text.length)
}
