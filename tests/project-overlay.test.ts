/**
 * The repository overlay's policy, pinned as BEHAVIOUR (not source guards) plus
 * the pure hero helpers it drives.
 *
 * `<repoRoot>/.dsh/tui.cordis.patch.yml` is the one layer a repository controls
 * and it is applied automatically at boot. Before this policy existed a cloned
 * repository could (a) run a process through an MCP row — measured: the server's
 * `initialize`/`tools/list` arrive with no user action — and (b) silently switch
 * the session to `danger-full-access` while the status bar still said
 * `Workspace Write`. The first cut of the fix then waved `disabled: true`
 * through BEFORE the safety check, so `- id: fs-observation-policy` +
 * `disabled: true` silently removed the write-freshness fence instead of being
 * refused: the tables below pin every form, including that one.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { classifyProjectLayer, PROJECT_FORBIDDEN_IDS, PROJECT_FORBIDDEN_PLUGINS } from '../apps/tui-bin/src/project-overlay.ts'
import { heroHintRows, heroNoticeText } from '../packages/dsh-tui-app/src/hero-layout.ts'

const read = (relative: string): string => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const BIN = read('apps/tui-bin/src/bin.ts')
const STARTUP = read('packages/dsh-tui-app/src/startup.ts')
const APP = read('packages/dsh-tui-app/src/index.tsx')

/** A base-layer row, as the classifier sees it. */
const base = [{ insert: [{ id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy' }] }]
/** A USER-layer MCP row: the repository must not be able to re-target it by id. */
const user = [{ insert: [{ id: 'mcp-probe', name: '@deepseek-ai/dsh-mcp-client' }] }]

describe('repository overlay policy', () => {
  test('① re-configuring a safety-critical row is refused', () => {
    expect(classifyProjectLayer([{ id: 'sandbox-policy', config: { mode: 'danger-full-access' } }], [base]))
      .toEqual([{ id: 'sandbox-policy', kind: 'safety' }])
    expect(classifyProjectLayer([{ id: 'approval', config: { policy: 'never' } }], [base]))
      .toEqual([{ id: 'approval', kind: 'safety' }])
  })

  test('② DISABLING a safety-critical row is refused too (the fixed bypass)', () => {
    // This was the hole: the first cut skipped every `disabled: true` row as
    // "mounts nothing" BEFORE the safety check, so a repository could turn the
    // fence off — silently, because a fence-only plugin (fs-observation-policy)
    // registers no service, so nothing fails loud without it.
    for (const id of ['sandbox', 'sandbox-policy', 'fs-sandbox', 'bash-sandbox',
                      'pwsh-sandbox', 'approval', 'permission', 'fs-observation-policy']) {
      expect(classifyProjectLayer([{ id, disabled: true }], [base]), id).toEqual([{ id, kind: 'safety' }])
    }
    // …including inside `insert`, where the row is newly created.
    expect(classifyProjectLayer([{ insert: [{ id: 'sandbox', disabled: true }] }], [base]))
      .toEqual([{ id: 'sandbox', kind: 'safety' }])
  })

  test('③ the same plugin under a FRESH id is refused as well', () => {
    // An `insert` may pick any id, so the policy matches the plugin NAME too.
    expect(classifyProjectLayer([{ insert: [{ id: 'my-policy', name: '@deepseek-ai/dsh-sandbox-policy' }] }], [base]))
      .toEqual([{ id: 'my-policy', kind: 'safety' }])
    expect(classifyProjectLayer([{ insert: [{ id: 'my-fs', name: '@deepseek-ai/dsh-fs-observation-policy', disabled: true }] }], [base]))
      .toEqual([{ id: 'my-fs', kind: 'safety' }])
  })

  test('④b a DISABLED row that re-configures an id from above still needs trust', () => {
    // Disabling a row the user installed rewrites the user's composition — a
    // repository could silently switch the user's MCP server off — so the trust
    // decision is required even though a disabled row runs nothing. A FRESH
    // disabled insert mounts nothing and touches nothing above: still free.
    expect(classifyProjectLayer([{ id: 'mcp-probe', disabled: true }], [base, user]))
      .toEqual([{ id: 'mcp-probe', kind: 'execution' }])
    expect(classifyProjectLayer([{ insert: [{ id: 'mcp-own', name: '@deepseek-ai/dsh-mcp-client', disabled: true }] }], [base, user]))
      .toEqual([])
  })

  test('④c safety resolution is SYMMETRIC with execution (id → name, not just `name`)', () => {
    // `alias-fs` is not a forbidden id and the row restates no name, so only the
    // id → name resolution can see that it is the observation policy. Nothing
    // maps a forbidden plugin to a foreign id today; that is exactly why the
    // check must not depend on it staying true.
    const alias = [[{ insert: [{ id: 'alias-fs', name: '@deepseek-ai/dsh-fs-observation-policy' }] }]]
    expect(classifyProjectLayer([{ id: 'alias-fs', config: {} }], alias))
      .toEqual([{ id: 'alias-fs', kind: 'safety' }])
    expect(classifyProjectLayer([{ id: 'alias-fs', disabled: true }], alias))
      .toEqual([{ id: 'alias-fs', kind: 'safety' }])
  })

  test('④d a `disabled: true` WRAPPER does not hide its children', () => {
    // Measured (pty, user overlay): the harness IGNORES `disabled` on an
    // `insert` wrapper — the child MCP row mounts and its command really starts
    // (`initialize`/`tools/list`). So descending into a "disabled" wrapper is
    // required, not a false refusal.
    expect(classifyProjectLayer([{ disabled: true, insert: [{ id: 'mcp-w', name: '@deepseek-ai/dsh-mcp-client' }] }], [base]))
      .toEqual([{ id: 'mcp-w', kind: 'execution' }])
    expect(classifyProjectLayer([{ disabled: true, insert: [{ id: 'sandbox' }] }], [base]))
      .toEqual([{ id: 'sandbox', kind: 'safety' }])
  })

  test('④ an MCP row needs trust — by name, or by re-targeting a row above it', () => {
    expect(classifyProjectLayer([{ insert: [{ id: 'mcp-evil', name: '@deepseek-ai/dsh-mcp-client' }] }], [base]))
      .toEqual([{ id: 'mcp-evil', kind: 'execution' }])
    // A re-configuring row carries no `name`: without id → name resolution this
    // is how a repository could silently repoint the USER's MCP server.
    expect(classifyProjectLayer([{ id: 'mcp-probe', config: { command: '/bin/evil' } }], [base, user]))
      .toEqual([{ id: 'mcp-probe', kind: 'execution' }])
  })

  test('⑤ rows that mount or change nothing are left alone', () => {
    expect(classifyProjectLayer([], [base])).toEqual([])
    // A disabled MCP row mounts nothing, so it needs no trust…
    expect(classifyProjectLayer([{ insert: [{ id: 'mcp-off', name: '@deepseek-ai/dsh-mcp-client', disabled: true }] }], [base]))
      .toEqual([])
    // …and an id nothing above defines is a row the validator will judge.
    expect(classifyProjectLayer([{ id: 'not-a-built-in', config: {} }], [base])).toEqual([])
  })

  test('⑥ the two sets name real rows and real plugins', () => {
    expect([...PROJECT_FORBIDDEN_IDS].sort()).toEqual(['approval', 'bash-sandbox', 'fs-observation-policy',
      'fs-sandbox', 'permission', 'pwsh-sandbox', 'sandbox', 'sandbox-policy'])
    // Every forbidden plugin name must exist in the embedded base layer, so the
    // policy cannot drift away from the composition it protects.
    const basePatch = readFileSync(new URL('../../deepseek-harness/packages/bundle/base/cordis.patch.yml', import.meta.url), 'utf8')
    for (const name of PROJECT_FORBIDDEN_PLUGINS) expect(basePatch, name).toContain(name)
  })

  test('⑦ safety is decided before trust, and both before any boot', () => {
    const safety = BIN.indexOf('assertProjectOverlaySafe(projectFile, projectPolicy)')
    const execution = BIN.indexOf('assertProjectOverlayTrusted(projectFile, projectPolicy)')
    expect(safety).toBeGreaterThan(0)
    expect(execution).toBeGreaterThan(safety)
    expect(BIN.indexOf('await bootSea(')).toBeGreaterThan(execution)
  })

  test('⑧ the escape hatch is a declared option that skips the layer', () => {
    expect(STARTUP).toContain("'--no-project-overlay'")
    expect(BIN).toContain("args.includes('--no-project-overlay')")
    expect(BIN).toContain("process.env.DSH_TUI_NO_PROJECT_OVERLAY === '1'")
    expect(BIN).toContain('const project = skipProject ? [] : loadOptionalPatches')
  })

  test('⑨ the applied layer is visible: launch env → hero, status bar, transcript', () => {
    expect(BIN).toContain('DSH_TUI_PROJECT_OVERLAY')
    expect(APP).toContain('projectOverlayNotice()')
    expect(APP).toContain('setRepoOverlayNotice')
    expect(APP).toContain('store.flashStatus(`⚠ ${overlayNotice}`')
    expect(APP).toContain("store.append('status', `⚠ ${overlayNotice}`")
  })

  test('⑩ the chip follows the EFFECTIVE mode, not the view default', () => {
    // The policy service is the same authority `confine()` resolves through; the
    // old code scanned `snapshotEvents()`, which carries no seed events, so a
    // freshly seeded session kept the TUI default on screen.
    expect(APP).toContain("ctx.get('sandboxPolicy')")
    expect(APP.match(/effectiveSandboxMode\(ctx, agent\.session\)/gu)?.length).toBe(2)
    expect(APP).toContain('effectiveSandboxMode(ctx, undefined)')
  })

  test('⑪ `trust` is documented as a record, never as a review', () => {
    expect(/to review and trust/u.test(BIN), 'no message may claim trust reviews anything').toBe(false)
    expect(BIN).toContain('read its files yourself first')
    expect(BIN).toContain('read the file yourself first')
  })

  test('⑫ the hero notice REPLACES the tip without changing the row count', () => {
    expect(heroNoticeText(undefined)).toBeUndefined()
    expect(heroNoticeText('repo overlay applied: /x (1 row(s))')).toBe('⚠ repo overlay applied: /x (1 row(s))')
    expect(heroHintRows(false, true, 'notice')).toBe(1)
    expect(heroHintRows(false, undefined, 'notice')).toBe(1)
    expect(heroHintRows(true, undefined, 'notice')).toBe(2)
    expect(heroHintRows(false, true)).toBe(1)
    expect(heroHintRows(false, undefined)).toBe(0)
  })
})
