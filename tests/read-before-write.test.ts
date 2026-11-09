/**
 * Read-before-write stays ON in qialike, even though harness 0.2.2 turns it off.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. The harness flipped a DEFAULT: the base
 * bundle now mounts `fs-observation-policy` with `disabled: true`, so `write`
 * overwrites a file the model never read and `edit` replaces text in a file that
 * changed underneath it. qialike keeps the older contract deliberately (silent
 * corruption, and a full-screen TUI has no diff-review step to catch it), and the
 * only thing expressing that is one `disabled: false` row in the composition patch.
 *
 * Two ways it can regress, both invisible in review:
 *   * the row is dropped — then "absent" means the base's NEW default, i.e. off,
 *     which is the opposite of what it meant when this file was written;
 *   * someone enables `apply_patch` (`applyPatch: true`), which applies hunks on
 *     context match alone — a documented way around the same fence.
 *
 * Run with `bun test tests/read-before-write.test.ts`.
 *
 * @module qialike/read-before-write-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const PATCH = readFileSync(join(REPO, 'packages', 'qialike-app', 'cordis.patch.yml'), 'utf8')

describe('the read-before-write fence is held by this composition', () => {
  test('the composition states `disabled: false` for fs-observation-policy', () => {
    // Explicitly false, not merely absent: the base row ships `disabled: true`, so an
    // absent override would silently opt qialike into the new default.
    expect(PATCH).toMatch(/^- id: fs-observation-policy\n\s+disabled: false\s*$/m)
  })

  test('apply_patch is never switched on — it is the same unread write by another name', () => {
    // `tool-fs` may be overridden for other reasons (read limits, write/edit toggles),
    // so the assertion is about the one field rather than about the row.
    expect(PATCH, 'apply_patch applies hunks on context match alone')
      .not.toMatch(/applyPatch:\s*true/)
  })
})
