/**
 * Regression test: exiting dsh-tui must leave NO visible residue on the normal
 * screen buffer.
 *
 * The TUI runs inside the alternate screen buffer (`\x1b[?1049h`); on exit the
 * leave sequence (`\x1b[?1049l`) must be the process's LAST visible terminal
 * write. Every earlier write — the stderr-mirrored `dsh-tui exited` log line,
 * Ink's unmount frame/cursor restore, frames re-rendered while the tree
 * disposes — lands in the alternate buffer and is discarded when the buffer is
 * switched back. A stray `\x1b[?25h` cursor-show may follow the leave
 * (restore-cursor's afterexit hook re-shows the cursor unconditionally); it is
 * invisible by design and asserts as allowed.
 *
 * Runs the built single-file binary in a real pty via `script(1)` (Linux /
 * macOS; skipped on Windows where script is unavailable), types `/exit`, and
 * asserts the recorded byte stream.
 *
 * Run with `bun test tests/exit-terminal-state.test.ts` (after `pnpm run build`).
 *
 * @module dsh-tui/exit-terminal-state-test
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from 'bun:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const bin = join(ROOT, 'dist/dsh-tui')
const BOOT_MS = 6000 // let the composition mount before typing /exit
const EXIT_TIMEOUT_MS = 30_000

// The boot delay plus the pty session need well beyond bun's default 5s.
test('exiting dsh-tui writes nothing visible after the alternate-screen leave', async () => {
  if (process.platform === 'win32') return // script(1) is not available
  if (!existsSync(bin)) throw new Error(`missing ${bin}; run \`pnpm run build\` first`)

  const out = join(tmpdir(), `dsh-tui-exit-${process.pid}.typescript`)
  const scriptArgs = process.platform === 'darwin'
    ? ['-q', out, bin] // BSD script: `script [-q] [file [command ...]]`
    : ['-qec', bin, out] // util-linux: `script [-q] -e -c command [file]`
  let spawnFailed = false
  const child = spawn('script', scriptArgs, { stdio: ['pipe', 'ignore', 'ignore'] })
  child.on('error', () => { spawnFailed = true }) // script not installed: skip

  await new Promise((resolve) => setTimeout(resolve, BOOT_MS))
  if (spawnFailed) return
  child.stdin.write('/exit\r')
  child.stdin.end()

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, EXIT_TIMEOUT_MS)
    child.on('exit', () => { clearTimeout(timer); resolve() })
  })

  let text = readFileSync(out, 'utf8')
  rmSync(out, { force: true })
  // Strip script's own envelope: the "Script started/done" header/footer lines
  // are written by script(1), not by dsh-tui.
  const footer = text.lastIndexOf('Script done')
  if (footer !== -1) text = text.slice(0, footer)

  const lastLeave = text.lastIndexOf('\x1b[?1049l')
  expect(lastLeave, 'the TUI must leave the alternate screen on exit').toBeGreaterThan(-1)
  const after = text.slice(lastLeave + '\x1b[?1049l'.length)
  expect(after, 'nothing visible may follow the leave sequence').toMatch(/^(?:\x1b\[\?25h|\s)*$/)

  const exitedAt = text.indexOf('dsh-tui exited (code 0)')
  expect(exitedAt, 'the exit log line must be written').toBeGreaterThan(-1)
  expect(exitedAt, 'the exit log line must precede the leave (it is discarded with the alt buffer)').toBeLessThan(lastLeave)
}, 60_000)
