/**
 * Self-test plugin (`tui-selftest`) — `/selftest` runs a battery of READ-ONLY
 * checks against the running dsh-tui and prints a ✓/✗ report into the
 * transcript. Two tiers:
 *
 *  - **in-process checks** (always, works inside the SEA single-file binary):
 *    colorscheme registry integrity (12 built-ins, 17 keys, hex format),
 *    vim-like unique-prefix resolution, picker filter/clamp helpers, the
 *    raw-mode stdin decoder, the core provider-template catalog, and the
 *    panel/command registries as seen by the running tree. Nothing is
 *    mutated: no settings, credentials, or theme writes.
 *  - **external suite** (only when a dsh-tui checkout with `tests/` and a
 *    `bun` on PATH are detected — i.e. a dev machine, not the SEA): spawns
 *    `bun test tests/` and echoes a short tail of its summary. Disable with
 *    `DSH_TUI_SELFTEST_NO_EXTERNAL=1` or `/selftest sync`.
 *
 * @module @yourname/dsh-tui-app/selftest
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { StdinDecoder, type RawKey } from './stdin.ts'
import { BUILTIN_SCHEMES, resolveScheme, schemeRegistry } from './theme-plugin.ts'
import { clampIndex, filterSchemes } from './theme-picker.tsx'
import providerTemplatesData from './provider-templates.json' with { type: 'json' }

/** Stable Cordis plugin name. */
export const name = 'tui-selftest'

/** Services required: tui (panel/command registries), tuiStore (report output). */
export const inject = ['tui', 'tuiStore']

/** One check result. */
export interface CheckResult {
  name: string
  ok: boolean
  detail?: string
}

/** Services the in-process checks read (loose shape so tests can fake them). */
export interface SyncCheckDeps {
  commands?: { list(): readonly { name: string }[] }
  panels?: { byId(id: string): unknown }
}

const REQUIRED_PANELS = ['conversation', 'approval', 'question', 'connect', 'sessions', 'export', 'help', 'themes'] as const
const REQUIRED_COMMANDS = ['help', 'think', 'compact', 'clear', 'exit', 'models', 'sessions', 'export', 'new', 'goal', 'plan', 'theme'] as const

/** Palette hex keys shared by every built-in scheme (must stay 17). */
const HEX_ROLES = ['bg', 'panel', 'element', 'borderSubtle', 'border', 'borderActive', 'text', 'textMuted', 'primary', 'secondary', 'accent', 'success', 'warning', 'info', 'error', 'yellow'] as const

/** Run the in-process (read-only) check battery. */
export function syncChecks(deps: SyncCheckDeps): CheckResult[] {
  const out: CheckResult[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    out.push({ name, ok, detail })
  }

  // 1) colorscheme registry: 12 built-ins present.
  const schemes = schemeRegistry()
  const required = ['dark', 'light', 'catppuccin', 'dracula', 'everforest', 'gruvbox', 'jellybeans', 'kanagawa', 'monokai', 'nord', 'rosepine', 'solarized']
  const missingSchemes = required.filter((n) => !(n in schemes))
  check('colorscheme registry', missingSchemes.length === 0, missingSchemes.length === 0 ? `${required.length} built-ins` : `missing: ${missingSchemes.join(', ')}`)

  // 2) every built-in palette: 17 keys, all hex.
  const builtinEntries = Object.entries(BUILTIN_SCHEMES)
  const malformed: string[] = []
  for (const [schemeName, palette] of builtinEntries) {
    const keys = Object.keys(palette as object).sort()
    if (keys.length !== HEX_ROLES.length) { malformed.push(`${schemeName}:keys=${keys.length}`); continue }
    for (const role of HEX_ROLES) {
      const v = (palette as unknown as Record<string, string>)[role]
      if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) { malformed.push(`${schemeName}.${role}=${String(v)}`); break }
    }
  }
  check('palette shape (17 keys · #rrggbb)', malformed.length === 0, malformed.length === 0 ? `${builtinEntries.length} schemes` : malformed.slice(0, 3).join(', '))

  // 3) vim-like unique-prefix resolution over the registry.
  const prefixProbe = (name: string): string | undefined => resolveScheme(name.slice(0, Math.min(3, name.length)).toLowerCase())
  const probe = required.find((n) => n !== 'light' && n !== 'dark') ?? 'catppuccin'
  const resolved = prefixProbe(probe)
  check('resolveScheme unique prefix', resolved === probe, `resolveScheme('${probe.slice(0, 3)}') = ${String(resolved)}`)

  // 4) picker helpers.
  const filt = JSON.stringify(filterSchemes(['dark', 'light', 'user-x'], 'li'))
  const cl1 = clampIndex(-1, 3)
  const cl2 = clampIndex(3, 3)
  check('theme-picker helpers', filt === '["light"]' && cl1 === 2 && cl2 === 0, `filter=${filt}, clamp(-1,3)=${cl1}, clamp(3,3)=${cl2}`)

  // 5) raw-mode stdin decoder (arrow key, Enter, lone-ESC handling).
  const dec = new StdinDecoder()
  const arrowKeys = dec.push(Buffer.from([0x1b, 0x5b, 0x41]))
  const arrowOk = arrowKeys.length === 1 && (arrowKeys[0] as RawKey | undefined)?.upArrow === true
  const dec2 = new StdinDecoder()
  const enterKeys = dec2.push(Buffer.from('\r'))
  const enterOk = enterKeys.length === 1 && (enterKeys[0] as RawKey | undefined)?.return === true
  const dec3 = new StdinDecoder()
  const lone = dec3.push(Buffer.from([0x1b]))
  const escArmed = dec3.pendingEscape === true && lone.length === 0
  const flushed = dec3.flushEsc()
  const escOk = flushed.length === 1 && (flushed[0] as RawKey | undefined)?.escape === true
  check('stdin decoder', arrowOk && enterOk && escArmed && escOk,
    `arrow=${arrowOk}, enter=${enterOk}, esc-arm=${escArmed}, esc-flush=${escOk}`)

  // 6) core provider-template catalog (the main data file).
  const rows = providerTemplatesData as unknown as { route?: unknown; name?: unknown; models?: unknown }[]
  const uniqueRoutes = new Set(rows.map((r) => r.route))
  const badRows = rows.filter((r) =>
    typeof r.route !== 'string' || r.route === '' || typeof r.name !== 'string' || r.name === '' || !Array.isArray(r.models))
  check('provider templates', rows.length >= 40 && uniqueRoutes.size === rows.length && badRows.length === 0,
    `${rows.length} rows · ${uniqueRoutes.size} unique routes` + (badRows.length > 0 ? ` · ${badRows.length} malformed` : ''))

  // 7) panel registry (only when the service is reachable).
  if (deps.panels === undefined) {
    check('panel registry', false, 'tui.panels service unavailable')
  } else {
    const missingPanels = REQUIRED_PANELS.filter((id) => deps.panels?.byId(id) === undefined)
    check('panel registry', missingPanels.length === 0, missingPanels.length === 0 ? `${REQUIRED_PANELS.length} panels` : `missing: ${missingPanels.join(', ')}`)
  }

  // 8) command registry.
  if (deps.commands === undefined) {
    check('command registry', false, 'tui.commands service unavailable')
  } else {
    const names = deps.commands.list().map((c) => c.name)
    const missingCommands = REQUIRED_COMMANDS.filter((n) => !names.includes(n))
    const hasSelftest = names.includes('selftest')
    check('command registry', missingCommands.length === 0 && hasSelftest,
      `${names.length} commands` + (missingCommands.length > 0 ? ` · missing: ${missingCommands.join(', ')}` : '') + (hasSelftest ? '' : ' · selftest missing'))
  }

  return out
}

/** Render the sync report (one line per check + summary). */
export function formatReport(checks: CheckResult[]): string {
  const passed = checks.filter((c) => c.ok).length
  const lines = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ` — ${c.detail ?? 'failed'}`}`)
  return `dsh-tui self-test: ${passed}/${checks.length} passed\n${lines.join('\n')}`
}

/** Locate a dsh-tui checkout (root package.json + tests/) near the process. */
export function findRepo(): string | undefined {
  const candidates = [
    process.env.DSH_TUI_SELFTEST_REPO,
    process.cwd(),
    dirname(process.execPath),
    dirname(dirname(process.execPath)),
  ].filter((c): c is string => typeof c === 'string' && c !== '')
  for (const c of candidates) {
    try {
      const pkg = join(c, 'package.json')
      if (!existsSync(pkg) || !existsSync(join(c, 'tests'))) continue
      const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }
      if (parsed.name === '@yourname/dsh-tui-root') return c
    } catch { /* keep probing */ }
  }
  return undefined
}

/** Whether a `bun` executable is reachable on PATH. */
export function hasBun(): boolean {
  try {
    return spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/**
 * Run the external `bun test tests/` suite in a detected checkout.
 * @param cwd - repo root found by {@link findRepo}.
 * @param append - transcript writer (lines delivered as they settle).
 * @returns whether the spawn was started.
 */
export function runExternalTests(cwd: string, append: (line: string) => void): boolean {
  let tail = ''
  const child = spawn('bun', ['test', 'tests/'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d: Buffer) => { tail = (tail + d.toString()).slice(-32_000) })
  child.stderr.on('data', (d: Buffer) => { tail = (tail + d.toString()).slice(-32_000) })
  const timer = setTimeout(() => { try { child.kill() } catch { /* best-effort */ } }, 120_000)
  child.on('error', (error: Error) => { clearTimeout(timer); append(`selftest: failed to start bun test — ${error.message}`) })
  child.on('close', (code: number | null) => {
    clearTimeout(timer)
    const relevant = tail.split('\n').filter((l) => l.trim() !== '').slice(-8)
    append(`selftest: bun test exit ${code ?? 'null'}`)
    for (const line of relevant) append(`  ${line.trimEnd()}`)
  })
  return true
}

/** Register `/selftest`. */
export function apply(ctx: Context): void {
  const tui = ctx.get('tui') as { commands: { register(c: { name: string; hint: string; run: (arg: string) => void }): void } } | undefined
  const store = ctx.get('tuiStore') as { append: (kind: string, text: string, dim?: boolean) => void } | undefined
  if (tui === undefined) return
  const appendLine = (text: string): void => { try { store?.append('status', text, false) } catch { /* best-effort */ } }

  tui.commands.register({
    name: 'selftest',
    hint: 'run built-in self checks',
    run: (arg) => {
      const text = (arg ?? '').trim().toLowerCase()
      const checks = syncChecks({
        commands: (ctx.get('tui') as { commands?: { list(): readonly { name: string }[] } } | undefined)?.commands,
        panels: (ctx.get('tui') as { panels?: { byId(id: string): unknown } } | undefined)?.panels,
      })
      const report = formatReport(checks)
      const passed = checks.filter((c) => c.ok).length
      appendLine(report)

      const externalForced = text === 'external' || text === 'all'
      const externalBlocked = text === 'sync' || process.env.DSH_TUI_SELFTEST_NO_EXTERNAL === '1'
      if (!externalBlocked || externalForced) {
        if (externalForced && externalBlocked) { /* explicit request wins over env */ }
        const repo = findRepo()
        if (repo === undefined || !hasBun()) {
          appendLine(`selftest: external suite skipped (no dsh-tui checkout or bun on PATH — SEA build runs the in-process checks only)`)
          return
        }
        if (passed === checks.length) appendLine(`selftest: in-process checks passed — running \`bun test tests/\` in ${repo}`)
        else appendLine(`selftest: in-process checks failed — skipping external suite`)
        runExternalTests(repo, appendLine)
      }
    },
  })
}
