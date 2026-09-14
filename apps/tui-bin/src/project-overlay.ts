/**
 * The REPOSITORY overlay's policy.
 *
 * `<repoRoot>/.dsh/tui.cordis.patch.yml` is the one layer a repository controls
 * and it is applied automatically at boot, so it gets rules of its own:
 *
 *  - **safety-critical rows are never repo-owned** (and `disabled: true` counts
 *    as touching them: removing the fence IS the change we refuse). It is
 *    checked FIRST, and before the disabled skip, because "mounts nothing" is
 *    exactly what a fence-removing row does.
 *  - **rows that spawn a process need an explicit per-repository decision**: an
 *    MCP row starts its `command` at boot, so it is honoured only when the file's
 *    bytes are recorded in the overlay trust ledger.
 *
 * Classification is by row id AND by plugin name, over the project layer alone
 * but resolved against the layers it rides on: a repository must not be able to
 * reach the same plugin through a fresh id (`insert` a second sandbox under a new
 * id) or by re-targeting someone else's row (`- id: mcp-probe` re-configures the
 * server the USER installed, with no `name` of its own).
 *
 * Pure and dependency-free so the policy is unit-testable as behaviour rather
 * than through source guards.
 */

/** Plugin names whose rows are execution-class in a project layer. */
export const PROJECT_EXECUTION_PLUGINS: ReadonlySet<string> = new Set(['@deepseek-ai/dsh-mcp-client'])

/** Row ids that may never be changed (configured or disabled) by a project layer. */
export const PROJECT_FORBIDDEN_IDS: ReadonlySet<string> = new Set([
  'sandbox', 'sandbox-policy', 'fs-sandbox', 'bash-sandbox', 'pwsh-sandbox',
  'approval', 'permission', 'fs-observation-policy',
])

/** Plugin names a project layer may never mount, whatever id it gives them. */
export const PROJECT_FORBIDDEN_PLUGINS: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-fs-observation-policy',
])

/** One project-layer row the policy refuses, and why. */
export interface ProjectRowProblem {
  /** Row id as written (or `(no id)`). */
  id: string
  /** Which rule the row breaks. */
  kind: 'execution' | 'safety'
}

/** A patch row, as much of it as the policy reads. */
interface Row {
  id?: unknown
  name?: unknown
  insert?: unknown
  disabled?: unknown
}

/** `id → name` for every named row in a set of layers. */
function rowNames(layers: readonly (readonly unknown[])[]): Map<string, string> {
  const names = new Map<string, string>()
  const walk = (entries: readonly unknown[]): void => {
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as Row
      if (typeof row.id === 'string' && typeof row.name === 'string') names.set(row.id, row.name)
      if (Array.isArray(row.insert)) walk(row.insert)
    }
  }
  for (const layer of layers) walk(layer)
  return names
}

/**
 * Classify one project layer against the policy.
 *
 * @param project - the parsed project layer.
 * @param prior - the layers it rides on (base, tui, user) — used to resolve a row
 *   id whose plugin name is not restated by the re-configuring row.
 * @returns the refused rows, in layer order.
 */
export function classifyProjectLayer(
  project: readonly unknown[],
  prior: readonly (readonly unknown[])[] = [],
): ProjectRowProblem[] {
  const problems: ProjectRowProblem[] = []
  const known = rowNames(prior)
  const walk = (entries: readonly unknown[]): void => {
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as Row
      const id = typeof row.id === 'string' ? row.id : '(no id)'
      const name = typeof row.name === 'string' ? row.name : undefined
      if (Array.isArray(row.insert)) { walk(row.insert); continue }
      // ① Safety FIRST, and before the `disabled` skip below: a disabled
      //    safety row is precisely a fence-removing change, not a no-op.
      if (PROJECT_FORBIDDEN_IDS.has(id) || (name !== undefined && PROJECT_FORBIDDEN_PLUGINS.has(name))) {
        problems.push({ id, kind: 'safety' })
        continue
      }
      // ② A disabled row mounts nothing, so it cannot run anything.
      if (row.disabled === true) continue
      // ③ Execution: by its own name, or by the id of a row the layers above
      //    defined (a re-configuring row carries no `name`).
      const effective = name ?? known.get(id)
      if (effective !== undefined && PROJECT_EXECUTION_PLUGINS.has(effective)) problems.push({ id, kind: 'execution' })
    }
  }
  walk(project)
  return problems
}
