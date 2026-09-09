/**
 * Unit tests for the /export destination containment guard (fix 2,
 * dsh-tui-security.md): a custom `--output`/dialog name is resolved against
 * the workspace root and refused when it would escape it (`../` segments or an
 * absolute path), while names inside the workspace — including subdirectories
 * — keep working.
 *
 * Run with `bun test tests/export-containment.test.ts`.
 *
 * @module dsh-tui/export-containment-test
 */

import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveExportDestination } from '../packages/dsh-tui-app/src/export.tsx'

const workspace = join(tmpdir(), 'dsh-tui-export-root')

describe('resolveExportDestination accepts in-workspace names', () => {
  test('plain file name resolves under the workspace root', () => {
    const r = resolveExportDestination(workspace, 'session-ab12cd34', 'json')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.file).toBe(join(workspace, 'session-ab12cd34.json'))
  })

  test('subdirectory names are allowed (mkdir recursive covers them)', () => {
    const r = resolveExportDestination(workspace, 'archive/deep/report', 'md')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.file).toBe(join(workspace, 'archive', 'deep', 'report.md'))
  })

  test('leading dots / ./-anchored names stay inside', () => {
    const r = resolveExportDestination(workspace, './session-x', 'json')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.file).toBe(join(workspace, 'session-x.json'))
  })
})

describe('resolveExportDestination refuses workspace escapes', () => {
  test('parent-traversal name is refused', () => {
    const r = resolveExportDestination(workspace, '../evil', 'json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('escapes workspace')
  })

  test('deep parent-traversal through a subdir is refused', () => {
    const r = resolveExportDestination(workspace, 'a/../../outside', 'md')
    expect(r.ok).toBe(false)
  })

  test('an absolute-style name stays contained (join keeps it under the root)', () => {
    // path.join swallows a second absolute argument as a relative suffix, so
    // '/etc/…' resolves to <workspace>/etc/… — inside the root, never outside.
    const r = resolveExportDestination(workspace, '/etc/cron.d/dsh-export', 'json')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.file.startsWith(workspace)).toBe(true)
  })

  test('a traversal that climbs past the filesystem root is refused', () => {
    const r = resolveExportDestination(workspace, '../../../../../../evil', 'json')
    expect(r.ok).toBe(false)
  })

  test('a traversal that climbs exactly to the parent dir is refused', () => {
    const r = resolveExportDestination(workspace, '../', 'json')
    expect(r.ok).toBe(false)
  })
})
