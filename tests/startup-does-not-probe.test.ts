/**
 * Startup must not enumerate models.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. The desktop surface hit exactly this: its
 * `buildModelCatalog` calls `listModels` for **every** registered route, each of which
 * probes a gateway over the network. Measured there before the fix: 4,041 ms — the
 * full probe timeout, not the gateways — shown to the user as "loading models".
 *
 * The CLI never had that shape: `index.tsx` boots from the persisted selection (a
 * config read, no I/O) and only enumerates when the user opens `/models` or performs a
 * key/provider action. Measured on a packaged 0.11.4 binary: 493 ms to the hero with
 * zero providers, 479 ms with six unreachable ones, 484 ms with the *current* model on
 * an unreachable gateway — i.e. the boot path does not touch the network at all.
 *
 * That property is invisible in the code (it holds because nobody added a call), so a
 * future "warm the catalog at startup" idea would silently reintroduce the desktop's
 * symptom. These cases fail if that happens.
 *
 * Run with `bun test tests/startup-does-not-probe.test.ts`.
 *
 * @module qialike/startup-does-not-probe-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP = join(import.meta.dir, '..', 'packages', 'qialike-app', 'src')
const read = (file: string): string => readFileSync(join(APP, file), 'utf8')

/** `index.tsx` with comments stripped, so prose about probing does not count. */
function code(file: string): string {
  return read(file)
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

describe('startup does not enumerate models', () => {
  test('the boot module never enumerates a provider catalogue', () => {
    const src = code('index.tsx')
    // `listModels` per route is what made the desktop wait 4 s; `buildModelCatalog`
    // is the harness helper that calls it in a loop. Neither may appear at all.
    expect(src).not.toContain('listModels')
    expect(src).not.toContain('buildModelCatalog')
    // `resolveModel` is the limits probe — same network cost, same prohibition at boot.
    expect(src).not.toMatch(/\bresolveModel\s*\(/)
  })

  test('the current model comes from the persisted selection, not a probe', () => {
    const src = code('index.tsx')
    expect(src).toContain('defaultModel.currentSelection()')
    // …and the resolved selection is built from that value alone.
    expect(src).toContain('resolveModelOverride(')
  })

  test('every listConfigured call sits behind a repair branch or a user action', () => {
    const lines = code('index.tsx').split('\n')
    const calls = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes('listConfigured()'))
    expect(calls.length, 'the call sites are pinned so a new one is a decision').toBe(4)

    for (const { index } of calls) {
      // Look back for the guard that makes this call conditional: either the
      // hidden-provider repair branch, or the store handler the user triggered.
      const window = lines.slice(Math.max(0, index - 25), index).join('\n')
      const guarded = /isProviderHidden\(|keyDialogSubmit|providerFormSubmit|const refresh =/.test(window)
      expect(guarded, `listConfigured at line ${index + 1} must not run unconditionally`).toBe(true)
    }
  })

  test('the hero screen does not wait on the models service', () => {
    // The hero renders before any session exists, so a catalog call wired into that
    // path would show up as a delayed first paint. The boot sequence reads
    // `agentDefaultModel` / `sessions` only.
    const src = code('index.tsx')
    // The window ends at the launch sequence, NOT at a variable named `selected`:
    // harness 0.2.1-rc.3 removed the caller-owned `ModelSelectionRef`, so that
    // marker no longer exists and the slice used to swallow the whole file.
    const boot = src.slice(src.indexOf('const defaultModel = ctx.get'), src.indexOf('let liveAgent'))
    expect(boot.length).toBeGreaterThan(0)
    expect(boot).not.toContain('listConfigured')
    expect(boot).not.toContain('listModels')
  })
})

describe('the probe budgets are bounded', () => {
  test('neither budget can regress to the old 4 s', () => {
    const src = read('llm.ts')
    const value = (name: string): number => {
      const match = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(src)
      expect(match, `${name} must stay a numeric constant`).not.toBeNull()
      return Number(match![1]!.replace(/_/g, ''))
    }
    // 1.5 s: covers the slowest measured gateway (1.03 s) with headroom.
    expect(value('DYNAMIC_MODELS_TIMEOUT')).toBe(1_500)
    // 800 ms: the request path only refines limits, so it pays less than the dialog.
    expect(value('MODEL_LIMITS_TIMEOUT')).toBe(800)
  })
})
