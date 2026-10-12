/**
 * The `!!js` scalars in qialike's own patch layer must stay QUOTED.
 *
 * YAML parses an unquoted scalar containing `: ` as a MAPPING, and the
 * include's `!!js` tag evaluates whatever node it is handed. So
 *
 *     mode: !!js process.env.DSH_TOOLS_MODE === 'ptc' ? 'ptc' : 'native'
 *
 * reaches the plugin as `{"[object Object]": "native"}` and the row fails schema
 * validation — which the harness reports only at boot, after every gate that
 * runs earlier has passed. That is what happened when the tools row gained a
 * normalization ternary for harness 0.2.1: the build, `--generate-only`, the
 * typecheck and the whole unit suite were green, and `/exit` then failed with
 * `$.mode expected "native" | "ptc" but got {"[object Object]":"native"}`.
 *
 * The harness's own base patch quotes every such expression, so this pins the
 * same rule here. The check is deliberately about the SHAPE of the scalar
 * rather than the value: any future ternary, `??` with a fallback, or object
 * literal is covered without the test needing to know what it does.
 *
 * Run with `bun test tests/patch-js-scalars.test.ts`.
 *
 * @module qialike/patch-js-scalars-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const OWN_PATCH = join(REPO, 'packages', 'qialike-app', 'cordis.patch.yml')

/** Every `!!js` scalar in a patch file, as written (trimmed, quotes included). */
function jsScalars(text: string): { line: number; raw: string }[] {
  const out: { line: number; raw: string }[] = []
  text.split('\n').forEach((line, index) => {
    const match = /!!js\s+(.*)$/.exec(line)
    if (match !== null && match[1] !== undefined) out.push({ line: index + 1, raw: match[1].trim() })
  })
  return out
}

describe("qialike's `!!js` scalars survive YAML parsing", () => {
  const text = readFileSync(OWN_PATCH, 'utf8')
  const scalars = jsScalars(text)

  test('the layer actually declares some, so this is not a vacuous pass', () => {
    expect(scalars.length).toBeGreaterThan(0)
  })

  test('a scalar carrying a YAML-hostile character is quoted', () => {
    // `: ` is the mapping separator; `#` starts a comment mid-scalar. Either one
    // changes what YAML hands the tag, and neither is visible in the evaluated
    // JavaScript, so the failure appears as a schema error far from the cause.
    const hostile = scalars.filter((s) => /:\s/.test(s.raw) || /(^|\s)#/.test(s.raw))
    for (const scalar of hostile) {
      const quoted = (scalar.raw.startsWith('"') && scalar.raw.endsWith('"'))
        || (scalar.raw.startsWith("'") && scalar.raw.endsWith("'"))
      expect(quoted, `line ${scalar.line}: quote this !!js scalar — ${scalar.raw}`).toBe(true)
    }
  })

  test('a quoted scalar is quoted with the SAME character at both ends', () => {
    for (const scalar of scalars) {
      const opensDouble = scalar.raw.startsWith('"')
      const opensSingle = scalar.raw.startsWith("'")
      if (!opensDouble && !opensSingle) continue
      const expected = opensDouble ? '"' : "'"
      expect(scalar.raw.endsWith(expected), `line ${scalar.line}: unbalanced quotes — ${scalar.raw}`).toBe(true)
    }
  })

  test('the tools-row normalization that motivated this stays quoted', () => {
    const tools = scalars.find((s) => s.raw.includes('DSH_TOOLS_MODE'))
    expect(tools, 'the tools row must keep normalizing DSH_TOOLS_MODE').toBeDefined()
    expect(tools!.raw.startsWith('"')).toBe(true)
    // `both` must not survive into the plugin: harness 0.2.1 removed it.
    expect(tools!.raw).not.toContain('both')
  })
})
