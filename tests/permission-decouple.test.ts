/**
 * Decoupling contract for the composer Tab key (fix 3, dsh-tui-security.md):
 * Tab cycles the FILE SANDBOX MODE only — it must never flip the approval
 * policy to `never` as a side effect of reaching danger-full-access, or one
 * Tab press would silently disable both the file boundary and tool approval.
 *
 * Two anchors are asserted:
 *  - the sandbox cycle still runs through danger-full-access (Tab keeps its
 *    mode-toggle job), while the danger status label no longer advertises
 *    "no approval" (the display must not lie about the approval policy);
 *  - the conversation panel source no longer touches the approval policy at
 *    all (a source-level regression guard: any future Tab/policy coupling
 *    reintroducing `setApprovalPolicy` fails this test).
 *
 * Run with `bun test tests/permission-decouple.test.ts`.
 *
 * @module dsh-tui/permission-decouple-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSION_LABEL, SANDBOX_CYCLE, Store } from '../packages/dsh-tui-app/src/index.tsx'

describe('Tab sandbox cycle keeps cycling modes', () => {
  test('cyclePermission walks the full SANDBOX_CYCLE incl. danger-full-access', () => {
    const store = new Store()
    // Default is workspace-write; three cycles walk the ring and return.
    const first = store.cyclePermission()
    expect(first).toBe('danger-full-access')
    expect(store.cyclePermission()).toBe('read-only')
    expect(store.cyclePermission()).toBe('workspace-write')
    expect(SANDBOX_CYCLE).toContain('danger-full-access')
  })

  test('danger label describes the file boundary only (no approval claim)', () => {
    expect(PERMISSION_LABEL['danger-full-access']).toBe('Full access')
    expect(PERMISSION_LABEL['danger-full-access'].toLowerCase()).not.toContain('no approval')
    expect(PERMISSION_LABEL['danger-full-access'].toLowerCase()).not.toContain('never')
  })
})

describe('approval policy is decoupled from the sandbox mode', () => {
  test('conversation panel never calls setApprovalPolicy (regression guard)', () => {
    // The coupling used to live in the Tab handler of panels/conversation.tsx
    // (danger-full-access → 'never'). Fix 3 removed it; approvals can only be
    // turned off by an explicit human action (dock "Allow always").
    const src = readFileSync(
      join(process.cwd(), 'packages/dsh-tui-app/src/panels/conversation.tsx'),
      'utf8',
    )
    expect(src).not.toMatch(/setApprovalPolicy/)
    expect(src).not.toMatch(/dsh-user-approval/)
  })
})
