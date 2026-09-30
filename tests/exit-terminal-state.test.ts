/**
 * Regression test: exiting qialike must leave NO visible residue on the normal
 * screen buffer.
 *
 * The TUI runs inside the alternate screen buffer (`\x1b[?1049h`); on exit the
 * leave sequence (`\x1b[?1049l`) must be the process's LAST visible terminal
 * write. Every earlier write — the stderr-mirrored `qialike exited` log line,
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
 * @module qialike/exit-terminal-state-test
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from 'bun:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const bin = join(ROOT, 'dist/qialike')
const BOOT_MS = 6000 // let the composition mount before typing /exit
const EXIT_TIMEOUT_MS = 30_000

// The boot delay plus the pty session need well beyond bun's default 5s.
//
// Skipped, not failed, when the artifact is absent. `dist/qialike` is the
// `--single` (host-only) artifact; the ALL / `--package` and `QIALIKE_TARGETS`
// paths write `dist/<target>/qialike[.exe]`, and a tree holding one of those is
// a legitimate tree in which this case has nothing to exercise. `pnpm build
// --single` — what the release gate runs — writes it, and that is where this
// case carries its weight.
test.skipIf(!existsSync(bin))('exiting qialike writes nothing visible after the alternate-screen leave', async () => {
  if (process.platform === 'win32') return // script(1) is not available

  const out = join(tmpdir(), `qialike-exit-${process.pid}.typescript`)
  // A throwaway HOME/DSH_HOME: since 0.1.7 the launcher MATERIALIZES the profile
  // under `$DSH_HOME/profiles/tui/` on startup, so booting against the real home
  // would depend on it being writable (it is not under this workspace's file
  // sandbox, where the app dies with EROFS before painting). The scenario only
  // asserts the exit byte sequence, so which home it boots is irrelevant.
  const home = mkdtempSync(join(tmpdir(), `qialike-exit-home-${process.pid}-`))
  // Declare a NORMAL pty size inside the session: with stdin piped, script(1)
  // hands the child a 0x0 tty (measured `stty size` → "0 0"), and qialike PAUSES
  // every key below the 14-row minimum (the "terminal too small" notice keeps
  // only Ctrl+C) — so `/exit` would never arrive and this test would die on its
  // timeout. The size is irrelevant to what this test asserts (the exit byte
  // sequence); it only has to be a usable one.
  const sized = `stty rows 30 cols 100 2>/dev/null; exec ${bin}`
  const scriptArgs = process.platform === 'darwin'
    ? ['-q', out, 'sh', '-c', sized] // BSD script: `script [-q] [file [command ...]]`
    : ['-qec', sized, out] // util-linux: `script [-q] -e -c command [file]`
  let spawnFailed = false
  const child = spawn('script', scriptArgs, {
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, HOME: home, DSH_HOME: home, QIALIKE_DISABLE_AUTOUPDATE: '1' },
  })
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
  rmSync(home, { recursive: true, force: true })
  // Strip script's own envelope: the "Script started/done" header/footer lines
  // are written by script(1), not by qialike.
  const footer = text.lastIndexOf('Script done')
  if (footer !== -1) text = text.slice(0, footer)

  const lastLeave = text.lastIndexOf('\x1b[?1049l')
  expect(lastLeave, 'the TUI must leave the alternate screen on exit').toBeGreaterThan(-1)
  const after = text.slice(lastLeave + '\x1b[?1049l'.length)
  expect(after, 'nothing visible may follow the leave sequence').toMatch(/^(?:\x1b\[\?25h|\s)*$/)

  const exitedAt = text.indexOf('qialike exited (code 0)')
  expect(exitedAt, 'the exit log line must be written').toBeGreaterThan(-1)
  expect(exitedAt, 'the exit log line must precede the leave (it is discarded with the alt buffer)').toBeLessThan(lastLeave)
}, 60_000)

// The Windows-only ordering hazard — Ink's last frame is a QUEUED stdout write
// there, and the synchronous leave could overtake it and leave the frame as
// residue on the restored screen — cannot be observed on a POSIX TTY, where both
// writes are synchronous. So both halves of its mitigation are pinned at the
// source instead: the exit handler installs a synchronous frame writer before
// unmounting, and the patched Ink frame writer honours it.
test('the exit path makes Ink\'s last frame write synchronously', () => {
  const app = readFileSync(join(ROOT, 'packages/qialike-app/src/index.tsx'), 'utf8')
  const hook = app.indexOf('__dshTuiSyncFrameWriter')
  const unmount = app.indexOf('void app.unmount()')
  expect(hook, 'the exit handler must install the synchronous frame writer').toBeGreaterThan(-1)
  expect(unmount, 'unmount must still be called').toBeGreaterThan(-1)
  expect(hook, 'the writer must be installed BEFORE unmount paints the last frame').toBeLessThan(unmount)

  const build = readFileSync(join(ROOT, 'apps/tui-bin/build.mjs'), 'utf8')
  expect(build, 'the patched Ink frame writer must honour that hook').toContain('globalThis.__dshTuiSyncFrameWriter')
  // …and EVERY frame write point must share that path, not just the Ink render
  // one: the CPR calibration flush and the watchdog repaint can paint a frame too,
  // and either would still be a queued write (and thus overtakable) otherwise.
  expect(build.match(/__dshWriteFrame\(/g) ?? [], 'all three frame write points use the shared writer')
    .toHaveLength(3)
  expect(build, 'no frame write may bypass the shared writer').not.toContain('process.stdout.write(frame)')
})
