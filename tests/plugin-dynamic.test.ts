/**
 * Source guards for the T1 channel: LOCAL (non-bundled) plugins loaded in-process.
 *
 * The README invites third-party plugins through `ctx.get('tui')`, while a
 * single-file build can only run plugins compiled into it — so `SeaInclude`
 * gained a third rung: a plugin installed at `<profile>/node_modules/<name>`,
 * loaded IN THIS PROCESS, and only when the trust ledger vouches for it.
 *
 * The guards below pin the parts that are easy to get subtly wrong: the ladder
 * order, the three trust failure modes (each with its own fix), the containment
 * check, and — the regression that cost the most time — that `SeaInclude` must
 * NOT declare a constructor, because the harness builds it as
 * `new Include(ctx, config)` and swallowing those arguments kills the tree.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const BIN = readFileSync(new URL('../apps/tui-bin/src/bin.ts', import.meta.url), 'utf-8')
const body = (marker: string): string => BIN.slice(BIN.indexOf(marker), BIN.indexOf('\n}\n', BIN.indexOf(marker)))

describe('local (T1) plugins', () => {
  test('① the ladder keeps bundled names first, then local, then loud', () => {
    const ladder = body('class SeaInclude extends Include {')
    const order = ['PLUGIN_BUILTINS[name]', "name.startsWith('cordis:')", 'resolveLocalPlugin(name)', 'throw new Error']
    let at = -1
    for (const step of order) {
      const next = ladder.indexOf(step)
      expect(next, `${step} appears`).toBeGreaterThan(-1)
      expect(next, `${step} comes after the previous rung`).toBeGreaterThan(at)
      at = next
    }
    // The failure names BOTH places tried (bundle + local root) and the fix.
    expect(ladder, 'the loud failure offers the fix').toContain('plugin trust')
  })

  test('② SeaInclude declares NO constructor (the loader calls new Include(ctx, config))', () => {
    const header = BIN.slice(BIN.indexOf('class SeaInclude extends Include {'), BIN.indexOf('override import'))
    expect(header, 'no constructor may intercept the loader arguments').not.toContain('constructor(')
    // The ledger is module state for exactly that reason, and it is documented.
    expect(BIN, 'the ledger is module state').toContain('let activeTrustLedger: TrustLedger = {}')
    expect(BIN, 'published before boot').toContain('setTrustLedger(readTrustLedger())')
  })

  test('③ the trust gate has three distinct, actionable failures', () => {
    const gate = body('function assertPluginTrusted(')
    expect(gate, 'never trusted').toContain('it is not trusted yet')
    expect(gate, 'trusted for another harness').toContain('record.harness !== HARNESS_VERSION')
    expect(gate, 'changed since trusted').toContain('record.hash !== actual')
    expect(gate, 'every message offers the command').toContain('plugin trust')
    // The ledger hash covers the plugin directory, not just one entry file.
    expect(BIN, 'directory hash').toContain('function hashPluginDir(')
    expect(body('function hashPluginDir('), 'dependencies are not part of the vouched hash').toContain("!== 'node_modules'")
  })

  test('④ a plugin cannot escape the plugin root — realpath, not string prefix', () => {
    const target = body('function localPluginTarget(')
    expect(target, 'resolves through the profile anchor').toContain("createRequire(join(profileDir(), 'package.json')).resolve(target)")
    expect(target, 'realpaths both sides').toContain('realpathSync(entry)')
    expect(target, 'and requires containment').toContain("real.startsWith(realRoot + sep)")
  })

  test('⑤ one root for loader, validator and CLI', () => {
    expect(BIN, 'the root is the profile node_modules').toContain("join(profileDir(), 'node_modules')")
    // No bespoke plugins/ directory may come back: the patch parser resolves
    // `./name` against the PROFILE dir, so a second root silently disagrees.
    expect(BIN, 'no second plugin root').not.toContain("'plugins'")
    expect(BIN, 'the validator asks the same resolver').toContain('localPluginTarget(row.name) === undefined')
  })

  test('⑥ the ledger is written owner-only and atomically', () => {
    const write = body('function writeTrustLedger(')
    expect(write, 'owner-only file').toContain('0o600')
    expect(write, 'atomic install').toContain('renameSync(temp, file)')
    expect(body('function hardenProfileDir('), 'and the profile dir is 0700').toContain('0o700')
  })
})
