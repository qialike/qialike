/**
 * The repository overlay's policy, pinned as source guards plus the pure hero
 * helpers it drives.
 *
 * `<repoRoot>/.dsh/tui.cordis.patch.yml` is the one layer a repository controls
 * and it is applied automatically at boot. Before this policy existed a cloned
 * repository could (a) run a process through an MCP row — measured: the server's
 * `initialize`/`tools/list` arrive with no user action — and (b) silently switch
 * the session to `danger-full-access` while the status bar still said
 * `Workspace Write`. The guards below pin the two rules that close that, the
 * escape hatch, the visibility, and the chip fix; the real-machine behaviour is
 * pinned by the `project-overlay` pty scenario.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { heroHintRows, heroNoticeText } from '../packages/dsh-tui-app/src/hero-layout.ts'

const read = (relative: string): string => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const BIN = read('apps/tui-bin/src/bin.ts')
const STARTUP = read('packages/dsh-tui-app/src/startup.ts')
const APP = read('packages/dsh-tui-app/src/index.tsx')

describe('repository overlay policy', () => {
  test('① an MCP row is an EXECUTION row and needs a per-repository trust record', () => {
    expect(BIN).toContain("new Set(['@deepseek-ai/dsh-mcp-client'])")
    expect(BIN).toContain('overlays.trust.json')
    expect(BIN).toContain('function assertProjectOverlayTrusted(')
    // The three refusal modes mirror the T1 plugin ledger: untrusted, wrong
    // harness, changed contents.
    expect(BIN).toContain('trust-overlay')
    expect(BIN).toContain('hash mismatch')
  })

  test('② safety-critical rows are refused, and trust never buys them', () => {
    for (const id of ['sandbox', 'sandbox-policy', 'fs-sandbox', 'bash-sandbox', 'pwsh-sandbox',
                      'approval', 'permission', 'fs-observation-policy']) {
      expect(BIN, `${id} must be in the refused set`).toContain(`'${id}'`)
    }
    const safety = BIN.indexOf('assertProjectOverlaySafe(projectFile, projectPolicy)')
    const execution = BIN.indexOf('assertProjectOverlayTrusted(projectFile, projectPolicy)')
    expect(safety).toBeGreaterThan(0)
    // Safety is checked FIRST: a trusted file cannot pay for those rows.
    expect(execution).toBeGreaterThan(safety)
  })

  test('③ the policy runs before anything boots', () => {
    const policyAt = BIN.indexOf('assertProjectOverlayTrusted(projectFile, projectPolicy)')
    expect(policyAt).toBeGreaterThan(0)
    expect(BIN.indexOf('await bootSea(')).toBeGreaterThan(policyAt)
  })

  test('④ the escape hatch is a declared option that skips the layer', () => {
    expect(STARTUP).toContain("'--no-project-overlay'")
    expect(BIN).toContain("args.includes('--no-project-overlay')")
    expect(BIN).toContain("process.env.DSH_TUI_NO_PROJECT_OVERLAY === '1'")
    expect(BIN).toContain('const project = skipProject ? [] : loadOptionalPatches')
  })

  test('⑤ the applied layer is visible: launch env → hero, status bar, transcript', () => {
    expect(BIN).toContain('DSH_TUI_PROJECT_OVERLAY')
    expect(APP).toContain('projectOverlayNotice()')
    expect(APP).toContain('setRepoOverlayNotice')
    expect(APP).toContain('store.flashStatus(`⚠ ${overlayNotice}`')
    expect(APP).toContain("store.append('status', `⚠ ${overlayNotice}`")
  })

  test('⑥ the chip follows the EFFECTIVE mode, not the view default', () => {
    // The policy service is the same authority `confine()` resolves through; the
    // old code scanned `snapshotEvents()`, which carries no seed events, so a
    // freshly seeded session kept the TUI default on screen.
    expect(APP).toContain("ctx.get('sandboxPolicy')")
    expect(APP.match(/effectiveSandboxMode\(ctx, agent\.session\)/gu)?.length).toBe(2)
    expect(APP).toContain('effectiveSandboxMode(ctx, undefined)')
  })

  test('⑦ `trust` is documented as a record, never as a review', () => {
    // Boolean form on purpose: `not.toContain` would print the whole 60 KB file
    // in the failure message.
    expect(/to review and trust/u.test(BIN), 'no message may claim trust reviews anything').toBe(false)
    expect(BIN).toContain('read its files yourself first')
    expect(BIN).toContain('read the file yourself first')
  })

  test('⑧ the hero notice REPLACES the tip without changing the row count', () => {
    expect(heroNoticeText(undefined)).toBeUndefined()
    expect(heroNoticeText('repo overlay applied: /x (1 row(s))')).toBe('⚠ repo overlay applied: /x (1 row(s))')
    // One row either way: notice or tip, never both, never neither.
    expect(heroHintRows(false, true, 'notice')).toBe(1)
    expect(heroHintRows(false, undefined, 'notice')).toBe(1)
    expect(heroHintRows(true, undefined, 'notice')).toBe(2)
    expect(heroHintRows(false, true)).toBe(1)
    expect(heroHintRows(false, undefined)).toBe(0)
  })
})
