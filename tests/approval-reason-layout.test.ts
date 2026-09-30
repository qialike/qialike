/**
 * The approval dock's REASON layout (`panels/approval.tsx`).
 *
 * The dock used to render the reason through `wrap="truncate"` — one line,
 * ellipsised. That hid the thing the user is being asked to approve: an
 * escalation reason is the model's own justification for wanting WIDER access,
 * and a real session's were 200+ characters. Two consequences made this worth
 * fixing rather than documenting:
 *
 *  - the reason's most important fact (which mode it asks to widen to) was
 *    STRIPPED by the old `conciseReason` and never shown anywhere else, so the
 *    prompt did not name the access being granted;
 *  - the dock's height was hard-coded at 11 in `conversation.tsx`, so any
 *    wrapping would have pushed the dock's bottom edge (hint + border) off the
 *    screen.
 *
 * These cases pin the reason's split, the row-bounded fitting, and the height
 * that `conversation.tsx` reserves — the three pieces that must agree.
 *
 * Run with `bun test tests/approval-reason-layout.test.ts`.
 *
 * @module qialike/approval-reason-layout-test
 */

import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import React from '../packages/qialike-app/node_modules/react/index.js'
import { Box, measureElement, render } from '../packages/qialike-app/node_modules/ink/build/index.js'
import {
  REASON_MAX_ROWS,
  ApprovalDialog,
  approvalDialogRows,
  approvalReason,
  approvalReasonLayout,
  fitReason,
} from '../packages/qialike-app/src/panels/approval.tsx'
import { countWrappedLines } from '../packages/qialike-app/src/markdown.tsx'
import { dockInnerWidth } from '../packages/qialike-app/src/config.ts'
import type { PendingApproval } from '../packages/qialike-app/src/index.tsx'
/** The first escalation reason a real session recorded (see the CHANGELOG entry). */
const REPORTED_REASON = 'escalate sandbox to danger-full-access: The workspace-write sandbox cannot load '
  + 'its own ACL module, so every command dies before running; bypassing it is the only way to actually '
  + 'inspect the repository you asked about.'

describe('approvalReason splits the escalation target from the prose', () => {
  test('the requested mode is surfaced instead of stripped away', () => {
    // The old implementation matched the same prefix only to DELETE it, so the
    // prompt never named the mode it was asking the user to grant.
    const parsed = approvalReason(REPORTED_REASON, 'pwsh')
    expect(parsed.target).toBe('danger-full-access')
    expect(parsed.text.startsWith('The workspace-write sandbox cannot load')).toBe(true)
    expect(parsed.text).not.toContain('escalate sandbox')
  })

  test('a reason with no escalation prefix is prose with no target', () => {
    const parsed = approvalReason('This host has no kernel sandbox for shell commands.', 'pwsh')
    expect(parsed.target).toBeUndefined()
    expect(parsed.text).toBe('This host has no kernel sandbox for shell commands.')
  })

  test('a missing reason still names the tool', () => {
    const parsed = approvalReason(undefined, 'pwsh')
    expect(parsed.target).toBeUndefined()
    expect(parsed.text).toContain('pwsh')
  })
})

describe('fitReason bounds the reason by ROWS, not characters', () => {
  test('the reported reason fits whole at a typical terminal width', () => {
    // This is the case that failed: it must be fully readable, not ellipsised.
    const cols = dockInnerWidth(120, 'auto')
    const text = approvalReason(REPORTED_REASON, 'pwsh').text
    const shown = fitReason(text, cols)
    expect(shown).toBe(text)
    expect(countWrappedLines(shown, cols)).toBeLessThanOrEqual(REASON_MAX_ROWS)
  })

  test('the same text needs more rows on a narrow terminal and is then shortened visibly', () => {
    const text = approvalReason(REPORTED_REASON, 'pwsh').text
    const narrow = dockInnerWidth(46, 'auto')
    const shown = fitReason(text, narrow)
    // Either it still fits, or the shortening is marked and itself fits.
    expect(countWrappedLines(shown, narrow)).toBeLessThanOrEqual(REASON_MAX_ROWS)
    if (shown !== text) expect(shown).toContain('(full text below the prompt)')
  })

  test('an over-long reason is cut to the budget and says so', () => {
    const long = 'x'.repeat(4_000)
    const cols = 40
    const shown = fitReason(long, cols)
    expect(shown.length).toBeLessThan(long.length)
    expect(shown).toContain('(full text below the prompt)')
    expect(countWrappedLines(shown, cols)).toBeLessThanOrEqual(REASON_MAX_ROWS)
  })

  test('wide glyphs count as two columns, so a CJK reason is bounded just as tightly', () => {
    const cjk = '这是一个很长很长的理由'.repeat(40)
    const cols = 30
    const shown = fitReason(cjk, cols)
    expect(countWrappedLines(shown, cols)).toBeLessThanOrEqual(REASON_MAX_ROWS)
    // The width oracle is the shared one, so a wide glyph never overflows the row.
    expect(shown).not.toBe(cjk)
  })
})

describe('the dock height the transcript reserves matches what the dock paints', () => {
  test('a one-row reason paints the historical 11-row dock, a targeted one 13', () => {
    // 10 = border 2 + vertical padding 2 + title 1 + reason margin 1 + actions
    // margin 1 + actions row 1 + hint margin 1 + hint row 1; +2 for the optional
    // `Requests access:` block (its margin row AND its text row); + the reason's
    // rows. Measured against the real Ink render below, which paints 13.
    expect(approvalDialogRows(1, false)).toBe(11)
    expect(approvalDialogRows(1, true)).toBe(13)
  })

  test('every wrapped reason row adds exactly one dock row', () => {
    for (let rows = 1; rows <= REASON_MAX_ROWS; rows += 1) {
      expect(approvalDialogRows(rows + 1, false) - approvalDialogRows(rows, false)).toBe(1)
    }
  })

  test('approvalReasonLayout reports the height it produced', () => {
    const layout = approvalReasonLayout(REPORTED_REASON, 'pwsh', 46, 'auto')
    expect(layout.target).toBe('danger-full-access')
    // The dock is exactly as tall as its own row count says — the claim that
    // broke when the reason started wrapping.
    expect(layout.dockRows).toBe(approvalDialogRows(layout.rows, true))
    expect(layout.rows).toBeGreaterThanOrEqual(1)
    expect(layout.rows).toBeLessThanOrEqual(REASON_MAX_ROWS)
  })

  test('a dock with no reason still reserves at least the one-row height', () => {
    const layout = approvalReasonLayout(undefined, 'pwsh', 120, 'auto')
    expect(layout.rows).toBe(1)
    expect(layout.dockRows).toBe(11)
  })
})

describe('the reserved height equals the height Ink paints', () => {
  /** A TTY-shaped sink: Ink's layout only needs columns/rows/isTTY. */
  class FakeStdout extends Writable {
    columns: number
    rows: number
    isTTY = true
    constructor(cols: number, rows: number) {
      super()
      this.columns = cols
      this.rows = rows
    }
    _write(_chunk: unknown, _enc: unknown, cb: () => void): void { cb() }
  }

  /**
   * Paint the REAL dock at one terminal width and report the rows Ink lays out.
   *
   * The panel's module-level `store` is what `ApprovalDialog` reads, so this
   * calls the panel's own `apply()` — the registration the Loader performs —
   * rather than hand-building the element tree: the measurement is then of the
   * component as shipped. The fake context answers only the two lookups `apply`
   * makes.
   */
  async function paintedDockRows(width: number, req: PendingApproval['req']): Promise<number> {
    // A plain store stand-in: the panel reads exactly these members, and a real
    // `Store` cannot be pointed at an arbitrary width from a test.
    let approval: PendingApproval | null = null
    const store = {
      width,
      rows: 40,
      sidebarMode: 'auto',
      approvalChoice: 2,
      get approval() { return approval },
      setApproval(next: PendingApproval | null) { approval = next },
      setApprovalRows: () => {},
    }
    store.setApproval({ req, resolve: () => {} })
    const { apply } = await import('../packages/qialike-app/src/panels/approval.tsx')
    apply({
      get: (name: string) => (name === 'tuiStore' ? store : { panels: { register: () => {} } }),
    } as never)

    const ref = React.createRef<import('ink').DOMElement>()
    const instance = render(
      React.createElement(
        // The dock is a flex child of the message column there, so it fills that
        // width; the inner Box reproduces exactly that and gives `measureElement`
        // a node (Ink 4's `render` returns no root handle and no `lastFrame`).
        Box,
        { width, flexDirection: 'column' },
        React.createElement(
          Box,
          { ref, flexDirection: 'column' },
          React.createElement(ApprovalDialog, { approval: store.approval as PendingApproval }),
        ),
      ),
      {
        stdout: new FakeStdout(width, 40) as unknown as NodeJS.WriteStream,
        stdin: process.stdin,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    )
    // Ink commits React, then runs its yoga layout; measureElement reads the
    // computed node height, so give the layout a beat before reading it.
    await new Promise((resolve) => setTimeout(resolve, 60))
    const height = Math.round(measureElement(ref.current).height)
    instance.unmount()
    return height
  }

  test('a short reason paints exactly the reserved height', async () => {
    const req = { toolName: 'pwsh', reason: 'Run the workspace test suite.' } as const
    const painted = await paintedDockRows(120, req)
    // The estimate the transcript reserves on frame one must be at least what the
    // dock paints — over-reserving costs a row, under-reserving clips the dock.
    expect(painted).toBeLessThanOrEqual(approvalReasonLayout(req.reason, req.toolName, 120, 'auto').dockRows)
    expect(approvalReasonLayout(req.reason, req.toolName, 120, 'auto').dockRows - painted).toBeLessThanOrEqual(1)
  })

  test('the reported escalation reason is not truncated and is reserved for', async () => {
    const req = { toolName: 'pwsh', reason: REPORTED_REASON } as const
    const layout = approvalReasonLayout(req.reason, req.toolName, 120, 'auto')
    // The whole point: this reason is SHOWN, not ellipsised.
    expect(layout.shortened).toBe(false)
    expect(layout.target).toBe('danger-full-access')
    const painted = await paintedDockRows(120, req)
    // The estimate is the first frame's reservation; the panel's measured height
    // replaces it from frame two, so the two may differ by at most one row.
    expect(Math.abs(painted - layout.dockRows)).toBeLessThanOrEqual(1)
    // And it is genuinely taller than the one-line dock this used to paint.
    expect(painted).toBeGreaterThan(11)
  })

  test('a targeted dock with a one-row reason reserves at least what it paints', async () => {
    // The `Requests access:` block is a margin row PLUS its text row, so a dock
    // carrying a target paints TWO rows more than the same dock without one.
    // Neither case above isolates that: the first has no target, and the second's
    // extra estimated wrap row cancels the missing margin. This one has a target,
    // a reason that fits on a single row, and no compensating row — so an
    // under-reserving estimate shows up here as a clipped dock's bottom edge.
    const req = {
      toolName: 'pwsh',
      reason: 'escalate sandbox to danger-full-access: Run the workspace test suite.',
    } as const
    const layout = approvalReasonLayout(req.reason, req.toolName, 120, 'auto')
    expect(layout.target).toBe('danger-full-access')
    expect(layout.rows).toBe(1)
    const painted = await paintedDockRows(120, req)
    // Over-reserving costs one row of transcript; under-reserving clips the dock.
    expect(layout.dockRows).toBeGreaterThanOrEqual(painted)
  })

  test('no reason at all paints exactly the reserved height', async () => {
    const req = { toolName: 'pwsh' } as const
    const painted = await paintedDockRows(120, req)
    // The 11-row dock this panel has always painted, estimated and measured alike.
    expect(approvalReasonLayout(undefined, req.toolName, 120, 'auto').dockRows).toBe(11)
    expect(painted).toBe(11)
  })
})
