#!/usr/bin/env node
/**
 * dsh-tui — thin process entry (the compiled single-file binary's first
 * module). It resolves the cheap, self-contained invocations before the
 * ~111-module plugin graph (`generated/plugins.ts` → every embedded harness +
 * TUI plugin) loads, so `--version` and a lone `--help` return in tens of
 * milliseconds instead of a full Loader boot. Every other invocation falls
 * through to a deferred `import()` of {@link ./bin.ts}; Bun keeps that static
 * graph out of startup behind the dynamic import, and bin.ts re-checks its own
 * launcher flags (`uninstall`, `web`, version) before booting, so nothing is
 * lost in the handoff.
 *
 * Fast-path output must stay byte-identical to the full boot's:
 *  - `--version` / `-V` / `-v` → `${NAME} ${version}\n`, the same condition
 *    and bytes bin.ts writes (version wins over every other argument).
 *  - a lone `--help` / `-h` → the alternate-screen enter (`\x1b[?1049h`) the
 *    full boot writes before commander parses, then the same commander help
 *    text from the shared {@link tuiCommand} (startup.ts) — which keeps the
 *    wrap width and addHelpText byte-identical — then exit 0. The full boot
 *    renders help only after the app mounts, which disarms its pre-mount
 *    leave backstop, so its help output carries no leave either; this path
 *    registers no exit-time writer at all. Mixed argument sets fall through to
 *    the full boot: commander rejects unknown options before showing help, and
 *    only the real startup plugin can reproduce that ordering.
 *
 * @module @yourname/dsh-tui/main
 */

import pkg from '../../../package.json' with { type: 'json' }
import { tuiCommand } from '@yourname/dsh-tui-app/src/startup.ts'

const NAME = 'dsh-tui'

/** Whether a thrown value is commander's own control-flow error (help shown,
 *  parse rejected) — detected structurally, as dsh-cmdline does, because the
 *  bundled commander copy's class identity is not guaranteed. */
function isCommanderExit(error: unknown): error is { code: string; exitCode: number } {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; exitCode?: unknown }
  return typeof candidate.code === 'string'
    && candidate.code.startsWith('commander.')
    && typeof candidate.exitCode === 'number'
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // `--version` is launcher-owned, resolved before the app owns the command
  // line: same condition and bytes as bin.ts's own check, so `dsh-tui --model
  // x --version` prints the version here exactly as the full boot would.
  if (args.includes('--version') || args.includes('-V') || args.includes('-v')) {
    process.stdout.write(`${NAME} ${(pkg as { version?: string }).version ?? '0.0.0'}\n`)
    process.exit(0)
  }

  // A lone `--help` / `-h` needs only the command definition, not the tree.
  // Render through the same commander program the startup plugin parses with,
  // so the wrapped width and help text cannot drift from the full boot.
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    const program = tuiCommand()
    program.exitOverride().configureOutput({
      writeOut: (text: string) => void process.stdout.write(text),
      writeErr: (text: string) => void process.stderr.write(text),
    })
    // Byte parity with the full boot: it enters the alternate screen buffer
    // before commander renders the help, and its help exit path leaves the
    // buffer mounted (the app-mounted flag disarms the leave backstop). Mirror
    // that exactly — enter, render, exit — and register no exit-time writer.
    process.stdout.write('\x1b[?1049h')
    try {
      program.parse(args, { from: 'user' })
    } catch (error) {
      if (isCommanderExit(error)) process.exit(error.exitCode)
      throw error
    }
    process.exit(0) // defensive: a lone --help always exits through the throw
  }

  // Full boot: the interactive TUI, `uninstall`, `web`, or any mixed argument
  // set. Deferred so the fast paths above never load the plugin graph.
  await import('./bin.ts')
}

void main().catch((error: unknown) => {
  process.stderr.write(`${NAME}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
